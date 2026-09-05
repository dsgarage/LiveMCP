"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { start, config } = require("../src/mcp-server");

let httpServer;
let baseUrl;
let sampleDir;

before(async () => {
  sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), "livemcp-http-"));
  fs.writeFileSync(path.join(sampleDir, "kick.wav"), "");
  config.sampleFolders = [sampleDir];
  httpServer = start(0);
  await new Promise((resolve) => httpServer.on("listening", resolve));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}/mcp`;
});

after(() => {
  httpServer.close();
  fs.rmSync(sampleDir, { recursive: true, force: true });
});

async function connect() {
  const client = new Client({ name: "livemcp-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl)));
  return client;
}

test("MCP initialize と tools/list が通る", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const expected of [
    "live.status",
    "live.api.info",
    "live.api.raw",
    "live.set.read",
    "live.samples.search",
    "live.clip.create_audio",
    "live.device.insert",
    "live.device.replace_sample",
    "live.device.params",
    "live.device.set_param",
  ]) {
    assert.ok(names.includes(expected), `missing tool: ${expected}`);
  }
  await client.close();
});

test("live.samples.search は Max 無しでも動く", async () => {
  const client = await connect();
  const result = await client.callTool({
    name: "live.samples.search",
    arguments: { query: "kick" },
  });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.files.length, 1);
  assert.ok(payload.files[0].endsWith("kick.wav"));
  await client.close();
});

test("Max 未接続で LiveAPI 系ツールを呼ぶとエラーになる", async () => {
  const client = await connect();
  const result = await client.callTool({ name: "live.status", arguments: {} });
  assert.equal(result.isError, true);
  await client.close();
});
