// scripts/template-set.js — LiveMCP を載せたテンプレートセット
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildTemplateSet } = require("../../scripts/template-set");
const { readAls, listTracks } = require("../../scripts/als");

test("既定の 4 トラックの後ろに LiveMCP 入りのオーディオトラックがあり、置換し残しが無い", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-set-"));
  const out = path.join(dir, "LiveMCP.als");
  const r = buildTemplateSet(out);
  const xml = readAls(out);
  const names = listTracks(xml).filter((t) => t.tag !== "ReturnTrack").map((t) => t.name);
  assert.deepStrictEqual(names, ["1-MIDI", "2-MIDI", "3-Audio", "4-Audio", "LiveMCP"]);
  assert.strictEqual(r.tracks, 5);
  assert.ok(xml.includes("<MxDeviceAudioEffect "), "M4L デバイスが入っている");
  // .amxd は User Library 基準の相対パス（RelativePathType 6）。絶対パスは install.sh が置き換えるプレースホルダ
  assert.ok(xml.includes('<RelativePath Value="Presets/Audio Effects/Max Audio Effect/LiveMCP/LiveMCP.amxd" />'));
  assert.ok(xml.includes("/LIVEMCP_USER_LIBRARY/Presets/"));
  assert.ok(!/__[A-Z_]+\d*__/.test(xml), "置換し残しが無い");
  assert.ok(!xml.includes(`/Users/${os.userInfo().username}/`), "作った人のパスが入っていない"); // Live 内蔵データ由来の /Users/nsh/ は Ableton のもの
  // テンポは Manual とオートメーション初期値の両方が 120（初期値が優先されるため）
  assert.strictEqual(/<Tempo>\s*<LomId Value="0" \/>\s*<Manual Value="([^"]*)"/.exec(xml)[1], "120");
  assert.strictEqual(/<PointeeId Value="8" \/>[\s\S]*?<FloatEvent Id="\d+" Time="-63072000" Value="([^"]*)"/.exec(xml)[1], "120");
  // ポインタ id が重複していない
  const ids = [...xml.matchAll(/<(?:AutomationTarget|Pointee|ModulationTarget) Id="(\d+)"/g)].map((m) => m[1]);
  assert.strictEqual(new Set(ids).size, ids.length, "ポインタ id が一意");
  fs.rmSync(dir, { recursive: true, force: true });
});
