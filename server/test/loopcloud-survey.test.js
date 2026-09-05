// scripts/loopcloud-survey.js — フォルダ名からループ / ワンショットを分類する
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { classifyFolder, classifyFolderDetailed, inherit, surveyPack } = require("../../scripts/loopcloud-survey");

test("フォルダ名の分類と強さ", () => {
  assert.deepStrictEqual(classifyFolderDetailed("Loops"), { cls: "loops", strength: "explicit" });
  assert.deepStrictEqual(classifyFolderDetailed("SMD_WAV_LOOPS"), { cls: "loops", strength: "explicit" });
  assert.deepStrictEqual(classifyFolderDetailed("GA2_Loops_FRK"), { cls: "loops", strength: "explicit" }); // _ 続きでも明示
  assert.deepStrictEqual(classifyFolderDetailed("GA2_Drums_FRK"), { cls: "oneshots", strength: "weak" });
  assert.deepStrictEqual(classifyFolderDetailed("Oneshots"), { cls: "oneshots", strength: "explicit" });
  assert.deepStrictEqual(classifyFolderDetailed("SMD_SOUNDS_&_FX"), { cls: "oneshots", strength: "explicit" });
  assert.deepStrictEqual(classifyFolderDetailed("DGH_BASS_MULTIS"), { cls: "oneshots", strength: "explicit" });
  assert.deepStrictEqual(classifyFolderDetailed("Bass Music"), { cls: "loops", strength: "weak" });
  assert.deepStrictEqual(classifyFolderDetailed("Closed Hats"), { cls: "oneshots", strength: "weak" });
  assert.deepStrictEqual(classifyFolderDetailed("Drums"), { cls: "oneshots", strength: "weak" });
  assert.deepStrictEqual(classifyFolderDetailed("REX Files"), { cls: "skip", strength: "explicit" });
  assert.strictEqual(classifyFolder("Something"), "unknown");
  // Kit はコンストラクションキット（ループ）。ドラム系パックのときだけワンショット
  assert.strictEqual(classifyFolder("SEP7_Kit_01_115_BPM_D"), "loops");
  assert.strictEqual(classifyFolder("Kit 01", "Loopcloud Drum Intro"), "oneshots");
});

test("親子で食い違ったら 子の明示 > 親の明示 > 子の弱い > 親の弱い", () => {
  const ex = (cls) => ({ cls, strength: "explicit" });
  const wk = (cls) => ({ cls, strength: "weak" });
  const un = { cls: "unknown", strength: null };
  assert.strictEqual(inherit(wk("oneshots"), wk("loops")).cls, "oneshots");   // Bass Music / Closed Hats
  assert.strictEqual(inherit(wk("oneshots"), ex("loops")).cls, "loops");      // Loops / Drum Builds & Fills
  assert.strictEqual(inherit(ex("loops"), wk("oneshots")).cls, "loops");      // Drums / Drum Loops
  assert.strictEqual(inherit(un, ex("oneshots")).cls, "oneshots");           // Oneshots / Something
  assert.strictEqual(inherit(un, null).cls, "unknown");
  assert.strictEqual(inherit(ex("skip"), ex("loops")).cls, "skip");
});

test("パックは葉のフォルダまで下りて分類し、直下にファイルのある入れ物は自分の分だけ数える", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "survey-"));
  const pack = path.join(root, "LCD_Pack (0123456789ab)");
  const mk = (rel, n) => { fs.mkdirSync(path.join(pack, rel), { recursive: true }); for (let i = 0; i < n; i++) fs.writeFileSync(path.join(pack, rel, `a${i}.wav`), ""); };
  mk("Bass Music/Closed Hats", 3);
  mk("Bass Music/Drum Loops", 2);
  mk("Loops", 1);                       // 直下に 1 本
  mk("Loops/Drum Builds & Fills", 4);
  mk("Drums/Drum Loops", 5);
  mk("Empty Wrapper/REX Files", 2);
  const s = surveyPack(pack);
  assert.strictEqual(s.name, "LCD_Pack");
  assert.strictEqual(s.dir, "LCD_Pack (0123456789ab)"); // 自宅のパスを分類表に残さない
  const by = (cls) => Object.fromEntries(s[cls].map((f) => [f.name, f.audio]));
  assert.deepStrictEqual(by("oneshots"), { "Bass Music/Closed Hats": 3 });
  assert.deepStrictEqual(by("loops"), { "Bass Music/Drum Loops": 2, "Drums/Drum Loops": 5, Loops: 1, "Loops/Drum Builds & Fills": 4 });
  assert.deepStrictEqual(s.skip, ["Empty Wrapper/REX Files"]);
  assert.strictEqual(s.loops.find((f) => f.name === "Loops/Drum Builds & Fills").strength, "explicit");
  assert.strictEqual(s.oneshots[0].strength, "weak");
  assert.deepStrictEqual(s.counts, { loops: 12, oneshots: 3, unknown: 0, flat: 0 });
  fs.rmSync(root, { recursive: true, force: true });
});

test("セット名の重複: 人が決めた名前は動かさず、レーベルを付けても同名なら番号を付けて必ず別名にする", () => {
  const { assignSetNames } = require("../../scripts/loopcloud-survey");
  process.env.LIVEMCP_NO_LOOPCLOUD_DB = "1"; // Loopcloud DB は使わない（レーベル無し）
  const packs = [
    { name: "Deep House Vol 2" },
    { name: "Deep_House_Vol_2" },            // 同じセット名になる
    { name: "DEEP HOUSE VOL 2", setNameOverride: "DeepHouseVol02" }, // 人が決めた名前
    { name: "Techno Tools" },
  ];
  assignSetNames(packs);
  const names = packs.map((p) => p.setName);
  assert.strictEqual(new Set(names).size, 4, "全部別名になる: " + names.join(", "));
  assert.strictEqual(packs[2].setName, "DeepHouseVol02");
  assert.strictEqual(packs[3].setName, "TechnoTools");
});
