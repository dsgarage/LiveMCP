#!/usr/bin/env node
// Live への通知と、Live が今どのセットを開いているかの判定。
//
// .als を書き換える経路と LOM の経路では「今のセット」が二重に存在する。
// Live で開いたままのセットを書き換えても画面には反映されず、Live 側から保存すると
// 生成した内容が消える。作業している場所（Live）で知らせる。
//
// 通知は Live のステータスバー（Application.show_message）へ出す。
// これは Remote Script からしか呼べない。M4L の LiveAPI には露出していない。
// Live にモーダルを出させる API は無いため、止める必要がある場面は
// 呼び出し側が書き出しを拒否する形で担保する。
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const PORT = 3361; // 検証用 Remote Script（remote-script/LiveMCP_Probe）

// Live のステータスバーへ 1 行出す。
// Remote Script が動いていなければ何もしない（呼び出し側が標準出力へ出す）。
function liveMessage(text) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: PORT }, () => {
      sock.write(JSON.stringify({ op: "message", text }) + "\n");
    });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(3000);
    sock.on("data", (d) => done(!d.toString().includes('"error"')));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

// Live へ出しつつ、ターミナルにも必ず残す。
// ステータスバーの表示は流れて消えるので、記録はこちらに残す前提。
async function notify(text, { level = "info" } = {}) {
  const shown = await liveMessage(`LiveMCP: ${text}`);
  const mark = level === "warn" ? "警告" : "情報";
  console.log(`[${mark}] ${text}${shown ? "" : "（Live へは届いていません）"}`);
  return shown;
}

// ログ本文から最後に読み込まれたユーザーのセットを拾う。
// トラック追加などで Live 内部のテンプレートも読まれるので、それは除く。
function parseCurrentDocument(text) {
  const hits = [...text.matchAll(/Loading document "([^"]+\.als)"/g)]
    .map((p) => p[1])
    .filter((p) => !p.includes("/Contents/App-Resources/"));
  return hits.length ? hits[hits.length - 1] : null;
}

// 「今開いているセット」を Live に問い合わせる手段が無いための代替。
// 確実ではない（Live が終了していても最後の 1 件が残る）。
function currentLiveDocument() {
  const base = path.join(os.homedir(), "Library/Preferences/Ableton");
  if (!fs.existsSync(base)) return null;

  const logs = fs
    .readdirSync(base)
    .map((d) => path.join(base, d, "Log.txt"))
    .filter((f) => fs.existsSync(f))
    .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (logs.length === 0) return null;

  // 末尾から探す。ログは数 MB になるので後ろだけ読む
  const size = fs.statSync(logs[0].f).size;
  const from = Math.max(0, size - 512 * 1024);
  const fd = fs.openSync(logs[0].f, "r");
  const buf = Buffer.alloc(size - from);
  fs.readSync(fd, buf, 0, buf.length, from);
  fs.closeSync(fd);

  return parseCurrentDocument(buf.toString("utf8"));
}

function isOpenInLive(file) {
  const doc = currentLiveDocument();
  if (!doc) return false;
  try {
    return fs.realpathSync(doc) === fs.realpathSync(file);
  } catch {
    return doc === file;
  }
}

module.exports = { liveMessage, notify, currentLiveDocument, parseCurrentDocument, isOpenInLive };
