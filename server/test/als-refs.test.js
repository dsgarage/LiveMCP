// scripts/als-refs.js — 切れた FileRef の向け直し。
// 実ファイルの有無で挙動が決まるので、一時ディレクトリに偽のライブラリと .als の
// 置き場を作って検証する。
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { escapeAttr, unescapeAttr, listFileRefs, repairXml, buildIndex } = require("../../scripts/als-refs");

// Live が書く FileRef の形（Hard Drops.als から）
function fileRef(rel, abs, size = 100) {
  return `<FileRef>
\t<RelativePathType Value="1" />
\t<RelativePath Value="${escapeAttr(rel)}" />
\t<Path Value="${escapeAttr(abs)}" />
\t<Type Value="2" />
\t<LivePackName Value="" />
\t<LivePackId Value="" />
\t<OriginalFileSize Value="${size}" />
\t<OriginalCrc Value="1" />
\t<SourceHint Value="" />
</FileRef>`;
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "als-refs-"));
  const lib = path.join(root, "library", "PACK_A (abc)", "WAV_LOOPS");
  const proj = path.join(root, "Project", "X TRACK Project");
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(path.join(proj, "Samples", "Imported"), { recursive: true });
  const write = (dir, name, bytes) => fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes));
  write(lib, "A & B_loop.wav", 100);          // & を含む名前
  write(lib, "same.wav", 10);
  fs.mkdirSync(path.join(root, "library", "PACK_B"), { recursive: true });
  write(path.join(root, "library", "PACK_B"), "same.wav", 20); // 同名・別サイズ
  write(path.join(proj, "Samples", "Imported"), "only_here.wav", 5);
  return { root, lib, proj, library: path.join(root, "library") };
}

test("属性値のエスケープは & を往復できる", () => {
  const s = 'A & B "q" <x>';
  assert.strictEqual(unescapeAttr(escapeAttr(s)), s);
  assert.strictEqual(escapeAttr("a & b"), "a &amp; b");
});

test("FileRef を位置つきで列挙し、値はアンエスケープされる", () => {
  // fileRef() が属性値をエスケープするので、生の & を渡す
  const xml = "<x>" + fileRef("../a & b.wav", "/p/a & b.wav", 7) + "</x>";
  assert.ok(xml.includes("a &amp; b.wav"), "XML 上はエスケープされている");
  const refs = listFileRefs(xml);
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].relativePath, "../a & b.wav");
  assert.strictEqual(refs[0].path, "/p/a & b.wav");
  assert.strictEqual(refs[0].originalSize, 7);
  assert.strictEqual(xml.slice(refs[0].start, refs[0].end).startsWith("<FileRef>"), true);
});

test("旧位置を指す参照を、ライブラリの実ファイルへ .als 基準の相対パスで向け直す", () => {
  const { root, lib, proj, library } = setup();
  const old = "/Users/someone/Music/Ableton/X TRACK Project/Samples/Imported/A & B_loop.wav";
  const xml = "<x>" + fileRef("../../../X TRACK Project/Samples/Imported/A & B_loop.wav", old, 100) + "</x>";

  const r = repairXml(xml, proj, { index: buildIndex(library) });

  assert.strictEqual(r.repaired.length, 1);
  assert.strictEqual(r.ok, 0);
  const target = path.join(lib, "A & B_loop.wav");
  assert.strictEqual(r.repaired[0].to, target);
  const rel = path.relative(proj, target);
  assert.ok(r.xml.includes(`<RelativePath Value="${escapeAttr(rel)}" />`), "相対パスが .als 基準になっていない");
  assert.ok(r.xml.includes(`<Path Value="${escapeAttr(target)}" />`));
  assert.ok(!/[^&]&[^a]/.test(r.xml.match(/<Path Value="[^"]*"/)[0]), "& が生のまま");
  // 触っていない要素は残る
  assert.ok(r.xml.includes('<OriginalCrc Value="1" />'));
  fs.rmSync(root, { recursive: true, force: true });
});

test("解決できている参照と音声以外の参照は触らない", () => {
  const { root, lib, proj, library } = setup();
  const good = path.join(lib, "same.wav");
  const xml = "<x>" + fileRef(path.relative(proj, good), good, 10) + fileRef("/x/Reverb Default.adv", "/x/Reverb Default.adv") + "</x>";
  const r = repairXml(xml, proj, { index: buildIndex(library) });
  assert.strictEqual(r.ok, 1);
  assert.strictEqual(r.repaired.length, 0);
  assert.strictEqual(r.unresolved.length, 0);
  assert.strictEqual(r.xml, xml);
  fs.rmSync(root, { recursive: true, force: true });
});

test("同名が複数あればサイズで選び、決められなければ曖昧として書かない", () => {
  const { root, proj, library } = setup();
  const idx = buildIndex(library);
  const bySize = repairXml("<x>" + fileRef("nowhere/same.wav", "/nowhere/same.wav", 20) + "</x>", proj, { index: idx });
  assert.strictEqual(bySize.repaired.length, 1);
  assert.ok(bySize.repaired[0].to.endsWith(path.join("PACK_B", "same.wav")));
  assert.strictEqual(bySize.repaired[0].reason, "size");

  const noSize = "<x>" + fileRef("nowhere/same.wav", "/nowhere/same.wav").replace(/<OriginalFileSize Value="\d+" \/>\n/, "") + "</x>";
  const amb = repairXml(noSize, proj, { index: idx });
  assert.strictEqual(amb.ambiguous.length, 1);
  assert.strictEqual(amb.xml, noSize);
  fs.rmSync(root, { recursive: true, force: true });
});

test("サイズが一致しない候補は書き換えず報告する", () => {
  const { root, proj, library } = setup();
  const r = repairXml("<x>" + fileRef("nowhere/A & B_loop.wav", "/nowhere/A & B_loop.wav", 999) + "</x>", proj, { index: buildIndex(library) });
  assert.strictEqual(r.sizeMismatch.length, 1);
  assert.strictEqual(r.repaired.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("索引に無ければプロジェクト自身の Samples/ を探し、無ければ見つからずに残す", () => {
  const { root, proj, library } = setup();
  const idx = buildIndex(library);
  const fb = [path.join(proj, "Samples", "Imported")];
  const hit = repairXml("<x>" + fileRef("old/only_here.wav", "/old/only_here.wav", 5) + "</x>", proj, { index: idx, fallbackDirs: fb });
  assert.strictEqual(hit.repaired.length, 1);
  assert.strictEqual(hit.repaired[0].reason, "fallback");
  assert.ok(hit.xml.includes('<RelativePath Value="Samples/Imported/only_here.wav" />'));

  const none = repairXml("<x>" + fileRef("old/Life-Beat.wav", "/old/Life-Beat.wav", 5) + "</x>", proj, { index: idx, fallbackDirs: fb });
  assert.strictEqual(none.unresolved.length, 1);
  assert.strictEqual(none.unresolved[0].name, "Life-Beat.wav");
  fs.rmSync(root, { recursive: true, force: true });
});

test("allowSizeMismatch ならサイズ違いも向け直し、差を記録する", () => {
  const { root, proj, library } = setup();
  const r = repairXml("<x>" + fileRef("nowhere/A & B_loop.wav", "/nowhere/A & B_loop.wav", 999) + "</x>", proj,
    { index: buildIndex(library), allowSizeMismatch: true });
  assert.strictEqual(r.sizeMismatch.length, 0);
  assert.strictEqual(r.repaired.length, 1);
  assert.strictEqual(r.repaired[0].reason, "size_mismatch_allowed");
  assert.strictEqual(r.repaired[0].sizeDiff, 999 - 100);
  fs.rmSync(root, { recursive: true, force: true });
});
