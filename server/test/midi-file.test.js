// scripts/midi-file.js — Standard MIDI File からノートを読む
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseMidi } = require("../../scripts/midi-file");

// 最小の SMF（フォーマット 0、PPQ 96）を組み立てる
function varlen(n) {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return Buffer.from(bytes);
}
function smf(events, ppq = 96) {
  const body = Buffer.concat(events.map(([delta, ...b]) => Buffer.concat([varlen(delta), Buffer.from(b)])));
  const track = Buffer.concat([Buffer.from("MTrk"), Buffer.from([0, 0, 0, body.length]), body]);
  const header = Buffer.concat([Buffer.from("MThd"), Buffer.from([0, 0, 0, 6, 0, 0, 0, 1, ppq >> 8, ppq & 0xff])]);
  return Buffer.concat([header, track]);
}

test("ノートオン/オフを拍に直し、ランニングステータスも読める", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "midi-"));
  const f = path.join(dir, "a.mid");
  fs.writeFileSync(f, smf([
    [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20],   // テンポ（無視される）
    [0, 0x90, 60, 100],                     // C4 on @0
    [96, 0x90, 60, 0],                      // off @1 拍（vel 0 = off、ランニングステータス）
    [0, 0x90, 64, 80],                      // E4 on @1
    [48, 0x80, 64, 64],                     // off @1.5
    [0, 0xff, 0x2f, 0],                     // End of Track
  ]));
  const r = parseMidi(f);
  assert.strictEqual(r.ppq, 96);
  assert.deepStrictEqual(r.notes, [
    { pitch: 60, time: 0, duration: 1, velocity: 100 },
    { pitch: 64, time: 1, duration: 0.5, velocity: 80 },
  ]);
  assert.strictEqual(r.beats, 1.5);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("MIDI でないファイルは失敗する", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "midi-"));
  const f = path.join(dir, "x.mid");
  fs.writeFileSync(f, Buffer.from("RIFF...."));
  assert.throws(() => parseMidi(f), /MIDI ファイルではありません/);
  fs.rmSync(dir, { recursive: true, force: true });
});
