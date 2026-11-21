// scripts/komplete-build.js — Komplete 26 の試聴ループ WAV をセッションビュー用の .als 群に落とす（#24）
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { build } = require("../../scripts/komplete-build");
const { readAls, listTracks } = require("../../scripts/als");
const { assertValid } = require("../../scripts/als-validate");

// 24bit・2ch・8000Hz・4 秒（= 120 BPM の 2 小節 = 8 拍）の無音 WAV
function wav24(seconds = 4, rate = 8000) {
  const frames = seconds * rate;
  const data = Buffer.alloc(frames * 2 * 3);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii"); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii"); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 6, 28); h.writeUInt16LE(6, 32); h.writeUInt16LE(24, 34);
  h.write("data", 36, "ascii"); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// 2 製品（Beats の 1 本 + Complex の 2 本）・2 カテゴリの manifest を作る
function fakeManifest(root) {
  const items = [
    { product: "Loop Pack", category: "01_Loops", patch: "a", clipName: "a | 120BPM", bpm: 120, warp: "beats", file: "Komplete26 Project/Samples/01_Loops/Loop Pack/a.wav" },
    { product: "Synth Pack", category: "02_KeysSynth", patch: "p1", clipName: "p1 | Idea | 120BPM", bpm: 120, warp: "complex", file: "Komplete26 Project/Samples/02_KeysSynth/Synth Pack/p1.wav" },
    { product: "Synth Pack", category: "02_KeysSynth", patch: "p2", clipName: "p2 | Idea | 120BPM", bpm: 120, warp: "complex", file: "Komplete26 Project/Samples/02_KeysSynth/Synth Pack/p2.wav" },
  ];
  for (const it of items) {
    const p = path.join(root, it.file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, wav24());
  }
  const manifestPath = path.join(root, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, items, warnings: [] }));
  return manifestPath;
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "k26-"));

test("カテゴリごとに 1 セット、製品ごとに 1 オーディオトラック、クリップはループ ON（#24）", () => {
  const root = tmp();
  const manifestPath = fakeManifest(root);
  const r = build({ manifestPath });
  assert.deepStrictEqual(r.map((x) => x.name), ["01_Loops", "02_KeysSynth"], "クリップのあるカテゴリだけセットになる");
  assert.ok(r.every((x) => x.status === "written"));

  const dir = path.join(root, "Komplete26 Project");
  assert.ok(fs.existsSync(path.join(dir, "Ableton Project Info")));
  const keys = readAls(path.join(dir, "02_KeysSynth.als"));
  assert.strictEqual(listTracks(keys).filter((t) => t.tag === "AudioTrack").length, 1, "1 製品 1 トラック");
  assert.strictEqual(keys.match(/<AudioClip /g).length, 2);
  assert.strictEqual(r[1].clips, 2);
  assert.strictEqual(r[1].scenes, 8, "シーンは最低 8");
  assert.match(keys, /<Name Value="001" \/>/);

  const loops = readAls(path.join(dir, "01_Loops.als"));
  assert.strictEqual(listTracks(loops).filter((t) => t.tag === "AudioTrack").length, 1);
  assert.strictEqual(loops.match(/<AudioClip /g).length, 1);
});

test("ワープマーカーは自分の BPM の拍数、参照は Samples/ からの相対パス、テンポは 120（#24）", () => {
  const root = tmp();
  build({ manifestPath: fakeManifest(root) });
  const xml = readAls(path.join(root, "Komplete26 Project", "02_KeysSynth.als"));
  assert.match(xml, /BeatTime="8"/, "4 秒 @120BPM = 8 拍");
  assert.match(xml, /RelativePath Value="Samples\//);
  assert.match(xml, /<LoopOn Value="true" \/>/);
  assert.match(xml, /<Tempo>[\s\S]*?<Manual Value="120" \/>/);
  assert.doesNotMatch(xml, /<IsTempoEnabled Value="true" \/>/, "シーンにテンポを持たせない");
});

test("warp が complex の製品は WarpMode 4、beats の製品は 0（#24）", () => {
  const root = tmp();
  build({ manifestPath: fakeManifest(root) });
  const dir = path.join(root, "Komplete26 Project");
  const keys = readAls(path.join(dir, "02_KeysSynth.als"));
  const loops = readAls(path.join(dir, "01_Loops.als"));
  assert.strictEqual(keys.match(/<WarpMode Value="4" \/>/g).length, 2);
  assert.doesNotMatch(keys, /<WarpMode Value="0" \/>/);
  assert.strictEqual(loops.match(/<WarpMode Value="0" \/>/g).length, 1);
  assert.doesNotMatch(loops, /<WarpMode Value="4" \/>/);
  assert.doesNotThrow(() => assertValid(keys, "keys"));
  assert.doesNotThrow(() => assertValid(loops, "loops"));
});

test("--sets で絞れ、dry-run は書かず、既存は --force が無ければ見送る（#24）", () => {
  const root = tmp();
  const manifestPath = fakeManifest(root);
  const dir = path.join(root, "Komplete26 Project");

  const dry = build({ manifestPath, dryRun: true });
  assert.deepStrictEqual(dry.map((x) => [x.name, x.tracks, x.clips]), [["01_Loops", 1, 1], ["02_KeysSynth", 1, 2]]);
  assert.ok(!fs.existsSync(path.join(dir, "01_Loops.als")), "dry-run は何も書かない");

  const only = build({ manifestPath, sets: ["02"] });
  assert.deepStrictEqual(only.map((x) => x.name), ["02_KeysSynth"]);
  assert.ok(!fs.existsSync(path.join(dir, "01_Loops.als")));

  assert.strictEqual(build({ manifestPath, sets: ["02"] })[0].status, "existing");
  assert.strictEqual(build({ manifestPath, sets: ["02"], force: true })[0].status, "written");
  assert.ok(fs.existsSync(path.join(dir, "Backup")), "置き換えは Backup/ へ退避する");
});

test("製品内で warp が混在していたら throw する（#24）", () => {
  const root = tmp();
  const manifestPath = fakeManifest(root);
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  m.items[2].warp = "beats";
  fs.writeFileSync(manifestPath, JSON.stringify(m));
  assert.throws(() => build({ manifestPath }), /warp が混在/);
});
