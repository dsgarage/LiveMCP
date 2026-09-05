#!/usr/bin/env node
// 検証用 Remote Script（remote-script/LiveMCP_Probe）へ 1 コマンド投げて結果を表示する。
//
//   node scripts/remote-probe.js ping
//   node scripts/remote-probe.js tracks
//   node scripts/remote-probe.js group '[7,13]'
//   node scripts/remote-probe.js save
//
// 1 リクエスト 1 接続。スクリプト側は Live のメインスレッド（update_display）で
// 受けるので、応答は最大 100ms 程度遅れる。
"use strict";

const net = require("node:net");

const PORT = 3361;

function main() {
  const [op, rawArgs] = process.argv.slice(2);
  if (!op) {
    console.error("使い方: node scripts/remote-probe.js <op> [JSON引数]");
    process.exit(2);
  }

  const req = { op };
  if (rawArgs) {
    const parsed = JSON.parse(rawArgs);
    if (op === "group") req.args = parsed;
    else Object.assign(req, parsed);
  }

  const sock = net.createConnection({ host: "127.0.0.1", port: PORT }, () => {
    sock.write(JSON.stringify(req) + "\n");
  });

  let buf = "";
  sock.setTimeout(10000);
  sock.on("data", (d) => (buf += d.toString()));
  sock.on("timeout", () => {
    console.error("応答がありません。Live で Control Surface が選択されているか確認してください");
    sock.destroy();
    process.exit(1);
  });
  sock.on("error", (e) => {
    console.error(`接続できません (${e.code})。Live が起動し、Control Surface が選択されていますか`);
    process.exit(1);
  });
  sock.on("close", () => {
    if (!buf.trim()) return;
    try {
      console.log(JSON.stringify(JSON.parse(buf), null, 2));
    } catch {
      console.log(buf);
    }
  });
}

main();
