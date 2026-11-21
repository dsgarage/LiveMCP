#!/usr/bin/env node
// Komplete 26 の試聴ループ WAV を、セッションビューで引ける .als 群に落とす（#24）。
//
//   node scripts/komplete-build.js <manifest.json> [--out <dir>] [--sets 01,02] [--force] [--dry-run]
//
// manifest.json は Plugin2Audio の k26_manifest.py が作る（形は docs/komplete26_design.md 5 章）。
// カテゴリ（01_Loops / 02_KeysSynth / 03_Rhythm / 04_Other）ごとに 1 本の .als を作る。
//   トラック … 1 製品 1 本のオーディオトラック（manifest の出てきた順）
//   クリップ … 製品内は manifest の順に縦へ並べる。ループ ON、自分の BPM のワープマーカー付き
//   テンポ   … セットは 120。クリップのテンポ表示は、各クリップの拍数（自分の BPM で計算）で決まる
//   クリップの色 … clipName の先頭の語（パート）で決める。パートが読めない録音物（` | ` 形式）はトラックの色
//   WarpMode … warp が "complex" の製品は 4（Complex）、それ以外は 0（Beats）
// WAV は出力先の Samples/ にある前提で、相対パスと絶対パスの両方を書く（持ち運べる）。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const als = require("./als");
const { audioTrack, scenesBlock, makePidAllocator } = require("./als-generate");
const { assertValid } = require("./als-validate");
const { audioInfo } = require("./audio-info");
const { isOpenInLive } = require("./notify");

const BASE_SET = path.join(__dirname, "..", "templates", "live-set.xml");
const CATEGORIES = ["01_Loops", "02_KeysSynth", "03_Rhythm", "04_Other"];
const SET_TEMPO = 120;
const MIN_SCENES = 8;
const WARP_MODE = { beats: 0, complex: 4 };

// ---- クリップの色 ----

// 役割（clipName の先頭の語）→ Live の色番号。見分けやすいよう色相の離れた番号を選ぶ（Live の色番号 0〜69 は 14 色相 × 5 段）。
// リポジトリ内に色番号の資料は無い。番号は Live で目視して決めた値ではない（要確認）
const PART_GROUPS = [
  [1, ["drums", "kick", "snare", "clap", "hihat", "hat", "perc", "shaker", "percussion", "cymbals", "crash", "tom", "top"]],
  [9, ["bass", "sub", "808"]],
  [4, ["keys", "piano", "rhodes", "organ", "ep"]],
  [2, ["guitar"]],
  [12, ["synth", "arp", "arpeggio", "lead", "pluck", "bells", "bell", "blip", "hit"]],
  [6, ["pad", "string", "strings", "brass", "flute", "horn", "sax"]],
  [13, ["vox", "vocal", "choir"]],
  [7, ["fx", "sweep", "riser", "noise", "texture"]],
  [0, ["full", "mix"]],
];
const PART_COLOR = new Map(PART_GROUPS.flatMap(([c, words]) => words.map((w) => [w, c])));
// 対応表に無い語は、語の文字列から決まる色。対応表の色と重ならない番号から選ぶ
const FALLBACK_COLORS = [3, 5, 8, 10, 17, 19, 22, 24];

// clipName の先頭の語を小文字で返す。録音した音源（<パッチ> | <フレーズ> | <BPM>BPM、` | ` が 2 つ以上）は役割を読み取れないので null。
// 同梱ループ（<元の名前> | <BPM>BPM、` | ` が 1 つ）は先頭の語がパート
function partOf(clipName) {
  if ((String(clipName).match(/ \| /g) || []).length >= 2) return null;
  const word = String(clipName).trim().split(/[\[\s|]/)[0].toLowerCase();
  return word || null;
}

function clipColor(clipName, trackColor) {
  const part = partOf(clipName);
  if (!part) return trackColor;
  if (PART_COLOR.has(part)) return PART_COLOR.get(part);
  let h = 0;
  for (const ch of part) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
}

// ---- manifest の読み込み ----

// items を category → 製品（初出順）→ クリップ（manifest の順）にまとめる
function groupItems(items, manifestDir) {
  const byCat = new Map();
  for (const it of items) {
    if (!CATEGORIES.includes(it.category)) throw new Error(`知らない category: ${it.category}（${it.product} / ${it.clipName}）`);
    if (typeof it.bpm !== "number" || !(it.bpm > 0)) throw new Error(`bpm が数値ではありません: ${it.product} / ${it.clipName}`);
    if (!(it.warp in WARP_MODE)) throw new Error(`warp は beats か complex です: ${it.warp}（${it.product} / ${it.clipName}）`);
    if (!byCat.has(it.category)) byCat.set(it.category, new Map());
    const products = byCat.get(it.category);
    if (!products.has(it.product)) products.set(it.product, []);
    products.get(it.product).push({ ...it, abs: path.resolve(manifestDir, it.file) });
  }
  return byCat;
}

// ---- セットの組み立て（niko-build.js の buildSet と同じ順） ----

function buildSet({ output, name, products }) {
  const alsDir = path.dirname(output);
  const scenes = Math.max(MIN_SCENES, ...[...products.values()].map((list) => list.length));
  const sceneList = Array.from({ length: scenes }, (_, i) => ({ name: String(i + 1).padStart(3, "0"), tempo: null }));

  let xml = fs.readFileSync(BASE_SET, "utf8");
  for (const t of als.listTracks(xml).filter((t) => t.tag !== "ReturnTrack").reverse()) {
    xml = xml.slice(0, t.start) + xml.slice(t.end + 1);
  }
  xml = xml.replace("__SCENES__", scenesBlock(sceneList));
  xml = als.setTempo(xml, SET_TEMPO);

  const pid = makePidAllocator(als.nextPointeeId(xml));
  let trackId = Math.max(...als.listTracks(xml).map((t) => t.id), 10) + 1;
  let clips = 0;
  const blocks = [...products.entries()].map(([product, list], i) => {
    const trackColor = (i * 7) % 60;
    const warps = new Set(list.map((it) => it.warp));
    if (warps.size > 1) throw new Error(`${product}: 1 製品の中で warp が混在しています（${[...warps].join(" / ")}）`);
    const files = list.map((it) => {
      const info = audioInfo(it.abs);
      if (!info) throw new Error(`WAV のヘッダを読めません: ${it.abs}`);
      return { path: it.abs, meta: { stem: it.clipName, bpm: it.bpm }, info, color: clipColor(it.clipName, trackColor) };
    });
    clips += files.length;
    return audioTrack({ id: trackId++, name: product, color: trackColor, files, scenes, alsDir, bpm: SET_TEMPO, pid, warpMode: WARP_MODE[list[0].warp] });
  });

  const firstReturn = als.listTracks(xml).find((t) => t.tag === "ReturnTrack");
  xml = xml.slice(0, firstReturn.start) + blocks.join("\n") + "\n" + xml.slice(firstReturn.start);
  xml = xml.replace(/<NextPointeeId Value="\d+" \/>/, `<NextPointeeId Value="${pid.next}" />`);

  assertValid(xml, name);

  fs.mkdirSync(alsDir, { recursive: true });
  fs.mkdirSync(path.join(alsDir, "Ableton Project Info"), { recursive: true });
  als.writeAls(output, xml);
  return { tracks: blocks.length, clips, scenes };
}

// ---- 入口 ----

function build({ manifestPath, outDir, sets, force = false, dryRun = false }) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest || !Array.isArray(manifest.items)) throw new Error(`manifest に items がありません: ${manifestPath}`);
  const manifestDir = path.dirname(path.resolve(manifestPath));
  const out = outDir || path.join(manifestDir, "Komplete26 Project");
  const grouped = groupItems(manifest.items, manifestDir);

  const results = [];
  for (const name of CATEGORIES) {
    if (sets && sets.length && !sets.includes(name.slice(0, 2))) continue;
    const products = grouped.get(name);
    if (!products) continue; // クリップが 1 本も無いカテゴリのセットは作らない
    const output = path.join(out, `${name}.als`);
    const tracks = products.size;
    const clips = [...products.values()].reduce((n, l) => n + l.length, 0);
    const scenes = Math.max(MIN_SCENES, ...[...products.values()].map((l) => l.length));
    if (dryRun) { results.push({ name, output, tracks, clips, scenes, status: "dry-run" }); continue; }

    if (fs.existsSync(output)) {
      if (!force) { results.push({ name, output, status: "existing" }); continue; }
      if (isOpenInLive(output)) { results.push({ name, output, status: "open" }); continue; }
      const b = als.backupPath(output);
      fs.mkdirSync(path.dirname(b), { recursive: true });
      fs.copyFileSync(output, b);
    }
    results.push({ name, output, status: "written", ...buildSet({ output, name, products }) });
  }
  return results;
}

module.exports = { build, partOf, clipColor };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
  const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--out", "--sets"].includes(argv[i - 1])));
  const [manifestPath] = positional;
  if (!manifestPath) {
    console.error("使い方: node scripts/komplete-build.js <manifest.json> [--out <dir>] [--sets 01,02] [--force] [--dry-run]");
    process.exit(1);
  }
  const sets = (flag("--sets") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const out = flag("--out");
  const r = build({ manifestPath: path.resolve(manifestPath), outDir: out ? path.resolve(out) : null, sets, force: argv.includes("--force"), dryRun: argv.includes("--dry-run") });
  for (const x of r) {
    if (x.status === "existing") console.log(`${x.name}: 既存のため見送り（--force で Backup/ へ退避して置き換え）→ ${x.output}`);
    else if (x.status === "open") console.log(`${x.name}: Live で開いているため見送り → ${x.output}`);
    else console.log(`${x.name}: トラック ${x.tracks} / クリップ ${x.clips} / シーン ${x.scenes}${x.status === "dry-run" ? "（dry-run）" : ""} → ${x.output}`);
  }
}
