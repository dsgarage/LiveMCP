#!/usr/bin/env node
// WAV / AIFF のヘッダから、.als のクリップ生成に要る値だけを読む。
//
//   frames      … サンプルフレーム数（Live の DefaultDuration / SampleEnd に使う）
//   sampleRate  … Hz（DefaultSampleRate）
//   channels / bits
//   acidTempo   … ACID / Loopmasters 系の WAV が持つ "acid" チャンクのテンポ（無ければ null）
//   acidOneShot … acid チャンクの type ビット 0（1 = ワンショット、0 = ループ）。チャンクが無ければ null
//   acidBeats   … acid チャンクの拍数（ループのとき有効）
//   dataOffset / dataBytes / formatTag / bigEndian … 音声データの所在（sample-kind.js が波形を読むのに使う）
//
// 音声データは読まない。ヘッダのチャンクを辿るだけなので 60,000 件でも速い。
"use strict";

const fs = require("node:fs");

function readWav(fd, size) {
  const head = Buffer.alloc(12);
  fs.readSync(fd, head, 0, 12, 0);
  if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") return null;
  let pos = 12;
  let fmt = null, dataBytes = null, dataOffset = null, acidTempo = null, acidOneShot = null, acidBeats = null;
  const ch = Buffer.alloc(8);
  while (pos + 8 <= size) {
    fs.readSync(fd, ch, 0, 8, pos);
    const id = ch.toString("ascii", 0, 4);
    const len = ch.readUInt32LE(4);
    if (id === "fmt ") {
      if (len < 16) return null; // fmt が短すぎる壊れたファイル（読めないものとして飛ばす）
      const b = Buffer.alloc(Math.min(len, 40));
      fs.readSync(fd, b, 0, b.length, pos + 8);
      let formatTag = b.readUInt16LE(0);
      // WAVE_FORMAT_EXTENSIBLE は SubFormat の先頭 2 バイトが実際のタグ
      if (formatTag === 0xfffe && b.length >= 26) formatTag = b.readUInt16LE(24);
      fmt = { channels: b.readUInt16LE(2), sampleRate: b.readUInt32LE(4), bits: b.readUInt16LE(14), formatTag };
    } else if (id === "data") {
      dataOffset = pos + 8;
      dataBytes = len === 0xffffffff ? size - pos - 8 : Math.min(len, size - pos - 8);
    } else if (id === "acid" && len >= 24) {
      // ACID チャンク: type(4) root(2) unknown(2) unknown(4) beats(4) meterDen(2) meterNum(2) tempo(float32)
      // type のビット 0 が 1 ならワンショット、0 ならループ
      const b = Buffer.alloc(24);
      fs.readSync(fd, b, 0, 24, pos + 8);
      acidOneShot = (b.readUInt32LE(0) & 1) === 1;
      acidBeats = b.readUInt32LE(12);
      const t = b.readFloatLE(20);
      if (t >= 40 && t <= 300) acidTempo = Math.round(t * 100) / 100;
    }
    if (fmt && dataBytes != null && acidTempo != null) break;
    pos += 8 + len + (len & 1);
  }
  if (!fmt || dataBytes == null) return null;
  const frameBytes = fmt.channels * (fmt.bits / 8);
  return { format: "wav", frames: Math.floor(dataBytes / frameBytes), acidTempo, acidOneShot, acidBeats, dataOffset, dataBytes, bigEndian: false, ...fmt };
}

// IEEE 754 80bit 拡張精度（AIFF の sampleRate）
function readExtended(b) {
  const sign = b[0] & 0x80 ? -1 : 1;
  const exp = ((b[0] & 0x7f) << 8) | b[1];
  const hi = b.readUInt32BE(2), lo = b.readUInt32BE(6);
  const mant = hi * 2 ** 32 + lo;
  if (exp === 0 && mant === 0) return 0;
  return sign * mant * 2 ** (exp - 16383 - 63);
}

function readAiff(fd, size) {
  const head = Buffer.alloc(12);
  fs.readSync(fd, head, 0, 12, 0);
  if (head.toString("ascii", 0, 4) !== "FORM") return null;
  const kind = head.toString("ascii", 8, 12);
  if (kind !== "AIFF" && kind !== "AIFC") return null;
  let pos = 12;
  const ch = Buffer.alloc(8);
  let comm = null, ssnd = null;
  while (pos + 8 <= size) {
    fs.readSync(fd, ch, 0, 8, pos);
    const id = ch.toString("ascii", 0, 4);
    const len = ch.readUInt32BE(4);
    if (id === "COMM") {
      const b = Buffer.alloc(Math.min(len, 22));
      fs.readSync(fd, b, 0, b.length, pos + 8);
      // AIFC の圧縮タイプ。"NONE" / "sowt"（リトルエンディアン）/ "fl32" 以外は波形を読まない
      const compression = kind === "AIFC" && b.length >= 22 ? b.toString("ascii", 18, 22) : "NONE";
      comm = {
        format: "aiff",
        channels: b.readUInt16BE(0),
        frames: b.readUInt32BE(2),
        bits: b.readUInt16BE(6),
        sampleRate: Math.round(readExtended(b.subarray(8, 18))),
        formatTag: compression === "fl32" || compression === "FL32" ? 3 : compression === "NONE" || compression === "sowt" ? 1 : 0,
        bigEndian: compression !== "sowt",
      };
    } else if (id === "SSND") {
      const b = Buffer.alloc(8);
      fs.readSync(fd, b, 0, 8, pos + 8);
      const offset = b.readUInt32BE(0);
      ssnd = { dataOffset: pos + 16 + offset, dataBytes: Math.min(len - 8 - offset, size - pos - 16 - offset) };
    }
    if (comm && ssnd) break;
    pos += 8 + len + (len & 1);
  }
  if (!comm) return null;
  return { ...comm, acidTempo: null, acidOneShot: null, acidBeats: null, ...(ssnd || { dataOffset: null, dataBytes: null }) };
}

function audioInfo(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, "r");
  try {
    const info = readWav(fd, size) || readAiff(fd, size);
    if (!info) return null;
    return { ...info, bytes: size, seconds: info.frames / info.sampleRate };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { audioInfo };

if (require.main === module) {
  for (const f of process.argv.slice(2)) console.log(f, audioInfo(f));
}
