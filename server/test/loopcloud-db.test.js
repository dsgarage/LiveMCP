// scripts/loopcloud-db.js — Loopcloud のローカル DB（SQLite + tags.cache）を読む
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// node:sqlite は Node 22.5+。無い環境（CI の古い Node など）ではこのファイルのテストを飛ばす
let DatabaseSync = null;
try { ({ DatabaseSync } = require("node:sqlite")); } catch { /* 無ければ skip */ }
const skip = DatabaseSync ? false : "node:sqlite が無い Node ではスキップ";

const { LoopcloudDb, parseTagsCache, stripHash } = require("../../scripts/loopcloud-db");

// Loopcloud と同じ表を持つ偽 DB を組む
function fakeLoopcloud(root) {
  const acct = path.join(root, "acct");
  fs.mkdirSync(acct, { recursive: true });
  const db = new DatabaseSync(path.join(acct, "local.db"));
  db.exec(`
    CREATE TABLE CLOUDITEMS(name TEXT,bpm REAL,parentuuid BLOB,itemuuid BLOB PRIMARY KEY NOT NULL,isDirectory INTEGER,syncFlag INTEGER);
    CREATE TABLE TagIdMap(tagId INTEGER NOT NULL,taguuid BLOB NOT NULL,PRIMARY KEY(tagid)) WITHOUT ROWID;
    CREATE TABLE AssignedTags(tagId INTEGER NOT NULL,itemrowId INTEGER NOT NULL,PRIMARY KEY (itemrowId, tagId)) WITHOUT ROWID;
    CREATE TABLE audio_attributes(item_row_id integer PRIMARY KEY NOT NULL,fileDuration real,lengthExcludingSilence real,oneShotAttackTime real,oneShotDecayTime real,transientStrength real) WITHOUT ROWID;
  `);
  const u = (n) => Buffer.from(n.toString(16).padStart(32, "0"), "hex");
  const ins = db.prepare("insert into CLOUDITEMS(name,bpm,parentuuid,itemuuid,isDirectory,syncFlag) values(?,?,?,?,?,0)");
  ins.run("ROOT", 0, null, u(1), 1);
  ins.run("FL205_Hard Drops", 0, u(1), u(2), 1);       // パック（DB 側にハッシュは無い）
  ins.run("Oneshots", 0, u(2), u(3), 1);
  ins.run("Kicks", 0, u(3), u(4), 1);
  ins.run("HD_Kick_1.wav", 0, u(4), u(5), 0);           // rowid 5
  ins.run("Loops", 0, u(2), u(6), 1);
  ins.run("HD_808Loop_155_E.wav", 155, u(6), u(7), 0);  // rowid 7
  ins.run("HD_Unknown.wav", 0, u(6), u(8), 0);          // タグ無し rowid 8
  // タグ: 1 = One Shots, 2 = Loops, 3 = Kick, 4 = Key E, 5 = Freaky Loops
  const tagUuid = {
    1: "10000000-0000-0000-0000-000000000001", 2: "10000000-0000-0000-0000-000000000002",
    3: "10000000-0000-0000-0000-000000000003", 4: "10000000-0000-0000-0000-000000000004", 5: "10000000-0000-0000-0000-000000000005",
  };
  const tid = db.prepare("insert into TagIdMap(tagId,taguuid) values(?,?)");
  for (const [id, uu] of Object.entries(tagUuid)) tid.run(Number(id), Buffer.from(uu.replace(/-/g, ""), "hex"));
  const at = db.prepare("insert into AssignedTags(tagId,itemrowId) values(?,?)");
  at.run(1, 5); at.run(3, 5); at.run(5, 5);
  at.run(2, 7); at.run(4, 7); at.run(5, 7);
  db.prepare("insert into audio_attributes values(?,?,?,?,?,?)").run(5, 0.445, 0.296, 0.0001, 0.1583, 0.01);
  db.close();
  fs.writeFileSync(path.join(acct, "tags.cache"), `<?xml version="1.0"?>
<cache>
  <LcTag uuid="00000000-0000-0000-0000-000000000000" name="System Tags"/>
  <LcTag uuid="00000000-0000-0000-0000-00000000000a" parentId="00000000-0000-0000-0000-000000000000" name="Content Types"/>
  <LcTag uuid="00000000-0000-0000-0000-00000000000b" parentId="00000000-0000-0000-0000-000000000000" name="Instruments"/>
  <LcTag uuid="00000000-0000-0000-0000-00000000000c" parentId="00000000-0000-0000-0000-000000000000" name="Key"/>
  <LcTag uuid="00000000-0000-0000-0000-00000000000d" parentId="00000000-0000-0000-0000-000000000000" name="Labels"/>
  <LcTag uuid="00000000-0000-0000-0000-00000000000e" parentId="00000000-0000-0000-0000-00000000000b" name="Drum"/>
  <LcTag uuid="${tagUuid[1]}" parentId="00000000-0000-0000-0000-00000000000a" name="One Shots"/>
  <LcTag uuid="${tagUuid[2]}" parentId="00000000-0000-0000-0000-00000000000a" name="Loops"/>
  <LcTag uuid="${tagUuid[3]}" parentId="00000000-0000-0000-0000-00000000000e" name="Kick"/>
  <LcTag uuid="${tagUuid[4]}" parentId="00000000-0000-0000-0000-00000000000c" name="E"/>
  <LcTag uuid="${tagUuid[5]}" parentId="00000000-0000-0000-0000-00000000000d" name="Freaky &amp; Loops"/>
</cache>`);
  const library = path.join(root, "library");
  fs.mkdirSync(path.join(library, "FL205_Hard Drops (126c8ee25cd5)", "Oneshots", "Kicks"), { recursive: true });
  return { acct, library };
}

test("パスから Loopcloud の種別・楽器・キー・解析値を引ける", { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lcdb-"));
  const { acct, library } = fakeLoopcloud(root);
  const lc = new LoopcloudDb({ dbPath: path.join(acct, "local.db"), tagsPath: path.join(acct, "tags.cache"), libraryDir: library });

  const kick = lc.lookup(path.join(library, "FL205_Hard Drops (126c8ee25cd5)", "Oneshots", "Kicks", "HD_Kick_1.wav"));
  assert.strictEqual(kick.contentType, "oneshot");
  assert.deepStrictEqual(kick.instrument, ["Drum", "Kick"]);
  assert.strictEqual(kick.label, "Freaky & Loops");
  assert.strictEqual(kick.attrs.oneShotDecayTime, 0.1583);
  assert.ok(kick.tags.includes("System Tags > Content Types > One Shots"));

  const loop = lc.lookup("FL205_Hard Drops/Loops/HD_808Loop_155_E.wav"); // 相対でも引ける
  assert.strictEqual(loop.contentType, "loop");
  assert.strictEqual(loop.key, "E");
  assert.strictEqual(loop.bpm, 155);
  assert.strictEqual(loop.attrs, null);

  const unknown = lc.lookup("FL205_Hard Drops/Loops/HD_Unknown.wav");
  assert.strictEqual(unknown.contentType, null);
  assert.strictEqual(lc.lookup("FL205_Hard Drops/Loops/nope.wav"), null);
  assert.strictEqual(lc.lookup("/elsewhere/x.wav"), null); // ライブラリ外

  assert.strictEqual(lc.packItems("FL205_Hard Drops (126c8ee25cd5)").length, 3);
  lc.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("tags.cache の階層を辿り、ハッシュ付きのパック名を DB の名前に直す", { skip }, () => {
  const tags = parseTagsCache('<cache><LcTag uuid="A" name="Root"/><LcTag uuid="B" parentId="A" name="Kids &amp; Co"/></cache>');
  assert.strictEqual(tags.get("b").name, "Kids & Co");
  assert.strictEqual(stripHash("FL205_Hard Drops (126c8ee25cd5)"), "FL205_Hard Drops");
  assert.strictEqual(stripHash("Loops"), "Loops");
});
