#!/usr/bin/env node
// Standard MIDI File（.mid）からノートだけを読む。
//
//   notes … [{ pitch, time, duration, velocity }]  time / duration は拍（4 分音符 = 1）
//   beats … 最後のノートが終わる拍
//
// Live の MidiClip は拍で持つのでテンポは無視する（クリップはセットのテンポで鳴る）。
// フォーマット 0 / 1 の両方、ランニングステータス、複数トラックの合成に対応。
"use strict";

const fs = require("node:fs");

function readVarLen(buf, pos) {
  let value = 0;
  let b;
  do {
    b = buf[pos++];
    value = (value << 7) | (b & 0x7f);
  } while (b & 0x80);
  return [value, pos];
}

function parseTrack(buf, start, end, ppq, notes) {
  let pos = start;
  let tick = 0;
  let status = 0;
  const open = new Map(); // "ch:pitch" → { tick, velocity }

  while (pos < end) {
    let delta;
    [delta, pos] = readVarLen(buf, pos);
    tick += delta;
    let b = buf[pos];
    if (b & 0x80) { status = b; pos++; }
    const type = status & 0xf0;
    const ch = status & 0x0f;

    if (status === 0xff) { // メタ
      const meta = buf[pos++];
      let len; [len, pos] = readVarLen(buf, pos);
      pos += len;
      if (meta === 0x2f) break; // End of Track
      continue;
    }
    if (status === 0xf0 || status === 0xf7) { // SysEx
      let len; [len, pos] = readVarLen(buf, pos);
      pos += len;
      continue;
    }
    if (type === 0x90 || type === 0x80) {
      const pitch = buf[pos++], vel = buf[pos++];
      const key = `${ch}:${pitch}`;
      if (type === 0x90 && vel > 0) {
        open.set(key, { tick, velocity: vel });
      } else {
        const on = open.get(key);
        if (on) {
          open.delete(key);
          notes.push({ pitch, time: on.tick / ppq, duration: Math.max(1, tick - on.tick) / ppq, velocity: on.velocity });
        }
      }
      continue;
    }
    if (type === 0xa0 || type === 0xb0 || type === 0xe0) { pos += 2; continue; }
    if (type === 0xc0 || type === 0xd0) { pos += 1; continue; }
    throw new Error(`不明なステータス 0x${status.toString(16)} at ${pos}`);
  }
  // 終端の無いノートは打ち切る
  for (const [key, on] of open) {
    notes.push({ pitch: Number(key.split(":")[1]), time: on.tick / ppq, duration: 0.25, velocity: on.velocity });
  }
}

function parseMidi(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "MThd") throw new Error("MIDI ファイルではありません: " + file);
  const headerLen = buf.readUInt32BE(4);
  const ntracks = buf.readUInt16BE(10);
  const division = buf.readUInt16BE(12);
  if (division & 0x8000) throw new Error("SMPTE タイムベースは未対応: " + file);
  const ppq = division;

  const notes = [];
  let pos = 8 + headerLen;
  for (let i = 0; i < ntracks && pos + 8 <= buf.length; i++) {
    if (buf.toString("ascii", pos, pos + 4) !== "MTrk") throw new Error("MTrk が見つかりません: " + file);
    const len = buf.readUInt32BE(pos + 4);
    parseTrack(buf, pos + 8, pos + 8 + len, ppq, notes);
    pos += 8 + len;
  }
  notes.sort((a, b) => a.time - b.time || a.pitch - b.pitch);
  const beats = notes.reduce((m, n) => Math.max(m, n.time + n.duration), 0);
  return { ppq, notes, beats };
}

module.exports = { parseMidi };

if (require.main === module) {
  for (const f of process.argv.slice(2)) {
    const r = parseMidi(f);
    console.log(f, `ppq ${r.ppq} / notes ${r.notes.length} / ${r.beats.toFixed(2)} 拍`);
  }
}
