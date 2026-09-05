"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { LiveBridge } = require("../src/bridge");

test("call は対応する id のレスポンスで解決する", async () => {
  let sent;
  const bridge = new LiveBridge((json) => {
    sent = JSON.parse(json);
  });
  const promise = bridge.call("ping", { a: 1 });
  assert.equal(sent.op, "ping");
  assert.deepEqual(sent.args, { a: 1 });
  bridge.handleResponse(JSON.stringify({ id: sent.id, ok: true, result: { pong: true } }));
  assert.deepEqual(await promise, { pong: true });
  assert.equal(bridge.pendingCount, 0);
});

test("エラーレスポンスは reject になる", async () => {
  let sent;
  const bridge = new LiveBridge((json) => (sent = JSON.parse(json)));
  const promise = bridge.call("read_set");
  bridge.handleResponse(JSON.stringify({ id: sent.id, ok: false, error: "boom" }));
  await assert.rejects(promise, /boom/);
});

test("タイムアウトすると reject になる", async () => {
  const bridge = new LiveBridge(() => {}, { timeoutMs: 30 });
  await assert.rejects(bridge.call("ping"), /応答なし/);
});

test("send が throw したら即 reject", async () => {
  const bridge = new LiveBridge(() => {
    throw new Error("no max");
  });
  await assert.rejects(bridge.call("ping"), /no max/);
  assert.equal(bridge.pendingCount, 0);
});

test("未知の id や不正 JSON は無視する", () => {
  const bridge = new LiveBridge(() => {});
  assert.equal(bridge.handleResponse("not json"), false);
  assert.equal(bridge.handleResponse(JSON.stringify({ id: 999, ok: true })), false);
});
