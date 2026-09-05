#!/usr/bin/env node
// device/LiveMCP.maxpat から device/LiveMCP.amxd を生成し、必要なら User Library へ導入する。
//
//   node scripts/build-device.js            .amxd を生成するだけ
//   node scripts/build-device.js --install  User Library へ .amxd と .js を配置する
//
// 配置するファイル名は常に固定にする。Live のブラウザに LiveMCP が 1 つだけ並ぶようにするため、
// 以前の --fresh（毎回タイムスタンプ付きの名前で書き出す方式）は廃止し、
// 古い世代が残っていれば導入時に片付ける。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { buildAmxd, verifyRoundTrip } = require("./amxd");

const REPO = path.resolve(__dirname, "..");
const MAXPAT = path.join(REPO, "device", "LiveMCP.maxpat");
const AMXD = path.join(REPO, "device", "LiveMCP.amxd");
const BUNDLE = path.join(REPO, "device", "code", "mcp-server.js");
const BRIDGE = path.join(REPO, "device", "code", "live-bridge.js");

const INSTALL_DIR = path.join(
  os.homedir(),
  "Music/Ableton/User Library/Presets/Audio Effects/Max Audio Effect/LiveMCP"
);

// Live 上のデバイスからは .amxd と同じフォルダが Max の検索パスに入らない。
// js だけでなく node.script も同じ制約を受けるため（Live 実機で N4M PM は起動するが
// スクリプト本体が起動しないことを確認）、ブリッジとバンドルの両方を
// Max の標準ユーザーライブラリにも置く。
const MAX_LIBRARY = path.join(os.homedir(), "Documents/Max 9/Library");

// 配置時のファイル名。パッチが参照する名前と一致させること。
// Max のユーザーライブラリは他のパッチと共有なので、LiveMCP のものと分かる名前にする。
const SCRIPTS = [
  [BUNDLE, "livemcp-server.js"],
  [BRIDGE, "livemcp-bridge.js"],
];
const FILES = [[AMXD, "LiveMCP.amxd"], ...SCRIPTS];

// Live 同梱の純正デバイスで書き出しロジックを検証する（見つからなければ黙って飛ばす）
const FACTORY_SAMPLES = [
  "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Misc/Max Devices/Max Audio Effect.amxd",
  "/Applications/Ableton Live 12 Standard.app/Contents/App-Resources/Misc/Max Devices/Max Audio Effect.amxd",
];

function selfCheck() {
  for (const sample of FACTORY_SAMPLES) {
    if (!fs.existsSync(sample)) continue;
    const r = verifyRoundTrip(sample);
    if (!r.ok) throw new Error(`.amxd 書き出しロジックが純正デバイスと一致しません: ${sample}`);
    return path.basename(sample);
  }
  return null;
}

// --fresh 時代（タイムスタンプ付きの名前で書き出していた頃）の生成物を片付ける。
// 残っていると Live のブラウザに LiveMCP が何個も並んで、どれが最新か分からなくなる。
const LEGACY = [
  /^LiveMCP-\d{10}\.amxd$/,
  /^livemcp-server-\d{10}\.js$/,
  /^livemcp-bridge-\d{10}\.js$/,
  /^mcp-server\.js$/, // 旧称。Max のユーザーライブラリに置くには一般的すぎる名前だった
  /^live-bridge\.js$/,
];

function cleanLegacy(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!LEGACY.some((re) => re.test(name))) continue;
    fs.unlinkSync(path.join(dir, name));
    console.log(`[clean] ${path.join(dir, name)}`);
  }
}

function main() {
  const install = process.argv.includes("--install");

  const checked = selfCheck();
  if (checked) console.log(`[check] 純正デバイス ${checked} と書き出し結果がバイト一致`);

  const patcherJson = fs.readFileSync(MAXPAT, "utf8");
  JSON.parse(patcherJson); // 壊れた JSON を .amxd に閉じ込めないための検査
  fs.writeFileSync(AMXD, buildAmxd(patcherJson, "audio_effect"));
  console.log(`[build] ${path.relative(REPO, AMXD)} (${fs.statSync(AMXD).size} bytes)`);

  if (!install) {
    console.log("導入するには --install を付けて実行してください");
    return;
  }

  if (!fs.existsSync(BUNDLE)) {
    throw new Error(`${path.relative(REPO, BUNDLE)} がありません。先に npm run build を実行してください`);
  }

  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  cleanLegacy(INSTALL_DIR);
  cleanLegacy(MAX_LIBRARY);

  for (const [src, name] of FILES) {
    fs.copyFileSync(src, path.join(INSTALL_DIR, name));
    console.log(`[install] ${path.join(INSTALL_DIR, name)}`);
  }

  if (fs.existsSync(MAX_LIBRARY)) {
    for (const [src, name] of SCRIPTS) {
      fs.copyFileSync(src, path.join(MAX_LIBRARY, name));
      console.log(`[install] ${path.join(MAX_LIBRARY, name)}`);
    }
  } else {
    console.log(`[skip] ${MAX_LIBRARY} が無いため Max 検索パスへの配置を省略しました`);
  }
  console.log("\nLive のブラウザ → User Library → Presets → Audio Effects → Max Audio Effect → LiveMCP");
  console.log("既にトラックに載せている場合は、入れ替えを反映させるため Live を再起動してください。");
}

main();
