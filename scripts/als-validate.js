#!/usr/bin/env node
// 書いた .als が Live に「破損」と言われる前に、こちらで気づくための検査（#22）。
//
//   node scripts/als-validate.js <セット.als ...>
//
// Live は同じ親の下に並ぶ要素の Id が重なっていると
// 「ドキュメントは破損しているため読み込めません (Non-unique list ids)」で開かない。
// プリセットから取り出したデバイスは全部 Id="0" で入っているので、
// <Devices> に 3 つ並べただけでこれを踏む。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const als = require("./als");

// タグだけを順に舐める簡易スキャナ。属性値の中の > は引用符で守られている前提
const TAG = /<(\/?)([A-Za-z][\w.]*)((?:"[^"]*"|[^>"])*?)(\/?)>/g;

// 同じ親の下で重なっている Id を探す。返り値は [{ path, id, tags }]
function duplicateListIds(xml) {
  const stack = [{ tag: "(root)", ids: new Map() }];
  const bad = [];
  for (const m of xml.matchAll(TAG)) {
    const [, closing, tag, attrs, selfClosing] = m;
    if (closing) { if (stack.length > 1) stack.pop(); continue; }
    const id = /(?:^|\s)Id="([^"]*)"/.exec(attrs);
    if (id) {
      const parent = stack[stack.length - 1];
      const seen = parent.ids.get(id[1]);
      if (seen) { seen.push(tag); if (seen.length === 2) bad.push({ path: stack.map((s) => s.tag).join("/"), id: id[1], tags: seen }); }
      else parent.ids.set(id[1], [tag]);
    }
    if (!selfClosing) stack.push({ tag, ids: new Map() });
  }
  return bad;
}

// ポインタ id（AutomationTarget / ModulationTarget / Pointee）が文書内で重なっていないか
function duplicatePointeeIds(xml) {
  const seen = new Map();
  const bad = [];
  for (const m of xml.matchAll(/<(AutomationTarget|ModulationTarget|Pointee) Id="(\d+)"/g)) {
    const k = m[2];
    if (seen.has(k)) bad.push({ id: k, tags: [seen.get(k), m[1]] });
    else seen.set(k, m[1]);
  }
  const next = /<NextPointeeId Value="(\d+)"/.exec(xml);
  const max = Math.max(0, ...[...seen.keys()].map(Number));
  return { dupes: bad, max, next: next ? Number(next[1]) : null };
}

// トラックの <MidiControllers> の中で ControllerTargets.<N> の Id が連番になっているか。
// Live が書いたセットは必ず文書順の連番で、崩れているとトラックに楽器がある場合に落ちる
function nonSequentialControllerTargets(xml) {
  const bad = [];
  for (const m of xml.matchAll(/<MidiControllers>([\s\S]*?)<\/MidiControllers>/g)) {
    const ids = [...m[1].matchAll(/<ControllerTargets\.(\d+) Id="(\d+)"/g)].map((h) => [Number(h[1]), Number(h[2])]);
    for (let i = 1; i < ids.length; i++) {
      if (ids[i][1] !== ids[i - 1][1] + 1) { bad.push({ index: ids[i][0], id: ids[i][1], prev: ids[i - 1][1] }); break; }
    }
  }
  return bad;
}

// 問題があれば throw する。組み立ての最後に通しておく
function assertValid(xml, label = "") {
  const where = label ? `${label}: ` : "";
  const left = /__[A-Z_]+\d*__/.exec(xml);
  if (left) throw new Error(`${where}置換し残し ${left[0]}`);
  const dup = duplicateListIds(xml);
  if (dup.length) {
    const d = dup[0];
    throw new Error(`${where}同じ親の下で Id が重なっている（Live が Non-unique list ids で開けない）: ${d.path} の Id="${d.id}" が ${d.tags.join(" / ")} で重複（他 ${dup.length - 1} 件）`);
  }
  const p = duplicatePointeeIds(xml);
  if (p.dupes.length) throw new Error(`${where}ポインタ id が重複: Id="${p.dupes[0].id}"（他 ${p.dupes.length - 1} 件）`);
  if (p.next != null && p.max >= p.next) throw new Error(`${where}NextPointeeId(${p.next}) が使用済み id の最大(${p.max})を超えていない`);
  const seq = nonSequentialControllerTargets(xml);
  if (seq.length) {
    const s0 = seq[0];
    throw new Error(`${where}ControllerTargets の id が連番でない: .${s0.index} が ${s0.id}（直前は ${s0.prev}）。楽器を載せると Live が落ちる`);
  }
  return true;
}

module.exports = { duplicateListIds, duplicatePointeeIds, nonSequentialControllerTargets, assertValid };

if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error("使い方: node scripts/als-validate.js <セット.als ...>"); process.exit(1); }
  let ng = 0;
  for (const f of files) {
    try { assertValid(als.readAls(f), path.basename(f)); console.log(`  OK   ${f}`); }
    catch (e) { ng++; console.error(`  NG   ${f}\n       ${e.message}`); }
  }
  console.log(`\n${files.length} 件中 ${files.length - ng} 件 OK`);
  process.exit(ng ? 1 : 0);
}
