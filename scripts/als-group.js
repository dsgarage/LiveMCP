#!/usr/bin/env node
// .als の中で、連続したトラックを Group トラックにまとめる。
//
//   node scripts/als-group.js <入力.als> <出力.als> <グループ名> <対象> ...
//
// 対象はトラック名（前方一致）か Id。
//
//   node scripts/als-group.js "Hard Drops.als" "out.als" "ONE SHOTS" "OS "
//   node scripts/als-group.js in.als out.als "DRUMS" 23 24 25
//
// Live の Song API には group_tracks が無く、LOM 経由では作れない。
// ここはファイルを書く側から実現する経路。
//
// 入力が Live で開かれているときは既定で中止する。書き出しても画面には
// 反映されず、Live 側から保存すると生成した内容が消えるため。
// 承知のうえで進めるときは --force を付ける。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { readAls, writeAls, listTracks, groupTracks, resolveTrackTargets } = require("./als");
const { notify, isOpenInLive } = require("./notify");

async function main() {
  const argv = process.argv.slice(2).filter((a) => a !== "--force");
  const force = process.argv.includes("--force");
  const [input, output, name, ...targets] = argv;
  if (!input || !output || !name || targets.length === 0) {
    console.error("使い方: node scripts/als-group.js <入力.als> <出力.als> <グループ名> <名前 or Id> ...");
    process.exit(2);
  }
  if (fs.existsSync(output)) throw new Error(`出力先が既にあります: ${output}`);

  // Live で開いたままのセットを書き換えても画面には反映されず、
  // Live 側から保存すると生成した内容が消える。既定では止める。
  if (isOpenInLive(input) && !force) {
    await notify(
      `${path.basename(input)} は Live で開いています。書き出しを中止しました`,
      { level: "warn" }
    );
    console.error(
      "\n書き出しても Live の画面には反映されず、Live 側から保存すると生成した内容が消えます。\n" +
        "先に Live で別のセットを開くか、承知のうえで進めるなら --force を付けてください。"
    );
    process.exitCode = 1;
    return;
  }

  const xml = readAls(input);
  const trackIds = resolveTrackTargets(listTracks(xml), targets);
  console.log(`対象: ${trackIds.join(", ")}`);

  const r = groupTracks(xml, { name, trackIds });
  writeAls(output, r.xml);

  await notify(
    `${path.basename(output)} に "${name}"（${trackIds.length} 本）を作成。開き直すと反映されます`
  );

  console.log(`グループ "${name}" を Id=${r.groupId} で作成`);
  console.log(`  シーン ${r.scenes} / センド ${r.sends} / 確保した id ${r.pointeeIds}`);
  console.log(`  ${output}`);
  for (const t of listTracks(r.xml)) {
    const g = t.groupId >= 0 ? ` (group ${t.groupId})` : "";
    console.log(`    ${String(t.id).padStart(3)} ${t.tag.padEnd(11)} ${t.name}${g}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
