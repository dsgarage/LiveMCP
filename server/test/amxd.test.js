"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildAmxd,
  extractPatcher,
  deviceTypeOf,
  unpackChunks,
  verifyRoundTrip,
} = require("../../scripts/amxd");

const MAXPAT = path.resolve(__dirname, "../../device/LiveMCP.maxpat");

// Live 同梱の純正デバイス。無い環境（CI 等）ではスキップする。
const FACTORY = [
  "Max Audio Effect",
  "Max Instrument",
  "Max MIDI Effect",
].map((n) => `/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Misc/Max Devices/${n}.amxd`);

test("ampf / meta / ptch の 3 チャンクを書き出す", () => {
  const buf = buildAmxd('{"patcher":{}}\n', "audio_effect");
  const chunks = unpackChunks(buf);
  assert.deepEqual(chunks.map(([id]) => id), ["ampf", "meta", "ptch"]);
  assert.equal(deviceTypeOf(buf), "aaaa");
  assert.equal(extractPatcher(buf), '{"patcher":{}}\n');
});

test("デバイス種別マーカーが種別ごとに変わる", () => {
  assert.equal(deviceTypeOf(buildAmxd("{}\n", "instrument")), "iiii");
  assert.equal(deviceTypeOf(buildAmxd("{}\n", "midi_effect")), "mmmm");
  assert.throws(() => buildAmxd("{}\n", "bogus"), /未知のデバイス種別/);
});

test("ptch は NUL 終端される", () => {
  const buf = buildAmxd("{}\n", "audio_effect");
  const ptch = unpackChunks(buf).find(([id]) => id === "ptch")[1];
  assert.equal(ptch[ptch.length - 1], 0);
});

test("LiveMCP.maxpat は M4L デバイスとして妥当な patcher である", () => {
  const patcher = JSON.parse(fs.readFileSync(MAXPAT, "utf8")).patcher;
  const texts = patcher.boxes.map((b) => b.box.text || "");

  // Audio Effect は plugin~ / plugout~ が無いとオーディオが素通ししない
  assert.ok(texts.includes("plugin~"), "plugin~ が無い");
  assert.ok(texts.includes("plugout~"), "plugout~ が無い");

  // LiveAPI は low-priority thread でしか生成できないため deferlow が必須
  assert.ok(texts.includes("deferlow"), "deferlow が無い");

  // node.script の script サブコマンドは npm/processStatus/reboot/running/status/start/stop のみ。
  // 任意メッセージは素通しで Node のハンドラに届くので "script send" は誤り。
  for (const t of texts) {
    assert.ok(!/^script\s+send\b/.test(t), `存在しないコマンドを使っている: ${t}`);
  }

  const nodeBox = texts.find((t) => t.startsWith("node.script"));
  assert.match(nodeBox, /^node\.script livemcp-server\.js\b/);

  // ブリッジは js オブジェクトで動かす。v8.mxo は extensions/ にあり
  // Live 組み込みの Max ランタイムでは読み込まれないため、Live 内では無応答になる。
  assert.ok(texts.some((t) => t.startsWith("js livemcp-bridge.js")), "js ブリッジが無い");
  assert.ok(!texts.some((t) => /^v8[ .]/.test(t)), "v8 は Live 内で動かないので使わない");
});

test("LiveMCP.maxpat の配線が node.script → deferlow → js → node.script になっている", () => {
  const patcher = JSON.parse(fs.readFileSync(MAXPAT, "utf8")).patcher;
  const idOf = (prefix) =>
    patcher.boxes.find((b) => (b.box.text || "").startsWith(prefix)).box.id;
  const nodeId = idOf("node.script");
  const deferId = idOf("deferlow");
  const bridgeId = idOf("js livemcp-bridge.js");
  const has = (src, dst) =>
    patcher.lines.some((l) => l.patchline.source[0] === src && l.patchline.destination[0] === dst);

  assert.ok(has(nodeId, deferId), "node.script → deferlow が無い");
  assert.ok(has(deferId, bridgeId), "deferlow → js ブリッジが無い");
  assert.ok(has(bridgeId, nodeId), "js ブリッジ → node.script が無い");
});

test("純正 .amxd をバイト単位で再生成できる", { skip: !fs.existsSync(FACTORY[0]) }, () => {
  for (const f of FACTORY) {
    if (!fs.existsSync(f)) continue;
    const r = verifyRoundTrip(f);
    assert.ok(r.ok, `${path.basename(f)} の再生成結果が原本と一致しない`);
  }
});
