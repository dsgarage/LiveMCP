"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { searchSamples } = require("../src/sample-search");

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "livemcp-samples-"));
  fs.mkdirSync(path.join(root, "Drums", "Kicks"), { recursive: true });
  fs.writeFileSync(path.join(root, "Drums", "Kicks", "kick_808.wav"), "");
  fs.writeFileSync(path.join(root, "Drums", "snare_tight.aif"), "");
  fs.writeFileSync(path.join(root, "loop_120bpm.WAV"), "");
  fs.writeFileSync(path.join(root, "readme.txt"), "");
  fs.writeFileSync(path.join(root, ".hidden.wav"), "");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("オーディオ拡張子のみ・絶対パスで返す", () => {
  const results = searchSamples([root], "", 100);
  assert.equal(results.length, 3);
  for (const p of results) assert.ok(path.isAbsolute(p));
  assert.ok(!results.some((p) => p.endsWith("readme.txt")));
  assert.ok(!results.some((p) => path.basename(p).startsWith(".")));
});

test("クエリは AND 条件・大文字小文字無視", () => {
  assert.equal(searchSamples([root], "kick 808", 100).length, 1);
  assert.equal(searchSamples([root], "KICK", 100).length, 1);
  assert.equal(searchSamples([root], "kick snare", 100).length, 0);
});

test("limit で件数を制限する", () => {
  assert.equal(searchSamples([root], "", 2).length, 2);
});

test("存在しないフォルダは空を返す", () => {
  assert.deepEqual(searchSamples(["/no/such/dir"], "", 10), []);
});
