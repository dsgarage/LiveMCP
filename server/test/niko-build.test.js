// scripts/niko-build.js — MIDI 素材ライブラリをセッションビュー用の .als 群に落とす（#20）
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { build, listKeys, naturalCompare, pairDryWet, clipName } = require("../../scripts/niko-build");
const { readAls, listTracks, countScenes } = require("../../scripts/als");

// 最小の SMF（フォーマット 0、PPQ 96）。cc を渡すと CC64 を先頭と終わりに入れる
function varlen(n) {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return Buffer.from(bytes);
}
function midi({ pedal = false } = {}) {
  const ev = [];
  if (pedal) ev.push([0, 0xb0, 64, 127]);
  ev.push([0, 0x90, 60, 100], [96, 0x80, 60, 64]);
  if (pedal) ev.push([0, 0xb0, 64, 0]);
  ev.push([0, 0xff, 0x2f, 0]);
  const body = Buffer.concat(ev.map(([d, ...b]) => Buffer.concat([varlen(d), Buffer.from(b)])));
  const track = Buffer.concat([Buffer.from("MTrk"), Buffer.from([0, 0, 0, body.length]), body]);
  const header = Buffer.concat([Buffer.from("MThd"), Buffer.from([0, 0, 0, 6, 0, 0, 0, 1, 0, 96])]);
  return Buffer.concat([header, track]);
}
function put(p, opts) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, midi(opts));
}

const KEY = "C Major - A Minor";

// 本物と同じ形の小さなライブラリを作る
function fakeLibrary(root) {
  const key = path.join(root, "Niko_MIDI_Pack", KEY);
  // 1 - Best Ideas: 番号 + ムード + BPM のフォルダに Chords / WDRY / WET
  for (const [dir, n] of [["1 _Dark_Cinematic_94BPM", 1], ["2_Sexy_Jazz_125BPM", 2], ["3_No_Bpm_Here", 3]]) {
    const d = path.join(key, "1 - Best Ideas", dir);
    put(path.join(d, `Niko_Kotoulas_Chords_${n}.mid`));
    put(path.join(d, `Niko_Kotoulas_Idea_${n}_WDRY.mid`));
    put(path.join(d, `Niko_Kotoulas_Idea_${n}_WET.mid`), { pedal: true });
  }
  // 3 - Best Melodies: ジャンルのフォルダ。Favorites は Catchy と同名ファイルを再掲する
  for (const g of ["Catchy", "Niko's Favorites"]) {
    put(path.join(key, "3 - Best Melodies", g, "Niko_Kotoulas_Catchy_Melody_2_F-C_DRY.mid"));
    put(path.join(key, "3 - Best Melodies", g, "Niko_Kotoulas_Catchy_Melody_2_F-C_WET.mid"), { pedal: true });
  }
  put(path.join(key, "3 - Best Melodies", "Catchy", "Niko_Kotoulas_Catchy_Melody_10_G-D_DRY.mid"));
  put(path.join(key, "3 - Best Melodies", "Catchy", "Niko_Kotoulas_Catchy_Melody_10_G-D_WET.mid"), { pedal: true });
  // 4 - Top 100 Chord Progs
  put(path.join(key, "4 - Top 100 Chord Progs", "1-25", "1_Beautiful_Dm9-Am9_Niko_Kotoulas.mid"));
  // 6 - Chord Builder
  put(path.join(key, "6 - Chord Builder", "1 - Beautiful", "C Major9.mid"));
  put(path.join(key, "6 - Chord Builder", "22 - Advanced", "A Minor7.mid"));
  // 2000 パック（キー名のフォルダが番号レンジの下にある）
  put(path.join(root, "2000_NikoChord_Pack", "101-150", KEY, "Chords", "101_F-C-G_Niko_Kotoulas.mid"));
  return root;
}

function out(root) { return path.join(root, "out"); }
function setPath(root, name) { return path.join(out(root), `${KEY} Project`, name); }

test("キーを列挙し、キーごとに 1 プロジェクトへ書く（#20）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niko-"));
  fakeLibrary(root);
  assert.deepStrictEqual(listKeys(root), [KEY]);
  const r = build({ libRoot: root, outRoot: out(root) });
  assert.deepStrictEqual(r.map((x) => x.name), ["01_Ideas", "02_Chords", "03_Melodies", "04_Palette"]);
  assert.ok(fs.existsSync(path.join(out(root), `${KEY} Project`, "Ableton Project Info")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("01_Ideas は Chords / Chords Pad / DRY / WET の 4 列で、シーンにアイデアの BPM が入る（#20）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niko-"));
  fakeLibrary(root);
  build({ libRoot: root, outRoot: out(root), sets: ["01"] });
  const xml = readAls(setPath(root, "01_Ideas.als"));

  assert.deepStrictEqual(
    listTracks(xml).filter((t) => t.tag === "MidiTrack").map((t) => t.name),
    ["Chords", "Chords Pad", "Idea DRY", "Idea WET"]);
  assert.strictEqual(countScenes(xml), 3);

  const scenes = [...xml.matchAll(/<Scene Id="\d+">[\s\S]*?<Name Value="([^"]*)"[\s\S]*?<Tempo Value="([^"]*)" \/>\s*<IsTempoEnabled Value="(\w+)"/g)]
    .map((m) => [m[1], m[2], m[3]]);
  assert.deepStrictEqual(scenes, [
    ["01 Dark Cinematic", "94", "true"],
    ["02 Sexy Jazz", "125", "true"],
    ["03 No Bpm Here", "120", "false"], // BPM がフォルダ名に無ければシーンテンポは無効のまま
  ]);

  const tracks = listTracks(xml).filter((t) => t.tag === "MidiTrack");
  const body = (t) => xml.slice(t.start, t.end);
  // ペダルは WET の列にだけ乗る
  assert.strictEqual(/<ClipEnvelope /.test(body(tracks[0])), false, "Chords 列にペダルは無い");
  assert.strictEqual(/<ClipEnvelope /.test(body(tracks[2])), false, "DRY 列にペダルは無い");
  assert.ok(/<ClipEnvelope /.test(body(tracks[3])), "WET 列にペダルが乗る");

  // 楽器: コードのパッド列だけ Drift、他はピアノ（Simpler）
  const inst = (t) => (/<Devices>\s*<([A-Za-z][\w.]*)/.exec(body(t)) || [])[1] || "なし";
  assert.deepStrictEqual(tracks.map(inst), ["OriginalSimpler", "Drift", "OriginalSimpler", "OriginalSimpler"]);
  // プリセット由来の MIDI マッピングは残さない（残すと Live が落ちる。#22）
  assert.strictEqual(/<KeyMidi>/.test(xml), false);

  // Chords Pad は Chords と同じクリップを同じ行に持つ（シーンを発火すると重なる）
  const names = (t) => [...body(t).matchAll(/<MidiClip[\s\S]*?<Name Value="([^"]*)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(names(tracks[1]), names(tracks[0]));
  fs.rmSync(root, { recursive: true, force: true });
});

test("同名ファイルを別フォルダに再掲していても落とさない（#20）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niko-"));
  fakeLibrary(root);
  const [r] = build({ libRoot: root, outRoot: out(root), sets: ["03"] });
  // Catchy に 2 素材、Favorites に 1 素材 → 3 行 × DRY/WET = 6 クリップ
  assert.strictEqual(r.scenes, 8, "行が 8 未満でもシーンは 8 行確保する");
  assert.strictEqual(r.clips, 6);
  fs.rmSync(root, { recursive: true, force: true });
});

test("pairDryWet はフォルダごとに素材を分け、DRY と WET を同じ行に置く", () => {
  const base = "/lib";
  const files = [
    "/lib/Catchy/A_DRY.mid", "/lib/Catchy/A_WET.mid",
    "/lib/Favorites/A_DRY.mid", "/lib/Favorites/A_WET.mid",
    "/lib/Catchy/B_DRY.mid",
  ];
  const r = pairDryWet(files, base);
  assert.strictEqual(r.dry.length, 3);
  assert.deepStrictEqual(r.dry.map((f) => f && path.relative(base, f)),
    ["Catchy/A_DRY.mid", "Catchy/B_DRY.mid", "Favorites/A_DRY.mid"]);
  assert.deepStrictEqual(r.wet.map((f) => f && path.relative(base, f)),
    ["Catchy/A_WET.mid", null, "Favorites/A_WET.mid"]);
  // ベースを渡さなければ従来通り名前だけで束ねる
  assert.strictEqual(pairDryWet(files).dry.length, 2);
});

test("並び順は数字を数として見る", () => {
  const a = ["Melody_10", "Melody_2", "Melody_1"].sort(naturalCompare);
  assert.deepStrictEqual(a, ["Melody_1", "Melody_2", "Melody_10"]);
});

test("クリップ名から作者名と DRY / WET を落とす", () => {
  assert.strictEqual(clipName("/x/Niko_Kotoulas_Emotional_Melody_1_Am-G_100-140bpm_DRY.mid"), "Emotional_Melody_1_Am-G_100-140bpm");
  assert.strictEqual(clipName("/x/1_Beautiful_Dm9-Am9_Niko_Kotoulas.mid"), "1_Beautiful_Dm9-Am9");
});

test("--no-instruments なら楽器を載せない（#22）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niko-"));
  fakeLibrary(root);
  build({ libRoot: root, outRoot: out(root), sets: ["01"], instruments: false });
  const xml = readAls(setPath(root, "01_Ideas.als"));
  const tracks = listTracks(xml).filter((t) => t.tag === "MidiTrack");
  assert.deepStrictEqual(tracks.map((t) => /<Devices \/>/.test(xml.slice(t.start, t.end))), [true, true, true, true]);
  fs.rmSync(root, { recursive: true, force: true });
});
