// scripts/sample-meta.js と scripts/audio-info.js — ファイル名の解釈とヘッダ読み取り
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseSampleName, compareSamples, dominantBpm } = require("../../scripts/sample-meta");
const { audioInfo } = require("../../scripts/audio-info");

test("ベンダーごとの命名から BPM とキーを読む", () => {
  const cases = [
    ["HD_808Loop_155_E_ColdHearted_FRK.wav", 155, "E"],
    ["SMD_60_Bb_Oceanic_FX_Atmos.wav", 60, "Bb"],
    ["HD_DrumBuild_155_Attack_FRK.wav", 155, null],
    ["SEP5_Song_01_F_130_BPM", 130, "F"],
    ["TTS_THC_Deathrash_Clean_Electric_Guitar_Right_C_BPM195_08.wav", 195, "C"],
    ["Life-Beat 2026-06-06_142109 - 128 bpm.wav", 128, null],
    ["HD_Melodic_Fm_OhMyPad_FRK.wav", null, "Fm"],
    ["HD_Kick_TheSoftest_FRK.wav", null, null],
    ["SEPT2_01_93_bpm_D.wav", 93, "D"], // bpm の語を挟んだ隣のキー
    ["SEPT3_Piano_01_D#_80_Bpm.wav", 80, "D#"],
  ];
  for (const [name, bpm, key] of cases) {
    const r = parseSampleName(name);
    assert.strictEqual(r.bpm, bpm, name + " の BPM");
    assert.strictEqual(r.key, key, name + " のキー");
  }
});

test("並び順はテンポ → キー → 名前", () => {
  const names = ["X_155_E_b.wav", "X_120_C_a.wav", "X_155_C_a.wav", "X_155_E_a.wav", "X_nobpm.wav"];
  const sorted = names.map(parseSampleName).sort(compareSamples).map((s) => s.stem);
  assert.deepStrictEqual(sorted, ["X_nobpm", "X_120_C_a", "X_155_C_a", "X_155_E_a", "X_155_E_b"]);
});

test("支配的な BPM をセットのテンポにする", () => {
  const list = ["a_155.wav", "b_155.wav", "c_120.wav", "d.wav"].map(parseSampleName);
  assert.strictEqual(dominantBpm(list), 155);
  assert.strictEqual(dominantBpm([parseSampleName("d.wav")]), 120);
});

test("セットのテンポ: 最多が過半数ならそれ、そうでなければ中央値", () => {
  const { centralBpm } = require("../../scripts/sample-meta");
  const b = (...xs) => xs.map((bpm) => ({ bpm }));
  assert.strictEqual(centralBpm(b(155, 155, 120)), 155);                       // 過半数
  assert.strictEqual(centralBpm(b(200, 200, 79, 90, 110, 125, 160, 90)), 125); // 200 が最多でも 25% → 中央値（偶数個は上側）
  assert.strictEqual(centralBpm(b(120, 120, 90, 90, 100)), 100);               // 同数なら中央値
  assert.strictEqual(centralBpm(b(null, null)), 120);
});

// 最小の WAV / AIFF を書いてヘッダ読み取りを確かめる
function wav(frames, rate = 44100, ch = 2, bits = 16) {
  const data = Buffer.alloc(frames * ch * (bits / 8));
  const b = Buffer.alloc(44);
  b.write("RIFF", 0); b.writeUInt32LE(36 + data.length, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(ch, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * ch * (bits / 8), 28); b.writeUInt16LE(ch * (bits / 8), 32); b.writeUInt16LE(bits, 34);
  b.write("data", 36); b.writeUInt32LE(data.length, 40);
  return Buffer.concat([b, data]);
}
function aiff(frames, rate = 48000, ch = 1, bits = 24) {
  const comm = Buffer.alloc(18);
  comm.writeUInt16BE(ch, 0); comm.writeUInt32BE(frames, 2); comm.writeUInt16BE(bits, 6);
  // 80bit 拡張精度で 48000 = 0x400E BB80000000000000
  Buffer.from("400ebb80000000000000", "hex").copy(comm, 8);
  const b = Buffer.alloc(12 + 8);
  b.write("FORM", 0); b.writeUInt32BE(4 + 8 + 18, 4); b.write("AIFF", 8); b.write("COMM", 12); b.writeUInt32BE(18, 16);
  return Buffer.concat([b, comm]);
}

test("WAV と AIFF のヘッダからフレーム数とサンプルレートを読む", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-info-"));
  fs.writeFileSync(path.join(dir, "a.wav"), wav(546271));
  fs.writeFileSync(path.join(dir, "b.aif"), aiff(51213));
  const a = audioInfo(path.join(dir, "a.wav"));
  assert.strictEqual(a.frames, 546271); assert.strictEqual(a.sampleRate, 44100); assert.strictEqual(a.channels, 2);
  const b = audioInfo(path.join(dir, "b.aif"));
  assert.strictEqual(b.frames, 51213); assert.strictEqual(b.sampleRate, 48000); assert.strictEqual(b.bits, 24);
  fs.writeFileSync(path.join(dir, "x.wav"), Buffer.from("not audio"));
  assert.strictEqual(audioInfo(path.join(dir, "x.wav")), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
