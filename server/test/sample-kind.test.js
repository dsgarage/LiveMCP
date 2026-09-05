// scripts/sample-kind.js — WAV 1 本がループかワンショットかをファイル自体から判定する
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { classifySample, decideKind, beatsFit } = require("../../scripts/sample-kind");
const { audioInfo } = require("../../scripts/audio-info");

// 音の入った偽 WAV。amp(t) は 0〜1 の位置に対する包絡。extra はチャンクを足す
function toneWav(seconds, amp, { rate = 44100, bits = 16, extra = Buffer.alloc(0) } = {}) {
  const frames = Math.round(seconds * rate);
  const bps = bits / 8;
  const data = Buffer.alloc(frames * 2 * bps);
  for (let i = 0; i < frames; i++) {
    const x = Math.sin((i / rate) * 220 * 2 * Math.PI) * amp(i / frames);
    for (let c = 0; c < 2; c++) {
      const o = (i * 2 + c) * bps;
      if (bits === 16) data.writeInt16LE(Math.round(x * 20000), o);
      else { const v = Math.round(x * 5000000); data[o] = v & 0xff; data[o + 1] = (v >> 8) & 0xff; data[o + 2] = (v >> 16) & 0xff; }
    }
  }
  const b = Buffer.alloc(36);
  b.write("RIFF", 0); b.writeUInt32LE(28 + extra.length + 8 + data.length, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2 * bps, 28); b.writeUInt16LE(2 * bps, 32); b.writeUInt16LE(bits, 34);
  const d = Buffer.alloc(8); d.write("data", 0); d.writeUInt32LE(data.length, 4);
  return Buffer.concat([b, extra, d, data]);
}

// acid チャンク: type(4) root(2) unk(2) unk(4) beats(4) meterDen(2) meterNum(2) tempo(f32)
function acidChunk({ oneShot, beats, tempo }) {
  const b = Buffer.alloc(8 + 24);
  b.write("acid", 0); b.writeUInt32LE(24, 4);
  b.writeUInt32LE(oneShot ? 1 : 0, 8); b.writeUInt16LE(60, 12); b.writeUInt16LE(0x8000, 14);
  b.writeUInt32LE(beats, 20); b.writeUInt16LE(4, 24); b.writeUInt16LE(4, 26); b.writeFloatLE(tempo, 28);
  return b;
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kind-"));

test("減衰して無音で終わる短い音はワンショット、小節ぴったりで切りっぱなしの音はループ", () => {
  const dir = tmp();
  const hit = path.join(dir, "X_Snap_3.wav");
  fs.writeFileSync(hit, toneWav(0.35, (t) => Math.exp(-10 * t)));
  const h = classifySample(hit);
  assert.strictEqual(h.kind, "oneshot");
  assert.ok(h.confidence >= 0.5, h.reasons.join(" / "));

  // 120 BPM で 8 拍 = 4.0 秒。名前に BPM を入れる
  const loop = path.join(dir, "X_120_Groove.wav");
  fs.writeFileSync(loop, toneWav(4.0, () => 1));
  const l = classifySample(loop);
  assert.strictEqual(l.kind, "loop");
  assert.ok(l.confidence >= 0.5, l.reasons.join(" / "));
  assert.ok(l.reasons.some((r) => /8 拍ちょうど/.test(r)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("acid チャンクのワンショットフラグはベンダーの正解として最優先", () => {
  const dir = tmp();
  // 波形はループに見える（4 秒・切りっぱなし）が、acid が one-shot と言っている
  const f = path.join(dir, "X_120_Thing.wav");
  fs.writeFileSync(f, toneWav(4.0, () => 1, { extra: acidChunk({ oneShot: true, beats: 0, tempo: 120 }) }));
  const info = audioInfo(f);
  assert.strictEqual(info.acidOneShot, true);
  assert.strictEqual(info.acidTempo, 120);
  const r = classifySample(f);
  assert.ok(r.reasons.some((x) => /acid: one-shot/.test(x)));
  // 逆に acid がループと言えば、短めでもループ側へ寄る
  const g = path.join(dir, "X_Other.wav");
  fs.writeFileSync(g, toneWav(1.0, () => 1, { extra: acidChunk({ oneShot: false, beats: 2, tempo: 120 }) }));
  assert.strictEqual(classifySample(g).kind, "loop");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("FX 系の名前なら長さと拍の証拠は使わない（ライザーは小節に合わせて長い）", () => {
  const dir = tmp();
  // 128 BPM で 16 拍 = 7.5 秒、末尾が最大音量 → 波形だけ見ればループ
  const f = path.join(dir, "X_FX_Riser_128.wav");
  fs.writeFileSync(f, toneWav(7.5, (t) => 0.2 + 0.8 * t));
  const r = classifySample(f);
  assert.strictEqual(r.kind, "oneshot", r.reasons.join(" / "));
  assert.ok(!r.reasons.some((x) => /拍ちょうど/.test(x)));
  // ただしループ語が同居していればループ語を信じる
  const g = path.join(dir, "X_Combo_128_Fx_8Bar.wav");
  fs.writeFileSync(g, toneWav(7.5, (t) => 0.2 + 0.8 * t));
  assert.strictEqual(classifySample(g).kind, "loop");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("フォルダ名が FX 系・マルチサンプルなら、名前に無くてもその証拠を使う", () => {
  const dir = tmp();
  // 15 秒・末尾が最大音量のアップリフター。名前には FX の語が無い
  const f = path.join(dir, "UFE_Block_E.wav");
  fs.writeFileSync(f, toneWav(15, (t) => 0.2 + 0.8 * t));
  assert.strictEqual(classifySample(f).kind, "loop"); // フォルダのヒント無しではループに見える
  const r = classifySample(f, { dir: "UFE_SOUNDS_AND_FX/UFE_UPLIFTERS" });
  assert.strictEqual(r.kind, "oneshot", r.reasons.join(" / "));
  // マルチサンプル: 音名が途中にある / フォルダが MULTIS
  const g = path.join(dir, "TR1_A1_Cave_Synth.wav");
  fs.writeFileSync(g, toneWav(3, () => 1));
  assert.ok(classifySample(g).reasons.some((x) => /音名付き/.test(x)));
  const h = path.join(dir, "TR1_Cave_Synth.wav");
  fs.writeFileSync(h, toneWav(3, () => 1));
  assert.ok(classifySample(h, { dir: "TR1_SYNTH_MULTIS/TR1_Cave_Synth" }).reasons.some((x) => /マルチサンプルのフォルダ/.test(x)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("24bit と AIFF も読める", () => {
  const dir = tmp();
  const f = path.join(dir, "X_Clap.wav");
  fs.writeFileSync(f, toneWav(0.3, (t) => Math.exp(-10 * t), { bits: 24 }));
  assert.strictEqual(classifySample(f).kind, "oneshot");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("フォルダ分類は事前情報として足す。明示は ±0.4、弱いものは ±0.2。逆転と迷いを印にする", () => {
  const d1 = decideKind({ score: 0.1 }, "oneshot", "explicit");
  assert.deepStrictEqual(d1, { kind: "oneshot", final: -0.3, flipped: false, uncertain: false, tagged: false });
  const d2 = decideKind({ score: -0.6 }, "loop", "weak");
  assert.strictEqual(d2.kind, "oneshot");
  assert.strictEqual(d2.flipped, true);
  const d3 = decideKind({ score: 0 }, "loop", "weak");
  assert.strictEqual(d3.kind, "loop");
  assert.strictEqual(d3.uncertain, true);
  // どちらの手がかりも無ければループ扱い
  assert.strictEqual(decideKind({ score: 0 }, null).kind, "loop");
});

test("Loopcloud の種別タグがあれば正解として最優先。フォルダ分類を足しても覆らない", () => {
  const dir = tmp();
  // 波形だけ見ればループ（4 秒・切りっぱなし・8 拍ちょうど）だが、Loopcloud は One Shots と言っている
  const f = path.join(dir, "X_120_Thing.wav");
  fs.writeFileSync(f, toneWav(4.0, () => 1));
  const r = classifySample(f, { loopcloud: { contentType: "oneshot", instrument: ["Effects", "Riser"], bpm: null } });
  assert.strictEqual(r.kind, "oneshot");
  assert.strictEqual(r.tagged, true);
  assert.ok(r.reasons[0].includes("Loopcloud: One Shots（Effects > Riser）"));
  const d = decideKind(r, "loop", "explicit");
  assert.strictEqual(d.kind, "oneshot");
  assert.strictEqual(d.flipped, true);
  // タグの無い項目（contentType null）は今までどおり
  const r2 = classifySample(f, { loopcloud: { contentType: null, bpm: 120 } });
  assert.strictEqual(r2.tagged, false);
  assert.strictEqual(r2.kind, "loop");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("beatsFit: 拍の整数倍かどうか", () => {
  assert.strictEqual(beatsFit(4.0, 120).fits, true);
  assert.strictEqual(beatsFit(4.0, 120).nearest, 8);
  assert.strictEqual(beatsFit(4.1, 120).fits, false);
  assert.strictEqual(beatsFit(4.0, null), null);
});
