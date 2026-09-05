#!/usr/bin/env node
// .als（Live セット）の読み書き。
//
// .als は gzip された XML。.amxd のような独自コンテナではない。
//
// XML は DOM に載せて書き戻さない。Live のスキーマは公開されておらず、
// 属性順・空白・自己終了タグの書き方まで含めて何が意味を持つか分からないため、
// 触る箇所だけをテキストとして差し替え、それ以外は 1 バイトも変えない方針を取る。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

function readAls(file) {
  return zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
}

function writeAls(file, xml) {
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(xml, "utf8"), { level: 9 }));
}

// gzip のバイト列は Live のものと一致しなくてよい（展開後が同じなら Live は読める）。
// 保証すべきなのは「展開 → 圧縮 → 展開」で XML が変わらないことの方。
function verifyRoundTrip(file) {
  const xml = readAls(file);
  const again = zlib.gunzipSync(zlib.gzipSync(Buffer.from(xml, "utf8"), { level: 9 })).toString("utf8");
  return { ok: again === xml, bytes: xml.length };
}

function creatorOf(xml) {
  const m = /<Ableton\b[^>]*\bCreator="([^"]*)"/.exec(xml);
  return m ? m[1] : null;
}

// <Tracks> 直下のトラックを、XML 上の位置つきで拾う。
// ネストした同名タグに引っかからないよう、インデントの深さで直下だけを見る。
const TRACK_TAGS = ["AudioTrack", "MidiTrack", "GroupTrack", "ReturnTrack"];

function listTracks(xml) {
  const open = xml.indexOf("<Tracks>");
  if (open < 0) throw new Error("<Tracks> が見つかりません");
  const close = xml.indexOf("\n\t\t</Tracks>", open);
  if (close < 0) throw new Error("</Tracks> が見つかりません");

  const region = xml.slice(open, close);
  const re = new RegExp(`\\n\\t\\t\\t<(${TRACK_TAGS.join("|")}) Id="(\\d+)"[^>]*>`, "g");

  const tracks = [];
  let m;
  while ((m = re.exec(region)) !== null) {
    const start = open + m.index + 1; // 直前の改行を含めない
    const endTag = `\n\t\t\t</${m[1]}>`;
    const endAt = xml.indexOf(endTag, start);
    if (endAt < 0) throw new Error(`</${m[1]}> が見つかりません (Id=${m[2]})`);
    const end = endAt + endTag.length;
    const block = xml.slice(start, end);
    tracks.push({
      tag: m[1],
      id: Number(m[2]),
      // 属性値はエスケープされている（& は &amp;）。名前として扱うので戻す
      name: (/<EffectiveName Value="([^"]*)"/.exec(block) || [, ""])[1]
        .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
      groupId: Number((/<TrackGroupId Value="(-?\d+)"/.exec(block) || [, "-1"])[1]),
      start,
      end,
    });
  }
  return tracks;
}

// トラック 1 本ぶんのブロックの中だけを対象に置換する。
// 他のトラックや、たまたま同じ値を持つ別要素を巻き込まないための入り口。
function replaceInTrack(xml, track, pattern, replacement) {
  const block = xml.slice(track.start, track.end);
  const next = block.replace(pattern, replacement);
  if (next === block) throw new Error(`置換対象が見つかりません: ${pattern}`);
  return xml.slice(0, track.start) + next + xml.slice(track.end);
}

function renameTrack(xml, track, name) {
  const escaped = name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  let out = replaceInTrack(xml, track, /<EffectiveName Value="[^"]*"/, `<EffectiveName Value="${escaped}"`);
  const t = listTracks(out).find((x) => x.id === track.id);
  return replaceInTrack(out, t, /<UserName Value="[^"]*"/, `<UserName Value="${escaped}"`);
}

// ---- Group トラックの生成 ----
//
// テンプレートは Live 12.4.5 に実際に書かせた GroupTrack から起こしている
// （templates/group-track*.xml）。推測でスキーマを組み立てていない。
//
// 実物から読み取った規則:
//   - Slots の GroupTrackSlot はシーン数と同数
//   - FreezeSequencer の ClipSlot もシーン数と同数
//   - TrackSendHolder はリターントラック数と同数。1 つにつき id を 2 個消費
//   - id は NextPointeeId から文書順に連番で確保し、使い切った次を NextPointeeId に書く
//   - 子トラックの TrackGroupId に GroupTrack の Id を入れる（親は子を列挙しない）
//   - 子トラックの音声出力先を Main からグループへ向け直す
//     （AudioOutputRouting の Target と UpperDisplayString）

const TEMPLATE_DIR = path.join(__dirname, "..", "templates");

// esbuild でバンドルすると __dirname が導入先になりテンプレートを読めないため、
// バンドル側から文字列を注入できるようにしてある（server/src/set-tools.js 参照）
let injectedTemplates = null;
function setTemplates(t) {
  injectedTemplates = t;
}

function loadTemplates() {
  if (injectedTemplates) return injectedTemplates;
  const read = (n) => fs.readFileSync(path.join(TEMPLATE_DIR, n), "utf8");
  return {
    group: read("group-track.xml"),
    slot: read("group-track.slot.xml"),
    clipslot: read("group-track.clipslot.xml"),
    send: read("group-track.send.xml"),
  };
}

// 「名前の前方一致 or Id」の指定をトラック Id の並びに解決する。
// CLI と MCP ツールの両方から使う。
function resolveTrackTargets(tracks, specs) {
  const ids = new Set();
  for (const spec of specs) {
    if (/^\d+$/.test(spec)) {
      ids.add(Number(spec));
      continue;
    }
    const hit = tracks.filter((t) => t.name.startsWith(spec) && t.tag !== "ReturnTrack");
    if (hit.length === 0) throw new Error(`名前が一致するトラックがありません: ${spec}`);
    for (const t of hit) ids.add(t.id);
  }
  // XML 上の並び順に揃える
  return tracks.filter((t) => ids.has(t.id)).map((t) => t.id);
}

function countScenes(xml) {
  const open = xml.indexOf("\n\t\t<Scenes>");
  if (open < 0) throw new Error("<Scenes> が見つかりません");
  const close = xml.indexOf("\n\t\t</Scenes>", open);
  return (xml.slice(open, close).match(/\n\t\t\t<Scene Id="/g) || []).length;
}

function nextPointeeId(xml) {
  const m = /<NextPointeeId Value="(\d+)" \/>/.exec(xml);
  if (!m) throw new Error("<NextPointeeId> が見つかりません");
  return Number(m[1]);
}

function repeat(unit, count, pid) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(unit.replace(/__INDEX__/g, String(i)).replace(/__PID(\d+)__/g, (_, n) => pid(Number(n) + i * 2)));
  }
  return out.join("\n");
}

// トラック内の 1 要素だけを対象に置換する。
// 入力側のルーティングなど、同じ形の兄弟要素を巻き込まないため。
function replaceInElement(block, element, pattern, replacement) {
  const open = block.indexOf(`<${element}>`);
  if (open < 0) throw new Error(`<${element}> が見つかりません`);
  const close = block.indexOf(`</${element}>`, open);
  const inner = block.slice(open, close);
  const next = inner.replace(pattern, replacement);
  return block.slice(0, open) + next + block.slice(close);
}

// グループに入れた子は、音声がグループを通るようになる。
// 既定の Main 以外へ手で振ってあるトラックは、その設定を尊重して触らない。
function routeToGroup(xml, track) {
  const block = xml.slice(track.start, track.end);
  if (!/<AudioOutputRouting>[\s\S]*?<Target Value="AudioOut\/Main" \/>/.test(block)) return xml;

  let next = replaceInElement(block, "AudioOutputRouting",
    /<Target Value="AudioOut\/Main" \/>/, '<Target Value="AudioOut/GroupTrack" />');
  next = replaceInElement(next, "AudioOutputRouting",
    /<UpperDisplayString Value="Main" \/>/, '<UpperDisplayString Value="Group" />');
  return xml.slice(0, track.start) + next + xml.slice(track.end);
}

function groupTracks(xml, { name, trackIds }) {
  const tracks = listTracks(xml);
  const targets = trackIds.map((id) => {
    const t = tracks.find((x) => x.id === id);
    if (!t) throw new Error(`トラックが見つかりません: Id=${id}`);
    return t;
  });

  // Live は連続したトラックしかグループにできない
  const positions = targets.map((t) => tracks.indexOf(t)).sort((a, b) => a - b);
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] !== positions[i - 1] + 1) {
      throw new Error("グループにできるのは並びが連続したトラックだけです");
    }
  }
  if (targets.some((t) => t.tag === "ReturnTrack")) {
    throw new Error("リターントラックはグループにできません");
  }
  if (targets.some((t) => t.groupId >= 0)) {
    throw new Error("既にグループに入っているトラックが含まれています");
  }

  const tpl = loadTemplates();
  const scenes = countScenes(xml);
  const sends = tracks.filter((t) => t.tag === "ReturnTrack").length;
  const base = nextPointeeId(xml);
  const groupId = Math.max(...tracks.map((t) => t.id)) + 1;

  // 文書順に連番。sends は 1 つにつき 2 個消費するため、その後ろがずれる
  const shift = (n) => (n <= 1 ? n : n < 6 ? n : n + (sends - 2) * 2);
  const pid = (n) => String(base + shift(n));
  const total = 22 + sends * 2;

  const escaped = name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const block = tpl.group
    .replace("__SLOTS__", repeat(tpl.slot, scenes, pid))
    .replace("__CLIPSLOTS__", repeat(tpl.clipslot, scenes, pid))
    .replace("__SENDS__", repeat(tpl.send, sends, pid))
    .replace(/__ID__/g, String(groupId))
    .replace(/__NAME__/g, escaped)
    .replace(/__PID(\d+)__/g, (_, n) => pid(Number(n)));

  if (/__[A-Z0-9]+__/.test(block)) {
    throw new Error(`置換し残した placeholder があります: ${/__[A-Z0-9]+__/.exec(block)[0]}`);
  }

  // 先頭の対象トラックの直前に差し込む
  let out = xml.slice(0, targets[0].start) + block + "\n" + xml.slice(targets[0].start);

  // 子の TrackGroupId と出力先を書き換える（挿入で位置がずれるので都度引き直す）
  for (const id of trackIds) {
    let t = listTracks(out).find((x) => x.id === id);
    out = replaceInTrack(out, t, /<TrackGroupId Value="-?\d+" \/>/, `<TrackGroupId Value="${groupId}" />`);
    t = listTracks(out).find((x) => x.id === id);
    out = routeToGroup(out, t);
  }

  out = out.replace(/<NextPointeeId Value="\d+" \/>/, `<NextPointeeId Value="${base + total}" />`);
  return { xml: out, groupId, scenes, sends, pointeeIds: total };
}

// Live 純正の Backup/ と同じ流儀で退避先を決める: <名前> [YYYY-MM-DD HHMMSS].als
function backupPath(file, now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return path.join(path.dirname(file), "Backup", `${path.basename(file, ".als")} [${stamp}].als`);
}

// 退避してから書く。置き換え系の書き出しはすべてここを通す
function writeAlsWithBackup(file, xml, now = new Date()) {
  const backup = backupPath(file, now);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(file, backup);
  writeAls(file, xml);
  return backup;
}

module.exports = { readAls, writeAls, writeAlsWithBackup, backupPath, verifyRoundTrip, creatorOf, listTracks, replaceInTrack, renameTrack, groupTracks, countScenes, nextPointeeId, setTemplates, resolveTrackTargets };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error("使い方: node scripts/als.js <セット.als>");
    process.exit(2);
  }
  const xml = readAls(file);
  const rt = verifyRoundTrip(file);
  console.log(`Creator : ${creatorOf(xml)}`);
  console.log(`展開後  : ${xml.length.toLocaleString()} bytes`);
  console.log(`往復    : ${rt.ok ? "一致" : "不一致"}`);
  console.log("トラック:");
  for (const t of listTracks(xml)) {
    const g = t.groupId >= 0 ? ` (group ${t.groupId})` : "";
    console.log(`  ${String(t.id).padStart(3)} ${t.tag.padEnd(11)} ${t.name}${g}`);
  }
}
