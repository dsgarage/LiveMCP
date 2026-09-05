#!/usr/bin/env node
// Loopcloud ライブラリの全パックを調べ、生成の入力になる分類表を作る。
//
//   node scripts/loopcloud-survey.js [--library <dir>] [--out <json>] [--md <md>]
//
// 各パックのフォルダを「ループ / ワンショット / 対象外 / 不明」に分類し、
// パック名からジャンル案を付ける。判断が要るもの（不明フォルダ・ジャンル未定）は
// 一覧に出して人が直す。JSON が正で、md はレビュー用の写し。
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const AUDIO = /\.(wav|aif|aiff)$/i;
const DEFAULT_LIBRARY = path.join(os.homedir(), "Library/Loopcloud/library");

// フォルダ名の分類。ベンダー接頭辞（SMD_ / BDT_ のような大文字コード + "_"）だけを外してから見る。
// スペース区切りの先頭語（"Wav Files" の Wav）は接頭辞ではないので削らない。
// 順序が大事: 対象外 → ループ → ワンショット
const SKIP = /REX|SAMPLER|PATCH|MIDI|PRESET|PROMO|DISCOUNT|MASSIVE|SERUM|KONTAKT|NKI|EXS|SFZ|DOCUMENT|README|LICEN|ARTWORK|IMAGE|WAVETABLE|NOISE OSC|INFO\b|TOOLS|^_DATA$/i;
// 「明示」: フォルダ名そのものが種別を言っている（Loops / One Shots / Sounds & FX …）。
// 親子で食い違ったとき、明示は楽器名などの「弱い」手がかりに勝つ
// Kit は入れない: "DRUM_KITS/BILL_BOARD_KIT" や "CONSTRUCTION_KITS_HITS/ANA_KIT" のように親がヒット集なら単発なので、
// 親の明示に負ける「弱い」ループ扱いにしておく（LOOP 側にある）
const EXPLICIT_LOOP = /LOOPS?\b|LPS\b|_LPS|CONSTRUCTION|SONGS?\b|STEMS?\b/i;
const EXPLICIT_ONESHOT = /HITS?\b|ONE.?SHOTS?|DRUM.?KITS?|SINGLE.?SHOTS?|SOUNDS?\b|\bFX\b|_FX\b|SFX|MULTIS?\b/i;
// 楽器名のフォルダはループ集（Freaky Loops / Sample Magic の流儀）。"140_D_Song" のような BPM_キー もステム
const LOOP = /LOOP|LPS\b|_LPS|(^|[^A-Z])WAVS?([^A-Z]|$)|SONG|MELODY|THEME|RIFF|PHRASE|PROGRESSION|CONSTRUCTION|KIT|STEM|MELODIC|AMBIENCE|ATMOS|BACKGROUND|ARP|SEQUENCE|BASS|KEYS|GUITAR|CHORD|PULSE|INSPIRATIONAL|SYNTH|PAD|LINE|BEAT|TURNTABLE|CRACKLE|BONUS|^\d{2,3}_[A-G]/i;
const ONESHOT = /SOUND|FX|EFFECT|ONE.?SHOT|HIT|SINGLE|SHOT|STAB|DRUM|VOX|VOCAL|SAMPLE|KICK|SNARE|CLAP|HAT|CYMBAL|PERC|SHAKER|TOM|FILL|SWEEP|RIDE|CRASH|RIM|IMPACT|RISER|808/i;

// packName を渡すと、ドラム系パック（Loopcloud Drum など）の "Kit" はワンショットにする。
// それ以外の Kit はコンストラクションキット（曲ごとのループ集）
// 返り値: { cls: "loops" | "oneshots" | "skip" | "unknown", strength: "explicit" | "weak" | null }
function classifyFolderDetailed(name, packName = "") {
  const n = name.replace(/^[A-Z0-9]{2,6}_/, "");
  const drumPack = /^Loopcloud Drum\b|DRUM/i.test(packName);
  // "GA2_Loops_FRK" のように _ で続く名前は \b が効かないので、_ を空白にしたものでも見る
  const variants = [...new Set([n, name, n.replace(/[_\-]+/g, " "), name.replace(/[_\-]+/g, " ")])];
  const checks = [
    [SKIP, { cls: "skip", strength: "explicit" }],
    [/HITS?\b|ONE.?SHOTS?|DRUM.?KITS?/i, { cls: "oneshots", strength: "explicit" }], // "CONSTRUCTION_KIT_HITS" はヒット集
    [drumPack ? /KIT/i : /$^/, { cls: "oneshots", strength: "explicit" }],
    [EXPLICIT_LOOP, { cls: "loops", strength: "explicit" }],
    [EXPLICIT_ONESHOT, { cls: "oneshots", strength: "explicit" }],
    [LOOP, { cls: "loops", strength: "weak" }],
    [ONESHOT, { cls: "oneshots", strength: "weak" }],
  ];
  for (const [re, result] of checks) if (variants.some((t) => re.test(t))) return result;
  return { cls: "unknown", strength: null };
}
const classifyFolder = (name, packName = "") => classifyFolderDetailed(name, packName).cls;

// 親フォルダの分類を子に引き継ぐときの優先順: 子の明示 > 親の明示 > 子の弱い手がかり > 親の弱い手がかり
// （"Bass Music/Closed Hats" は Bass=弱いループ より Hats=弱いワンショット が勝ち、
//   "Loops/Drum Builds & Fills" は Loops=明示 が Fill=弱いワンショット に勝つ）
function inherit(own, parent) {
  if (own.cls === "skip") return own;
  if (own.strength === "explicit") return own;
  if (parent && parent.strength === "explicit" && parent.cls !== "skip") return parent;
  if (own.strength === "weak") return own;
  if (parent && parent.strength === "weak") return parent;
  return own;
}

// パック丸ごと対象外にするもの: Loopcloud Play はマルチサンプル楽器、Cloud Storage は置き場
const SKIP_PACK = /^Loopcloud Play\b|^Cloud Storage$/i;

// パック名からジャンル案。上から順に最初に当たったもの
const GENRES = [
  ["Metal", /METAL|THRASH|HARDCORE|ROCK|DEATH|HARD DROPS/i],
  ["Ambient", /AMBIENT|ATMOS|DOWNTEMPO|CHILL|LOUNGE|TEXTURE|RADIOPHONIC|SKIES|DREAMLAND|ORGANIC/i],
  ["Cinematic", /CINEMATIC|SOUNDTRACK|FILM|SCORE|HOLLYWOOD|EPIC|PREDESTINATION|RETRO-FI|LEITMOTIF|ROBOTIC_FX|FUTURISM|INFINITY|PULSAR|NATURAL_SELECTION|QUANTUM/i],
  ["HipHop", /HIP.?HOP|TRAP|BOOM|SOUL|RNB|R&B|GRIME|LO-?FI|JAZZADELIC/i],
  ["Bass", /DUBSTEP|DRUM.?N.?BASS|D&B|DNB|LIQUID|JUNGLE|BREAKBEAT|GLITCH|NEURO|ITAL.?TEK/i],
  ["House", /HOUSE|DISCO|GARAGE|FUNK|BOOGIE|GROOVE|NU.?DISCO|TROPICAL/i],
  ["Techno", /TECHNO|TECH(\b|_)|BERLIN|BERGHAIN|MINIMAL|ELECTRO|DUB\b|DUBTECH|ANALOG|DUB_CONSTRUCTION|RAW_ORGANIC/i],
  ["EDM", /EDM|TRANCE|PSY|PROGRESSIVE|BIG.?ROOM|FESTIVAL|SWEDISH|FUTURE|NEON|SYNTHWAVE|RETRO|ELECTRONIC|NORDIC/i],
  ["Pops", /POP|INDIE|SYNTH.?POP|LOLLIPOP|PIANO|EMOTIONAL|GUITAR|HORN|BLUES|JAZZ|LATIN|AFRO|INDIAN|VINTAGE|SESSION/i],
  ["Vocals", /VOCAL|VOX|CHOP/i],
  ["Drums", /DRUM|PERCUSSION|BEAT/i],
];

function guessGenre(packName) {
  for (const [g, re] of GENRES) if (re.test(packName)) return g;
  return null;
}

function countAudio(dir, recursive = true) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (recursive) walk(path.join(d, e.name)); }
      else if (AUDIO.test(e.name)) n++;
    }
  };
  walk(dir);
  return n;
}

// 入れ物フォルダ（"…_MAIN/…", "(Full_Zip)/Song_01", "Bass Music/Closed Hats" など）は葉まで下りて、
// 葉ごとに分類する。親の分類は inherit() の優先順で子に引き継ぐ。4 段より深いところは葉扱い
const MAX_DEPTH = 4;
function walkFolders(root, packName, put) {
  const visit = (label, full, parent, depth) => {
    const own = classifyFolderDetailed(path.basename(full), packName);
    const eff = inherit(own, parent);
    if (eff.cls === "skip") return put("skip", label, full, eff, true);
    const subs = fs.readdirSync(full, { withFileTypes: true }).filter((x) => x.isDirectory() && !x.name.startsWith("."));
    if (!subs.length || depth >= MAX_DEPTH) return put(eff.cls, label, full, eff, true);
    // 直下にも音声があるフォルダは、その分だけ自分の名前で 1 件（子は別に数える）
    if (countAudio(full, false) > 0) put(eff.cls, label, full, eff, false);
    for (const sd of subs.sort((a, b) => a.name.localeCompare(b.name))) visit(`${label}/${sd.name}`, path.join(full, sd.name), eff, depth + 1);
  };
  for (const e of fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name))) {
    visit(e.name, path.join(root, e.name), null, 1);
  }
}

// dir はライブラリ直下のフォルダ名だけを記録する（自宅のパスを分類表に残さない。読む側がライブラリのルートと結合する）
function surveyPack(dir) {
  const raw = path.basename(dir);
  const name = raw.replace(/ \([0-9a-f]{12}\)$/, "");
  if (SKIP_PACK.test(name)) {
    return { name, dir: raw, genre: "（対象外）", loops: [], oneshots: [], skip: ["(パック全体)"], unknown: [], flatAudio: 0,
      counts: { loops: 0, oneshots: 0, unknown: 0, flat: 0 }, skipPack: true };
  }
  const folders = { loops: [], oneshots: [], skip: [], unknown: [] };
  const flatAudio = countAudio(dir, false);
  // strength は生成側でファイル判定と合わせるときの事前情報の重み（明示 > 弱い）
  const put = (cls, label, full, eff, recursive) => {
    const audio = countAudio(full, recursive);
    if (audio === 0 && cls !== "skip") return; // 音声の無い入れ物は載せない
    folders[cls].push({ name: label, audio, strength: eff.strength });
  };
  walkFolders(dir, name, put);
  const sum = (k) => folders[k].reduce((a, f) => a + f.audio, 0);
  return {
    name,
    dir: raw,
    genre: guessGenre(name),
    loops: folders.loops,
    oneshots: folders.oneshots,
    skip: folders.skip.map((f) => f.name),
    unknown: folders.unknown,
    flatAudio,
    counts: { loops: sum("loops"), oneshots: sum("oneshots"), unknown: sum("unknown"), flat: flatAudio },
  };
}

function toMarkdown(packs) {
  const lines = [];
  lines.push("# Loopcloud パック分類表（レビュー用）", "");
  lines.push("`data/loopcloud-packs.json` が正で、これはその写しです。直したい行は会話で指示してください。", "");
  const byGenre = new Map();
  for (const p of packs) {
    const g = p.genre || "（未定）";
    if (!byGenre.has(g)) byGenre.set(g, []);
    byGenre.get(g).push(p);
  }
  lines.push("## ジャンル別の件数", "");
  lines.push("| ジャンル | パック数 | ループ | ワンショット |", "|---|---|---|---|");
  for (const [g, list] of [...byGenre].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`| ${g} | ${list.length} | ${list.reduce((a, p) => a + p.counts.loops, 0)} | ${list.reduce((a, p) => a + p.counts.oneshots, 0)} |`);
  }
  lines.push("", "## 全パック", "");
  lines.push("| パック | セット名（.als） | ジャンル案 | ループ | ワンショット | 不明フォルダ | 直下の音声 |", "|---|---|---|---|---|---|---|");
  for (const p of packs) {
    const unk = p.unknown.map((f) => `${f.name}(${f.audio})`).join(", ");
    lines.push(`| ${p.name} | ${p.setName || ""} | ${p.genre || "**未定**"}${p.genreSource === "override" ? "（指定）" : ""} | ${p.counts.loops} | ${p.counts.oneshots} | ${unk || ""} | ${p.flatAudio || ""} |`);
  }
  const review = packs.filter((p) => !p.skipPack && (!p.genre || p.unknown.length || (p.counts.loops === 0 && p.counts.oneshots === 0)));
  lines.push("", `## 要確認（${review.length} 件）`, "");
  lines.push("ジャンルが決まらない・分類できないフォルダがある・生成対象が無い、のいずれか。", "");
  for (const p of review) {
    const why = [];
    if (!p.genre) why.push("ジャンル未定");
    if (p.unknown.length) why.push("不明フォルダ: " + p.unknown.map((f) => f.name).join(", "));
    if (p.counts.loops === 0 && p.counts.oneshots === 0) why.push("生成対象なし" + (p.flatAudio ? `（直下に音声 ${p.flatAudio}）` : ""));
    lines.push(`- **${p.name}** — ${why.join(" / ")}`);
  }
  return lines.join("\n") + "\n";
}

// 人が決めたことは data/loopcloud-overrides.json に残す。再調査しても消えない。
//   { "<パック名>": { "genre": "Techno", "folders": { "<フォルダ名>": "loops|oneshots|skip" }, "note": "…" } }
function applyOverrides(packs, file) {
  if (!fs.existsSync(file)) return packs;
  const ov = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const p of packs) {
    const o = ov[p.name];
    if (!o) continue;
    if (o.genre) { p.genre = o.genre; p.genreSource = "override"; }
    if (o.folders) {
      // フォルダ名は葉のパス（"Loops/Basses"）でも、その末尾（"Basses"）でも指定できる
      const target = (label) => o.folders[label] ?? o.folders[path.basename(label)];
      const matched = new Set();
      for (const cls of ["loops", "oneshots", "skip", "unknown"]) {
        const keep = [], moved = [];
        for (const f of (cls === "skip" ? p.skip.map((n) => ({ name: n, audio: 0 })) : p[cls])) {
          const to = target(f.name);
          if (to) matched.add(o.folders[f.name] != null ? f.name : path.basename(f.name));
          // 人が決めたフォルダは "forced": 生成側はファイル判定をせずその種別で組む
          if (to && to !== cls) moved.push([to, { ...f, strength: "forced" }]); else keep.push(to ? { ...f, strength: "forced" } : f);
        }
        if (cls === "skip") p.skip = keep.map((f) => f.name); else p[cls] = keep;
        for (const [to, f] of moved) (to === "skip" ? p.skip.push(f.name) : p[to].push(f));
      }
      for (const k of Object.keys(o.folders)) if (!matched.has(k)) console.warn(`  警告: ${p.name} の指定フォルダ "${k}" に一致するものがありません`);
      const sum = (k) => p[k].reduce((a, f) => a + f.audio, 0);
      p.counts = { loops: sum("loops"), oneshots: sum("oneshots"), unknown: sum("unknown"), flat: p.flatAudio };
    }
    if (o.files) p.fileKinds = o.files; // { "<パック内の相対パス>": "loop" | "oneshot" } ファイル単位の指定
    if (o.setName) p.setNameOverride = o.setName; // .als 名を人が決める
    if (o.split) p.split = o.split; // 1 段目のフォルダごとに別セットにする（["Deathrash", "Metalcore", …]）。他のフォルダは各セットに共通で入る
    if (o.note) p.note = o.note;
    if (o.layout) p.layout = o.layout; // "songs": 曲を行・パートを列に並べる（曲キット型パック）
  }
  return packs;
}

// セット名（.als のファイル名）。Loopcloud の Labels タグでレーベル名を外す。同名になったらレーベルを頭に付けて区別
function assignSetNames(packs) {
  const { setNameOf } = require("./set-name");
  const { LoopcloudDb } = require("./loopcloud-db");
  const lc = LoopcloudDb.shared();
  for (const p of packs) {
    if (p.skipPack) continue;
    let label = null;
    if (lc) {
      const first = lc.packItems(p.name).find(([rel]) => AUDIO.test(rel));
      if (first) label = lc.item(first[1]).label;
    }
    p.label = label;
    p.setName = p.setNameOverride || setNameOf(p.name, { label });
  }
  // 同名になったらレーベルを頭に付ける（人が setName で決めたものは動かさない）。それでも同名なら番号を付けて必ず別名にする
  const count = () => { const m = new Map(); for (const p of packs) if (p.setName) m.set(p.setName, (m.get(p.setName) || 0) + 1); return m; };
  let seen = count();
  for (const p of packs) {
    if (p.setName && !p.setNameOverride && seen.get(p.setName) > 1) {
      p.setName = setNameOf((p.label ? p.label + " " : "") + p.name);
      console.warn(`  注意: セット名が重複したためレーベルを付けた: ${p.name} → ${p.setName}`);
    }
  }
  // 人が決めた名前を先に確保し、それ以外で同名が残ったものに -2, -3 … を付ける
  const taken = new Set(packs.filter((p) => p.setNameOverride && p.setName).map((p) => p.setName));
  for (const p of packs) {
    if (!p.setName || p.setNameOverride) continue;
    if (!taken.has(p.setName)) { taken.add(p.setName); continue; }
    let n = 2, fixed;
    do { fixed = `${p.setName}-${n++}`; } while (taken.has(fixed));
    console.warn(`  注意: セット名がまだ重複するため番号を付けた: ${p.name} → ${fixed}`);
    p.setName = fixed; taken.add(fixed);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (k, d) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : d);
  const library = opt("--library", DEFAULT_LIBRARY);
  const outJson = opt("--out", path.join(__dirname, "..", "data", "loopcloud-packs.json"));
  const outMd = opt("--md", path.join(__dirname, "..", "docs", "loopcloud-packs.md"));

  const packs = fs
    .readdirSync(library, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => surveyPack(path.join(library, e.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
  applyOverrides(packs, opt("--overrides", path.join(__dirname, "..", "data", "loopcloud-overrides.json")));
  assignSetNames(packs);

  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify(packs, null, 1));
  fs.writeFileSync(outMd, toMarkdown(packs));

  const t = (k) => packs.reduce((a, p) => a + p.counts[k], 0);
  console.log(`パック ${packs.length} / ループ ${t("loops")} / ワンショット ${t("oneshots")} / 不明 ${t("unknown")} / 直下 ${t("flat")}`);
  console.log(`ジャンル未定 ${packs.filter((p) => !p.genre).length} / 不明フォルダあり ${packs.filter((p) => p.unknown.length).length} / 生成対象なし ${packs.filter((p) => p.counts.loops + p.counts.oneshots === 0).length}`);
  console.log(`→ ${outJson}\n→ ${outMd}`);
}

module.exports = { classifyFolder, classifyFolderDetailed, inherit, guessGenre, surveyPack, assignSetNames };
if (require.main === module) main();
