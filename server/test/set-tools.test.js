// server/src/set-tools.js — .als を対象にする MCP ツールの中身。
// Live には触らないので、依存（開いているセットの判定・通知・open）を差し替えて検証する。
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createSetTools, backupPath } = require("../../server/src/set-tools");
const { writeAls, readAls, listTracks } = require("../../scripts/als");
const { ungrouped } = require("./fixtures");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "set-tools-"));
  const set = path.join(dir, "Song.als");
  writeAls(set, ungrouped());
  const messages = [];
  const opened = [];
  const tools = createSetTools({
    isOpenInLive: () => false,
    currentLiveDocument: () => set,
    liveMessage: async (m) => (messages.push(m), true),
    openApp: async (f) => (opened.push(f), true),
  });
  return { dir, set, messages, opened, tools };
}

test("置き換え書き出しは Backup/ へ退避してから書く", async () => {
  const { dir, set, messages, tools } = setup();
  const before = fs.readFileSync(set);

  const r = await tools.groupTracksInSet({ groupName: "ONE SHOTS", tracks: ["OS "] });

  assert.strictEqual(r.output, set);
  assert.strictEqual(r.grouped_tracks, 2); // OS 808S と OS BASSES
  assert.match(r.backup, /\/Backup\/Song \[\d{4}-\d{2}-\d{2} \d{6}\]\.als$/);
  assert.deepStrictEqual(fs.readFileSync(r.backup), before, "退避が元と一致しない");

  const tracks = listTracks(readAls(set));
  const group = tracks.find((t) => t.tag === "GroupTrack");
  assert.strictEqual(group.name, "ONE SHOTS");
  assert.ok(messages.some((m) => m.includes("ONE SHOTS")));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("Live で開いているセットの置き換えは書かずに選択肢を返す", async () => {
  const { dir, set, messages, tools } = setup();
  const before = fs.readFileSync(set);
  const open = createSetTools({
    isOpenInLive: () => true,
    currentLiveDocument: () => set,
    liveMessage: async (m) => (messages.push(m), true),
  });

  await assert.rejects(
    () => open.groupTracksInSet({ groupName: "X", tracks: ["OS "] }),
    /Live で開かれている[\s\S]*選択肢/
  );
  assert.deepStrictEqual(fs.readFileSync(set), before, "ファイルが書き換わっている");
  assert.ok(messages.some((m) => m.includes("保留")), "Live へ知らせていない");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("output 指定なら開いていても書け、退避は作らない", async () => {
  const { dir, set, tools } = setup();
  const open = createSetTools({
    isOpenInLive: () => true,
    currentLiveDocument: () => set,
    liveMessage: async () => true,
  });
  const out = path.join(dir, "Song grouped.als");

  const r = await open.groupTracksInSet({ groupName: "OS", tracks: ["OS "], output: out });

  assert.strictEqual(r.output, out);
  assert.strictEqual(r.backup, null);
  assert.ok(fs.existsSync(out));
  assert.ok(!fs.existsSync(path.join(dir, "Backup")));

  // 既存の出力先は上書きしない
  await assert.rejects(
    () => open.groupTracksInSet({ groupName: "OS", tracks: ["OS "], output: out }),
    /出力先が既にあります/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("open: true なら書き出し後に Live で開く", async () => {
  const { dir, set, opened, tools } = setup();

  const r = await tools.groupTracksInSet({ groupName: "OS", tracks: ["OS "], open: true });

  assert.strictEqual(r.opened, true);
  assert.deepStrictEqual(opened, [set]);
  assert.match(r.note, /Live が保存を確認します/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("対象セットが分からなければ setPath を求める", async () => {
  const tools = createSetTools({
    isOpenInLive: () => false,
    currentLiveDocument: () => null,
    liveMessage: async () => true,
  });
  await assert.rejects(
    () => tools.groupTracksInSet({ groupName: "X", tracks: ["OS "] }),
    /setPath で \.als の絶対パスを指定/
  );
});

test("backupPath は Live 純正の命名に合わせる", () => {
  const p = backupPath("/a/b/Song.als", new Date(2026, 8, 2, 3, 4, 5));
  assert.strictEqual(p, "/a/b/Backup/Song [2026-09-02 030405].als");
});
