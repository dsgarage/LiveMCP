#!/usr/bin/env node
// キー別 × カテゴリ別に整理された MIDI 素材ライブラリを、
// セッションビューで引ける .als 群に落とす（#20）。
//
//   node scripts/niko-build.js <ライブラリのルート> <出力先> [--keys "C Major - A Minor,..."] [--sets 01,03] [--dry-run] [--no-instruments]
//
// 3 軸の役割:
//   プロジェクト = キー … 曲を書くときは調が先に決まる。12 調は移調コピーなので同時に見る意味がない
//   シーン（行） = 素材 1 件 … テンポ・拍子を持てるのはシーンだけ。BPM 指定はここで解決する
//   トラック（列）= 同じ素材の変奏（Chords / DRY / WET）。変奏が無いカテゴリは出典やジャンルを列にする
//
// グリッドは 2 種類あり、セット単位で型を統一する:
//   行に意味がある型   … 01_Ideas。1 行 = 1 アイデアで、列はその変奏。シーンを発火して使う
//   列ごとに積む型     … 02 / 04。列 = ジャンルやカテゴリで、行はただの通し番号。クリップ単体で使う
//
// MIDI クリップはノートを埋め込むので、出来た .als は素材ファイルを参照しない（単体で持ち運べる）。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const als = require("./als");
const { midiTrack, scenesBlock, makePidAllocator } = require("./als-generate");
const { assertValid } = require("./als-validate");

const TEMPLATE_DIR = path.join(__dirname, "..", "templates");
const BASE_SET = path.join(TEMPLATE_DIR, "live-set.xml");
const MAIN_PACK = "Niko_MIDI_Pack";

// トラックに載せる楽器（#22）。Core Library の中で最も軽い組み合わせ。
// --no-instruments で外せる。
//   Ac Piano Upright   … Simpler 1 台 + サンプル 1 本（OriginalSimpler → ChannelEq → Reverb）
//   Classic Ensemble Pad … Drift 1 台（Drift → ChannelEq → Chorus2）
// ラックの殻は使わず、中のチェーンだけを直列で置く（device-preset.js 参照）
const CORE_RACKS = "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Core Library/Racks/Instrument Racks";
const PIANO = path.join(CORE_RACKS, "Piano & Keys", "Ac Piano Upright.adg");
const PAD = path.join(CORE_RACKS, "Pad", "Classic Ensemble Pad.adg");
const preset = (p) => (withInstruments && fs.existsSync(p) ? p : null);
const PRESET_OPTS = { instrumentOnly: process.env.NIKO_INSTRUMENT_ONLY === "1" };
let withInstruments = true; // --no-instruments で外せる
const CHORD_PACK = "2000_NikoChord_Pack";
const KEY_DIR = /^(.+ Major) - (.+ Minor)$/;

// ---- ファイル集め ----

// 数字を数として比べる。"Melody_2" が "Melody_10" より前に来るようにする
function naturalCompare(a, b) {
  const ax = a.toLowerCase().match(/(\d+|\D+)/g) || [];
  const bx = b.toLowerCase().match(/(\d+|\D+)/g) || [];
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const x = ax[i], y = bx[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d/.test(x), ny = /^\d/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function midsIn(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...midsIn(p));
    else if (/\.mid$/i.test(e.name)) out.push(p);
  }
  return out.sort((a, b) => naturalCompare(path.basename(a), path.basename(b)));
}

// クリップ名。作者名の接頭 / 接尾と DRY / WET の別は列の名前で分かるので落とす
function clipName(p) {
  return path.basename(p)
    .replace(/\.mid$/i, "")
    .replace(/^Niko_Kotoulas_/, "")
    .replace(/_?Niko_Kotoulas$/, "")
    .replace(/_(W?DRY|WET)$/i, "")
    .trim();
}

// 変奏をまとめる鍵。DRY / WET を外した残りを、ジャンルのフォルダごと区別する。
// "Niko's Favorites" のように別フォルダへ同名ファイルを再掲しているものがあるため、
// ファイル名だけを鍵にすると後から来たほうが落ちる（C キーだけで 20 件）
function variantKey(p, baseDir) {
  const stem = path.basename(p).replace(/\.mid$/i, "").replace(/_(W?DRY|WET)$/i, "");
  const dir = baseDir ? path.dirname(path.relative(baseDir, p)) : "";
  return dir && dir !== "." ? `${dir}/${stem}` : stem;
}

const isWet = (p) => /_WET\.mid$/i.test(p);
const isDry = (p) => /_W?DRY\.mid$/i.test(p);

// DRY / WET を同じ行に揃える。行はジャンルのフォルダごとに固まり、その中は自然順
function pairDryWet(files, baseDir) {
  const order = [];
  const seen = new Map();
  for (const f of files) {
    const k = variantKey(f, baseDir);
    if (!seen.has(k)) { seen.set(k, { dry: null, wet: null }); order.push(k); }
    const slot = seen.get(k);
    if (isWet(f)) slot.wet = f;
    else if (isDry(f)) slot.dry = f;
    else if (!slot.dry) slot.dry = f; // 変奏の無い単独ファイルは DRY 側に置く
    else slot.wet = f;
  }
  order.sort(naturalCompare);
  return {
    dry: order.map((k) => seen.get(k).dry),
    wet: order.map((k) => seen.get(k).wet),
    names: order.map((k) => clipName(seen.get(k).dry || seen.get(k).wet)),
  };
}

// 番号付きのサブフォルダを番号順に返す（"1 - Beautiful" → "23 - Advanced"）
function numberedDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(naturalCompare);
}

// ---- セットの組み立て ----

const toFile = (p) => ({ path: p, meta: { stem: clipName(p) } });

// トラック 1 本ぶんの指定。files は null 詰めの配列（null は空スロット）
function column(name, files, names, instrument = PIANO) {
  const list = files.map((f) => (f ? toFile(f) : null));
  return { name, files: list, clipNames: names || files.map((f) => (f ? clipName(f) : "")), preset: preset(instrument) };
}

function fromDir(name, dir, instrument) {
  return column(name, midsIn(dir), null, instrument);
}

// クリップの無いパッド用トラック。コードのクリップをここへコピーすれば重ねられる
const padColumn = () => ({ name: "PAD", files: [], clipNames: [], preset: preset(PAD) });

function buildSet({ output, name, columns, scenes, sceneList, tempo }) {
  const filled = columns.reduce((n, c) => n + c.files.filter(Boolean).length, 0);
  if (!filled) return null;

  let xml = fs.readFileSync(BASE_SET, "utf8");
  for (const t of als.listTracks(xml).filter((t) => t.tag !== "ReturnTrack").reverse()) {
    xml = xml.slice(0, t.start) + xml.slice(t.end + 1);
  }
  xml = xml.replace("__SCENES__", scenesBlock(sceneList || scenes));
  xml = als.setTempo(xml, tempo || 120);

  const basePointee = als.nextPointeeId(xml);
  const pid = makePidAllocator(basePointee);
  let trackId = Math.max(...als.listTracks(xml).map((t) => t.id), 10) + 1;
  const blocks = columns.map((c, i) =>
    midiTrack({ id: trackId++, name: c.name, color: (i * 7) % 60, files: c.files, scenes, pid, clipNames: c.clipNames, preset: c.preset, presetOpts: PRESET_OPTS }));

  const firstReturn = als.listTracks(xml).find((t) => t.tag === "ReturnTrack");
  xml = xml.slice(0, firstReturn.start) + blocks.join("\n") + "\n" + xml.slice(firstReturn.start);
  xml = xml.replace(/<NextPointeeId Value="\d+" \/>/, `<NextPointeeId Value="${pid.next}" />`);
  assertValid(xml, `${path.basename(path.dirname(output))} / ${name}`);

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(path.join(path.dirname(output), "Ableton Project Info"), { recursive: true });
  als.writeAls(output, xml);
  return { output, name, tracks: columns.length, scenes, clips: filled };
}

// 01_Ideas … 1 行 = 1 アイデア、列は Chords / Idea DRY / Idea WET。シーンにアイデアの BPM を持たせる
function setIdeas(keyDir, output) {
  const root = path.join(keyDir, "1 - Best Ideas");
  const dirs = numberedDirs(root);
  const chords = [], dry = [], wet = [], sceneList = [];
  for (const d of dirs) {
    const files = midsIn(path.join(root, d));
    chords.push(files.find((f) => /_Chords_/i.test(f)) || null);
    dry.push(files.find((f) => /_W?DRY\.mid$/i.test(f)) || null);
    wet.push(files.find((f) => /_WET\.mid$/i.test(f)) || null);
    const num = (/^(\d+)/.exec(d) || [])[1] || "";
    const bpm = (/_(\d+)BPM$/i.exec(d) || [])[1];
    const label = d.replace(/^\d+\s*_?/, "").replace(/_\d+BPM$/i, "").replace(/_/g, " ").trim();
    sceneList.push({ name: `${String(num).padStart(2, "0")} ${label}`.trim(), tempo: bpm ? Number(bpm) : null });
  }
  if (!dirs.length) return null;
  // セットのテンポはアイデアの BPM の中央値（シーンを発火すれば個別に切り替わる）
  const bpms = sceneList.map((s) => s.tempo).filter(Boolean).sort((a, b) => a - b);
  return buildSet({
    output, name: "01_Ideas", scenes: dirs.length, sceneList,
    tempo: bpms.length ? bpms[Math.floor(bpms.length / 2)] : 120,
    columns: [
      column("Chords", chords),
      column("Chords Pad", chords, null, PAD), // 同じ行に置くので、シーンを発火すると和音が重なる
      column("Idea DRY", dry),
      column("Idea WET", wet),
    ],
  });
}

// 02_Chords … 列 = 出典・ジャンル。行は通し番号（列ごとに独立に積む）
function setChords(keyDir, libRoot, keyName, output) {
  const prog = path.join(keyDir, "2 - Best Progresions");
  const bonus = path.join(keyDir, "7 - Other Bonuses");
  const packDirs = fs.existsSync(path.join(libRoot, CHORD_PACK))
    ? numberedDirs(path.join(libRoot, CHORD_PACK)) : [];
  const packFiles = packDirs
    .flatMap((d) => midsIn(path.join(libRoot, CHORD_PACK, d, keyName, "Chords")))
    .sort((a, b) => naturalCompare(path.basename(a), path.basename(b)));

  const columns = [
    fromDir("Top 100", path.join(keyDir, "4 - Top 100 Chord Progs")),
    column("Pack 101-300", packFiles),
    fromDir("Pop", path.join(prog, "Pop")),
    fromDir("EDM", path.join(prog, "EDM")),
    fromDir("R&B Neosoul Jazz", path.join(prog, "R&B_Neosoul_Jazz")),
    fromDir("Emotional", path.join(prog, "Emotional")),
    fromDir("Beautiful", path.join(prog, "Beautiful")),
    fromDir("Dark HipHop Trap", path.join(prog, "Dark_HipHop_Trap")),
    fromDir("Sexy 7th 9th", path.join(prog, "Sexy_7th_9th")),
    fromDir("Gorgeous", path.join(bonus, "1 - Gorgeous Chord Progressions")),
    fromDir("Rhythmic", path.join(bonus, "3 - Rhythmic Chord Progressions")),
  ].filter((c) => c.files.some(Boolean));
  const scenes = Math.max(8, ...columns.map((c) => c.files.length));
  return buildSet({ output, name: "02_Chords", columns: [...columns, padColumn()], scenes, sceneList: numberedScenes(scenes) });
}

// 03_Melodies … Melody / Starter は DRY・WET を同じ行に揃える。Extras は BPM 帯ごとの列
function setMelodies(keyDir, output) {
  const melDir = path.join(keyDir, "3 - Best Melodies");
  const staDir = path.join(keyDir, "5 - Top 100 Melody Starters");
  const mel = pairDryWet(midsIn(melDir), melDir);
  const sta = pairDryWet(midsIn(staDir), staDir);
  const extras = path.join(keyDir, "7 - Other Bonuses", "7 - More Extras", "Melodies");
  const columns = [
    column("Melody DRY", mel.dry, mel.names),
    column("Melody WET", mel.wet, mel.names),
    column("Starter DRY", sta.dry, sta.names),
    column("Starter WET", sta.wet, sta.names),
    ...numberedDirs(extras).map((b) => fromDir(`Extras ${b}`, path.join(extras, b))),
  ].filter((c) => c.files.some(Boolean));
  const scenes = Math.max(8, ...columns.map((c) => c.files.length));
  return buildSet({ output, name: "03_Melodies", columns, scenes, sceneList: numberedScenes(scenes) });
}

// 04_Palette … 単体コードと小物。列 = カテゴリ、行は通し番号
function setPalette(keyDir, output) {
  const cb = path.join(keyDir, "6 - Chord Builder");
  const bonus = path.join(keyDir, "7 - Other Bonuses");
  const columns = [
    ...numberedDirs(cb).map((c) => fromDir(c.replace(/^(\d+)\s*-\s*/, "$1 "), path.join(cb, c))),
    fromDir("Intros & Arps", path.join(bonus, "2 - Piano Song Intros Arps")),
    fromDir("Basslines", path.join(bonus, "4 - Catchy Basslines Pack")),
    fromDir("Extra Chords", path.join(bonus, "7 - More Extras", "Chords")),
  ].filter((c) => c.files.some(Boolean));
  const scenes = Math.max(8, ...columns.map((c) => c.files.length));
  return buildSet({ output, name: "04_Palette", columns: [...columns, padColumn()], scenes, sceneList: numberedScenes(scenes) });
}

// 行に意味が無いセットは、行番号だけ入れておく（Live の既定は空名でシーンが見分けにくい）
const numberedScenes = (n) => Array.from({ length: n }, (_, i) => ({ name: String(i + 1).padStart(3, "0"), tempo: null }));

const SETS = {
  "01": (ctx) => setIdeas(ctx.keyDir, path.join(ctx.projectDir, "01_Ideas.als")),
  "02": (ctx) => setChords(ctx.keyDir, ctx.libRoot, ctx.keyName, path.join(ctx.projectDir, "02_Chords.als")),
  "03": (ctx) => setMelodies(ctx.keyDir, path.join(ctx.projectDir, "03_Melodies.als")),
  "04": (ctx) => setPalette(ctx.keyDir, path.join(ctx.projectDir, "04_Palette.als")),
};

// ---- 入口 ----

function listKeys(libRoot) {
  const dir = path.join(libRoot, MAIN_PACK);
  if (!fs.existsSync(dir)) throw new Error(`${MAIN_PACK} が見つかりません: ${dir}`);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && KEY_DIR.test(e.name))
    .map((e) => e.name)
    .sort();
}

function build({ libRoot, outRoot, keys, sets = Object.keys(SETS), dryRun = false, instruments = true }) {
  withInstruments = instruments;
  const all = listKeys(libRoot);
  const targets = keys && keys.length ? keys.filter((k) => all.includes(k)) : all;
  if (!targets.length) throw new Error(`対象のキーがありません（候補: ${all.join(" / ")}）`);

  const results = [];
  for (const keyName of targets) {
    const keyDir = path.join(libRoot, MAIN_PACK, keyName);
    const projectDir = path.join(outRoot, `${keyName} Project`);
    for (const s of sets) {
      if (!SETS[s]) throw new Error(`知らないセット: ${s}（${Object.keys(SETS).join(" / ")}）`);
      if (dryRun) { results.push({ key: keyName, set: s, output: path.join(projectDir, `${s}_.als`), dryRun: true }); continue; }
      const r = SETS[s]({ keyDir, libRoot, keyName, projectDir });
      if (r) { results.push({ key: keyName, ...r }); console.log(`  ${keyName} / ${r.name}: ${r.tracks} 列 × ${r.scenes} 行 → ${r.clips} クリップ`); }
      else console.warn(`  警告: ${keyName} / ${s} は素材が無いので飛ばしました`);
    }
  }
  return results;
}

module.exports = { build, listKeys, naturalCompare, pairDryWet, clipName, variantKey };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
  const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && argv[i - 1] !== "--dry-run"));
  const [libRoot, outRoot] = positional;
  if (!libRoot || !outRoot) {
    console.error("使い方: node scripts/niko-build.js <ライブラリのルート> <出力先> [--keys \"C Major - A Minor,...\"] [--sets 01,03] [--dry-run] [--no-instruments]");
    process.exit(1);
  }
  const keys = (flag("--keys") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const sets = (flag("--sets") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const t0 = Date.now();
  const r = build({
    libRoot: path.resolve(libRoot), outRoot: path.resolve(outRoot),
    keys, sets: sets.length ? sets : undefined, dryRun: argv.includes("--dry-run"),
    instruments: !argv.includes("--no-instruments"),
  });
  const clips = r.reduce((n, x) => n + (x.clips || 0), 0);
  console.log(`\n${r.length} セット / ${clips} クリップ を ${((Date.now() - t0) / 1000).toFixed(1)} 秒で書きました → ${path.resolve(outRoot)}`);
}
