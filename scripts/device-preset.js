#!/usr/bin/env node
// Core Library のプリセット（.adg / .adv）から「楽器チェーン」を取り出し、
// セットのトラックの <Devices> にそのまま置ける XML にする（#22）。
//
//   node scripts/device-preset.js "<プリセット.adg>" [インデントのタブ数]
//
// プリセットには 2 つの形がある:
//   デバイス単体 … <AbletonDevicePreset><Device><OriginalSimpler> の子要素は、
//                  セット内でトラックの <Devices> に並ぶ要素とまったく同じもの
//   ラック       … <InstrumentGroupDevice> の <Branches /> は空で、中身は兄弟の
//                  <BranchPresets> 側にある。セット内のラックとは別形式なので、
//                  ここではラックの殻は捨て、中のチェーンだけを直列で取り出す
//
// ポインタ id はプリセットでは全部 0 で入っている（Live が読み込み時に振る）。
// AutomationTarget / ModulationTarget / Pointee は 1 つずつ別の id が要るので、
// 出現ごとに __PID<n>__ を振って組み立て時に連番へ置き換える（extract-templates.js と同じ流儀）。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// ポインタ空間の id を持つ要素。実物のセットで 1000 以上の連番が振られているのはこの 3 つだけ
const POINTEE_TAGS = ["AutomationTarget", "ModulationTarget", "Pointee"];

// 楽器の要素名。これより前に並ぶ MIDI エフェクトは落とす。
// Core Library のパッドには MPE Control（Max for Live）が付いているものがあり、
// 何百トラックにも入ると読み込みが重くなるだけで、今回の用途では要らない
const INSTRUMENTS = new Set([
  "OriginalSimpler", "MultiSampler", "Operator", "UltraAnalog", "InstrumentVector",
  "Drift", "Meld", "Collision", "Tension", "Electric", "InstrumentImpulse",
  "GranulatorIII", "InstrumentGroupDevice", "PluginDevice", "AuPluginDevice",
]);

function readPreset(file) {
  const buf = fs.readFileSync(file);
  // .adg / .adv は gzip。まれに非圧縮のものがある
  return buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
}

// start 位置の開始タグに対応する閉じタグまでを返す（自己閉じタグにも対応）
function elementAt(xml, start) {
  const open = /^<([A-Za-z][\w.]*)(?:\s[^>]*?)?(\/)?>/.exec(xml.slice(start));
  if (!open) throw new Error(`開始タグが読めません @${start}: ${xml.slice(start, start + 60)}`);
  if (open[2]) return xml.slice(start, start + open[0].length);
  const tag = open[1];
  const re = new RegExp(`<${tag}(?:\\s[^>]*?)?(/)?>|</${tag}>`, "g");
  re.lastIndex = start;
  let depth = 0, m;
  while ((m = re.exec(xml))) {
    if (m[0].startsWith("</")) {
      if (--depth === 0) return xml.slice(start, m.index + m[0].length);
    } else if (!m[1]) depth++;
  }
  throw new Error(`</${tag}> が見つかりません`);
}

// scope の中にある tag の要素を、入れ子を飛ばしながら順に返す
function childElements(scope, tag) {
  const out = [];
  const needle = `<${tag} `;
  let i = scope.indexOf(needle);
  // 最初の 1 つは scope 自身かもしれないので、開始タグの直後から探す
  while (i >= 0) {
    const el = elementAt(scope, i);
    out.push(el);
    i = scope.indexOf(needle, i + el.length);
  }
  return out;
}

function findElement(xml, tag) {
  const i = xml.indexOf(`<${tag}>`) >= 0 ? xml.indexOf(`<${tag}>`) : xml.indexOf(`<${tag} `);
  if (i < 0) return null;
  return elementAt(xml, i);
}

// <Device> の中の 1 個だけの子要素（= 実際のデバイス）を返す
function deviceOf(presetBlock) {
  const dev = findElement(presetBlock, "Device");
  if (!dev) throw new Error("<Device> がありません");
  const inner = dev.slice(dev.indexOf(">") + 1);
  const i = inner.search(/<[A-Za-z]/);
  if (i < 0) throw new Error("<Device> が空です");
  return elementAt(inner, i);
}

// 行頭のタブを from → to に付け替える（入れ子の深い行は差分を保ったままずれる）
function reindent(block, from, to) {
  if (from === to) return block;
  return block.replace(new RegExp(`\\n\\t{${from}}`, "g"), "\n" + "\t".repeat(to));
}

// AutomationTarget / ModulationTarget / Pointee の id を、出現ごとに別の placeholder にする
function pidify(block, start = 0) {
  let n = start;
  const out = block.replace(
    new RegExp(`<(${POINTEE_TAGS.join("|")}) Id="\\d+"`, "g"),
    (_, tag) => `<${tag} Id="__PID${n++}__"`);
  return { xml: out, count: n - start };
}

// プリセットから楽器チェーンを取り出す。indent は <Devices> の中身の深さ（タブ数）
function instrumentChain(file, { indent = 7, pidStart = 0, dropBeforeInstrument = true, instrumentOnly = false } = {}) {
  const xml = readPreset(file);
  let presets;
  const bp = xml.indexOf("<BranchPresets>");
  if (bp >= 0) {
    // ラック: 最初のチェーンだけを使う（Core Library の楽器ラックはどれも 1 チェーン）
    const branches = elementAt(xml, bp);
    const ibp = branches.indexOf("<InstrumentBranchPreset ");
    if (ibp < 0) throw new Error("InstrumentBranchPreset がありません: " + file);
    const branch = elementAt(branches, ibp);
    const dp = branch.indexOf("<DevicePresets>");
    if (dp < 0) throw new Error("DevicePresets がありません: " + file);
    presets = childElements(elementAt(branch, dp), "AbletonDevicePreset");
  } else {
    presets = childElements(xml, "AbletonDevicePreset");
    if (!presets.length) presets = [xml]; // <Device> を直接持つ単体プリセット
  }
  if (!presets.length) throw new Error("デバイスが取れません: " + file);

  let devices = presets.map((p) => deviceOf(p));
  if (dropBeforeInstrument) {
    const at = devices.findIndex((d) => INSTRUMENTS.has(/^<([A-Za-z][\w.]*)/.exec(d)[1]));
    if (at < 0) throw new Error("楽器が見つかりません: " + file);
    devices = devices.slice(at);
  }
  if (instrumentOnly) devices = devices.slice(0, 1); // 楽器 1 台だけにする（切り分け用）
  // 元のインデントは preset の階層ぶん深い。1 つ目の要素の直後の行から読み取る
  const srcIndent = (/\n(\t+)/.exec(devices[0]) || [null, "\t".repeat(indent + 1)])[1].length - 1;
  let n = pidStart;
  const parts = devices.map((d, i) => {
    const r = pidify(reindent(d, srcIndent, indent), n);
    n += r.count;
    // 同じ親（<Devices>）の下で Id が重なっていると Live が
    // 「Non-unique list ids」で開かない。プリセットはどれも Id="0" なので振り直す
    return "\t".repeat(indent) + r.xml.replace(/^<([A-Za-z][\w.]*) Id="\d+"/, `<$1 Id="${i}"`);
  });
  return {
    xml: parts.join("\n"),
    pointees: n - pidStart,
    names: devices.map((d) => /^<([A-Za-z][\w.]*)/.exec(d)[1]),
  };
}

module.exports = { INSTRUMENTS, instrumentChain, readPreset, elementAt, childElements, deviceOf, reindent, pidify };

if (require.main === module) {
  const [file, ind] = process.argv.slice(2);
  if (!file) { console.error('使い方: node scripts/device-preset.js "<プリセット.adg>" [タブ数]'); process.exit(1); }
  const r = instrumentChain(path.resolve(file), { indent: ind ? Number(ind) : 7 });
  console.error(`${path.basename(file)}: ${r.names.join(" → ")}  / ポインタ id ${r.pointees} 個 / ${r.xml.length.toLocaleString()} bytes`);
  process.stdout.write(r.xml);
}
