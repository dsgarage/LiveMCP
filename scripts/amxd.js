// .amxd（Max for Live デバイス）の読み書き。
//
// .amxd は「4 バイトのチャンク ID + リトルエンディアン uint32 のサイズ + ペイロード」を
// 並べただけの単純な形式で、中身の patcher は素の .maxpat JSON。
//
//   ampf : 4 バイト。デバイス種別（aaaa=Audio Effect / iiii=Instrument / mmmm=MIDI Effect）
//   meta : 4 バイト。ゼロ埋め
//   ptch : patcher JSON（末尾に NUL 終端が入る）
//
// Live 12.4.3 同梱の "Max Audio Effect.amxd" 等を解析して確認した（Issue #7）。
"use strict";

const fs = require("node:fs");

const DEVICE_TYPES = {
  audio_effect: "aaaa",
  instrument: "iiii",
  midi_effect: "mmmm",
};

/** チャンク列を組み立てて Buffer にする */
function packChunks(chunks) {
  const parts = [];
  for (const [id, payload] of chunks) {
    const header = Buffer.alloc(8);
    header.write(id, 0, 4, "latin1");
    header.writeUInt32LE(payload.length, 4);
    parts.push(header, payload);
  }
  return Buffer.concat(parts);
}

/** .amxd バイナリをチャンクへ分解する */
function unpackChunks(buf) {
  const chunks = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("latin1", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (off + 8 + size > buf.length) {
      throw new Error(`チャンク ${id} のサイズ ${size} がファイル長を超えています`);
    }
    chunks.push([id, buf.subarray(off + 8, off + 8 + size)]);
    off += 8 + size;
  }
  if (off !== buf.length) {
    throw new Error(`末尾に ${buf.length - off} バイトの余りがあります`);
  }
  return chunks;
}

/**
 * patcher JSON テキストから .amxd の Buffer を作る
 * @param {string} patcherJson .maxpat の中身（テキストのまま埋め込む）
 * @param {string} deviceType DEVICE_TYPES のキー
 */
function buildAmxd(patcherJson, deviceType = "audio_effect") {
  const marker = DEVICE_TYPES[deviceType];
  if (!marker) {
    throw new Error(`未知のデバイス種別: ${deviceType}（${Object.keys(DEVICE_TYPES).join(" / ")}）`);
  }
  const body = patcherJson.endsWith("\n") ? patcherJson : patcherJson + "\n";
  return packChunks([
    ["ampf", Buffer.from(marker, "latin1")],
    ["meta", Buffer.alloc(4)],
    ["ptch", Buffer.concat([Buffer.from(body, "utf8"), Buffer.alloc(1)])],
  ]);
}

/** .amxd から patcher JSON テキストを取り出す */
function extractPatcher(buf) {
  for (const [id, payload] of unpackChunks(buf)) {
    if (id === "ptch") {
      let end = payload.length;
      while (end > 0 && payload[end - 1] === 0) end--;
      return payload.toString("utf8", 0, end);
    }
  }
  throw new Error("ptch チャンクが見つかりません");
}

/** .amxd のデバイス種別マーカーを返す */
function deviceTypeOf(buf) {
  for (const [id, payload] of unpackChunks(buf)) {
    if (id === "ampf") return payload.toString("latin1");
  }
  throw new Error("ampf チャンクが見つかりません");
}

/**
 * 既存の .amxd を読み直して同じバイト列を再生成できるか検証する。
 * 書き出しロジックが Live の実装と一致していることの裏取りに使う。
 */
function verifyRoundTrip(amxdPath) {
  const original = fs.readFileSync(amxdPath);
  const marker = deviceTypeOf(original);
  const type = Object.keys(DEVICE_TYPES).find((k) => DEVICE_TYPES[k] === marker);
  if (!type) throw new Error(`未知のデバイス種別マーカー: ${marker}`);
  const rebuilt = buildAmxd(extractPatcher(original), type);
  return { ok: rebuilt.equals(original), type, size: original.length, rebuiltSize: rebuilt.length };
}

module.exports = {
  DEVICE_TYPES,
  buildAmxd,
  extractPatcher,
  deviceTypeOf,
  unpackChunks,
  packChunks,
  verifyRoundTrip,
};
