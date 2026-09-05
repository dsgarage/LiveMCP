#!/usr/bin/env node
// 2 つの .als を XML レベルで比較する。
//
//   node scripts/als-diff.js <前.als> <後.als> [表示する塊の数]
//
// Live のスキーマは公開されていないので、「ある操作をしたときに Live が
// 何を書くか」を実物の差分から学ぶために使う。24MB 同士を生で diff しても
// 読めないため、トラック構成の要約と、変更のあった塊だけを出す。
"use strict";

const { readAls, listTracks } = require("./als");

// 共通の先頭・末尾を削ってから、変更のあった塊を拾う素朴な差分。
// 行数が数十万になるので LCS は使わず、前後から詰めて中央の差分だけ見る。
function hunks(a, b, maxHunks) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++;

  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);

  // 中央の塊をさらに、共通行を手がかりに小さく割る
  const out = [];
  const key = (l) => l.trim();
  const addedSet = new Set(added.map(key));
  const removedSet = new Set(removed.map(key));

  const onlyAdded = added.filter((l) => !removedSet.has(key(l)));
  const onlyRemoved = removed.filter((l) => !addedSet.has(key(l)));

  out.push({ head, tail, removed: removed.length, added: added.length, onlyAdded, onlyRemoved });
  return out.slice(0, maxHunks);
}

function tagCounts(lines) {
  const counts = new Map();
  for (const line of lines) {
    const m = /^\s*<\/?([A-Za-z][\w.]*)/.exec(line);
    if (!m) continue;
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  return counts;
}

function main() {
  const [before, after, limitArg] = process.argv.slice(2);
  if (!before || !after) {
    console.error("使い方: node scripts/als-diff.js <前.als> <後.als> [表示行数]");
    process.exit(2);
  }
  const limit = Number(limitArg || 40);

  const xa = readAls(before);
  const xb = readAls(after);

  console.log(`前: ${xa.length.toLocaleString()} bytes`);
  console.log(`後: ${xb.length.toLocaleString()} bytes  (${xb.length - xa.length >= 0 ? "+" : ""}${(xb.length - xa.length).toLocaleString()})`);

  console.log("\n=== トラック構成 ===");
  const ta = listTracks(xa);
  const tb = listTracks(xb);
  const fmt = (t) => `${String(t.id).padStart(3)} ${t.tag.padEnd(11)} ${t.name}${t.groupId >= 0 ? ` (group ${t.groupId})` : ""}`;
  const sa = new Set(ta.map(fmt));
  const sb = new Set(tb.map(fmt));
  for (const t of tb) if (!sa.has(fmt(t))) console.log(`  + ${fmt(t)}`);
  for (const t of ta) if (!sb.has(fmt(t))) console.log(`  - ${fmt(t)}`);

  const la = xa.split("\n");
  const lb = xb.split("\n");
  const [h] = hunks(la, lb, 1);

  console.log("\n=== 行の差分 ===");
  console.log(`  先頭 ${h.head.toLocaleString()} 行と末尾 ${h.tail.toLocaleString()} 行は一致`);
  console.log(`  変更区間: 前 ${h.removed.toLocaleString()} 行 → 後 ${h.added.toLocaleString()} 行`);

  console.log("\n=== 追加された要素（タグ別）===");
  for (const [tag, n] of [...tagCounts(h.onlyAdded)].sort((x, y) => y[1] - x[1]).slice(0, 15)) {
    console.log(`  ${String(n).padStart(6)}  ${tag}`);
  }
  console.log("\n=== 消えた要素（タグ別）===");
  for (const [tag, n] of [...tagCounts(h.onlyRemoved)].sort((x, y) => y[1] - x[1]).slice(0, 15)) {
    console.log(`  ${String(n).padStart(6)}  ${tag}`);
  }

  console.log(`\n=== 追加行の先頭 ${limit} 行 ===`);
  for (const line of h.onlyAdded.slice(0, limit)) console.log("  + " + line.trim().slice(0, 130));
  console.log(`\n=== 削除行の先頭 ${limit} 行 ===`);
  for (const line of h.onlyRemoved.slice(0, limit)) console.log("  - " + line.trim().slice(0, 130));
}

main();
