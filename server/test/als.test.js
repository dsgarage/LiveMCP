// scripts/als.js のテスト。
// 実セットは環境依存なので、合成した最小の XML で構造を確かめ、
// 手元に実物があるときだけ追加で往復を検証する。
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readAls, writeAls, verifyRoundTrip, creatorOf, listTracks, renameTrack, groupTracks,
        countScenes, nextPointeeId } = require("../../scripts/als");
const { fixture, ungrouped } = require("./fixtures");


test("gzip の往復で XML が変わらない", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "als-"));
  const file = path.join(dir, "t.als");
  const xml = fixture();

  writeAls(file, xml);
  assert.strictEqual(readAls(file), xml);
  assert.ok(verifyRoundTrip(file).ok);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("Creator を読める", () => {
  assert.strictEqual(creatorOf(fixture()), "Ableton Live 12.4.5");
});

test("Tracks 直下のトラックを種別・Id・グループ付きで列挙する", () => {
  const tracks = listTracks(fixture());
  assert.deepStrictEqual(
    tracks.map((t) => [t.tag, t.id, t.name, t.groupId]),
    [
      ["AudioTrack", 16, "LOOPS", -1],
      ["GroupTrack", 30, "ONE SHOTS", -1],
      ["MidiTrack", 23, "OS 808S", 30],
      ["MidiTrack", 25, "OS BASSES", -1],
      ["ReturnTrack", 2, "A-Reverb", -1],
    ]
  );
});

test("リネームは対象トラックだけを書き換える", () => {
  const xml = fixture();
  const target = listTracks(xml).find((t) => t.name === "OS 808S");
  const out = renameTrack(xml, target, "OS 808S RENAMED");

  const after = listTracks(out);
  assert.deepStrictEqual(after.map((t) => t.name),
    ["LOOPS", "ONE SHOTS", "OS 808S RENAMED", "OS BASSES", "A-Reverb"]);
  // 触っていない部分は 1 バイトも変わらない
  assert.strictEqual(out.length, xml.length + "OS 808S RENAMED".length * 2 - "OS 808S".length * 2);
});

test("XML に含まれない名前でリネームしようとしたら失敗させる", () => {
  const xml = fixture().replace(/<UserName Value="OS 808S" \/>\n/, "");
  const target = listTracks(xml).find((t) => t.name === "OS 808S");
  assert.throws(() => renameTrack(xml, target, "X"), /置換対象が見つかりません/);
});

// 手元に実セットがあるときだけ走る。Live が実際に書いた 20MB 級の XML でも
// 往復とトラック列挙が壊れないことの確認。
const REAL = path.join(
  os.homedir(),
  "Music/Ableton/User Library/Project/METAL TRACK Project/Hard Drops.als"
);

test("実際の .als を往復できる", { skip: !fs.existsSync(REAL) }, () => {
  const r = verifyRoundTrip(REAL);
  assert.ok(r.ok, "展開 → 圧縮 → 展開で XML が変わった");

  const tracks = listTracks(readAls(REAL));
  assert.ok(tracks.length > 0);
  assert.ok(tracks.every((t) => Number.isInteger(t.id)));
});

test("シーン数と NextPointeeId を読める", () => {
  assert.strictEqual(countScenes(fixture()), 2);
  assert.strictEqual(nextPointeeId(fixture()), 5000);
});

test("グループを作ると親が挿入され、子の所属と出力先が変わる", () => {
  const xml = ungrouped();
  const { xml: out, groupId, scenes, sends, pointeeIds } = groupTracks(xml, {
    name: "ONE SHOTS",
    trackIds: [23],
  });

  assert.strictEqual(scenes, 2);
  assert.strictEqual(sends, 1);        // ReturnTrack 1 本
  assert.strictEqual(pointeeIds, 24);  // 22 + sends * 2
  assert.strictEqual(groupId, 26);     // 既存の最大 Id 25 の次

  const tracks = listTracks(out);
  const group = tracks.find((t) => t.tag === "GroupTrack");
  assert.strictEqual(group.name, "ONE SHOTS");
  assert.strictEqual(group.groupId, -1);

  // 親は子の直前に入る
  assert.strictEqual(tracks.indexOf(group) + 1, tracks.findIndex((t) => t.id === 23));
  assert.strictEqual(tracks.find((t) => t.id === 23).groupId, groupId);

  // 子の音声出力がグループを向く
  const child = tracks.find((t) => t.id === 23);
  const block = out.slice(child.start, child.end);
  assert.match(block, /<Target Value="AudioOut\/GroupTrack" \/>/);
  assert.match(block, /<UpperDisplayString Value="Group" \/>/);

  // 確保した id のぶんだけ NextPointeeId が進む
  assert.strictEqual(nextPointeeId(out), 5000 + pointeeIds);
  // placeholder の消し残しが無い
  assert.doesNotMatch(out, /__[A-Z0-9]+__/);
});

test("グループにできない組み合わせは弾く", () => {
  const xml = ungrouped();
  // 16(LOOPS) と 25(OS BASSES) の間に 23 が挟まっているので連続していない
  assert.throws(() => groupTracks(xml, { name: "X", trackIds: [16, 25] }),
    /連続したトラックだけ/);
  assert.throws(() => groupTracks(xml, { name: "X", trackIds: [2] }),
    /リターントラックは/);
  assert.throws(() => groupTracks(fixture(), { name: "X", trackIds: [23] }),
    /既にグループに入っている/);
  assert.throws(() => groupTracks(xml, { name: "X", trackIds: [999] }),
    /トラックが見つかりません/);
});

test("実際の .als をグループ化しても Live が書いた構造と一致する", { skip: !fs.existsSync(REAL) }, () => {
  const src = readAls(REAL);
  const ids = listTracks(src).filter((t) => t.name.startsWith("OS ")).map((t) => t.id);
  const { xml: out, scenes, sends } = groupTracks(src, { name: "ONE SHOTS", trackIds: ids });

  assert.strictEqual(scenes, 30);
  assert.strictEqual(sends, 2);
  assert.strictEqual(listTracks(out).filter((t) => t.groupId >= 0).length, ids.length);
  assert.doesNotMatch(out, /__[A-Z0-9]+__/);
});

test("トラック名の & はアンエスケープして返す", () => {
  const xml = fixture().replace('Value="LOOPS"', 'Value="DRUMS &amp; PERC"');
  assert.strictEqual(listTracks(xml)[0].name, "DRUMS & PERC");
});
