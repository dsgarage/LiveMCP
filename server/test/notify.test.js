// scripts/notify.js のうち、ダイアログを出さずに検証できる部分。
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { parseCurrentDocument } = require("../../scripts/notify");

const line = (path) => `2026-09-02T03:08:24.275605: info: Loading document "${path}"`;

test("最後に読み込まれたセットを返す", () => {
  const log = [
    line("/Users/x/Music/Ableton/A Project/One.als"),
    line("/Users/x/Music/Ableton/A Project/Two.als"),
  ].join("\n");
  assert.strictEqual(parseCurrentDocument(log), "/Users/x/Music/Ableton/A Project/Two.als");
});

test("Live 内部のテンプレート読み込みは無視する", () => {
  // トラックを追加すると Live は Default MIDI Track.als を読む。
  // これを拾うと「開いているセット」を見失う。
  const log = [
    line("/Users/x/Music/Ableton/A Project/Two.als"),
    line("/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Core Library/Defaults/Creating Tracks/MIDI Track/Default MIDI Track.als"),
  ].join("\n");
  assert.strictEqual(parseCurrentDocument(log), "/Users/x/Music/Ableton/A Project/Two.als");
});

test("該当が無ければ null", () => {
  assert.strictEqual(parseCurrentDocument("info: なにもない\n"), null);
  assert.strictEqual(parseCurrentDocument(""), null);
});
