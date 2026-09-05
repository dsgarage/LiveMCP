#!/usr/bin/env node
// remote-script/ 配下を Live のユーザー Remote Scripts フォルダへ導入する。
//
//   node scripts/install-remote-script.js
//
// Remote Script はフォルダごと配置し、Live 再起動後に
// 環境設定 → Link/Tempo/MIDI の Control Surface で選択して初めて有効になる。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const REPO = path.resolve(__dirname, "..");
const SRC = path.join(REPO, "remote-script");
const DEST = path.join(os.homedir(), "Music/Ableton/User Library/Remote Scripts");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    // 生成物（レポート・キャッシュ）は配布側へ持ち込まない
    if (entry.name === "__pycache__" || entry.name.endsWith(".json")) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else {
      fs.copyFileSync(s, d);
      console.log(`[install] ${d}`);
    }
  }
}

function main() {
  if (!fs.existsSync(SRC)) throw new Error(`${path.relative(REPO, SRC)} がありません`);

  for (const entry of fs.readdirSync(SRC, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    copyDir(path.join(SRC, entry.name), path.join(DEST, entry.name));
  }

  console.log("\nLive を再起動し、環境設定 → Link/Tempo/MIDI の Control Surface で選択してください。");
}

main();
