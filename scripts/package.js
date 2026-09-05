#!/usr/bin/env node
// 配布 zip を作る: dist/LiveMCP-<version>.zip
//
//   node scripts/package.js [--out <dir>]
//
// 中身（install.sh が同じフォルダにあることを前提に配置する）:
//   LiveMCP.amxd          … device/LiveMCP.maxpat から生成（scripts/build-device.js と同じ）
//   livemcp-server.js     … server/src のバンドル（npm --prefix server run build）
//   livemcp-bridge.js     … device/code/live-bridge.js
//   LiveMCP.als           … LiveMCP を載せたテンプレートセット（scripts/template-set.js）
//   install.sh / README.txt
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { buildTemplateSet } = require("./template-set");

const REPO = path.resolve(__dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;

function main() {
  const argv = process.argv.slice(2);
  const outDir = argv.includes("--out") ? path.resolve(argv[argv.indexOf("--out") + 1]) : path.join(REPO, "dist");
  const stage = path.join(outDir, `LiveMCP-${version}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  // ビルド（バンドル + .amxd）
  execFileSync("npm", ["--prefix", "server", "run", "build"], { cwd: REPO, stdio: "inherit" });
  execFileSync("node", [path.join(REPO, "scripts", "build-device.js")], { cwd: REPO, stdio: "inherit" });

  const files = [
    [path.join(REPO, "device", "LiveMCP.amxd"), "LiveMCP.amxd"],
    [path.join(REPO, "device", "code", "mcp-server.js"), "livemcp-server.js"],
    [path.join(REPO, "device", "code", "live-bridge.js"), "livemcp-bridge.js"],
    [path.join(REPO, "dist-src", "install.sh"), "install.sh"],
  ];
  for (const [src, name] of files) {
    if (!fs.existsSync(src)) throw new Error(`${path.relative(REPO, src)} がありません`);
    fs.copyFileSync(src, path.join(stage, name));
  }
  fs.chmodSync(path.join(stage, "install.sh"), 0o755);

  // テンプレートセット
  buildTemplateSet(path.join(stage, "LiveMCP.als"));

  fs.writeFileSync(path.join(stage, "README.txt"), readme());

  const zip = path.join(outDir, `LiveMCP-${version}.zip`);
  fs.rmSync(zip, { force: true });
  execFileSync("zip", ["-qr", zip, `LiveMCP-${version}`], { cwd: outDir });
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(`[package] ${path.relative(REPO, zip)} (${fs.statSync(zip).size} bytes)`);
  for (const [, name] of files) console.log(`  ${name}`);
  console.log("  LiveMCP.als\n  README.txt");
}

function readme() {
  return `LiveMCP ${version} — Ableton Live 内で完結する MCP サーバー

導入:
  sh install.sh

  User Library の場所が既定（~/Music/Ableton/User Library）と違うときは
  LIVE_USER_LIBRARY="/path/to/User Library" sh install.sh

使い方:
  1. Live を再起動する
  2. ブラウザ → User Library → Templates → LiveMCP から新規セットを作る
     （既存のセットでは Presets → Audio Effects → Max Audio Effect → LiveMCP をトラックへ）
  3. Claude Code で「live.status を実行して」

Claude Code への登録（install.sh が済ませていなければ）:
  claude mcp add --transport http live-mcp http://localhost:3360/mcp

動作要件: Ableton Live 12.4 以上 + Max for Live
詳細: https://github.com/dsgarage/LiveMCP/wiki
`;
}

main();
