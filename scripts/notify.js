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

// ログ本文から「今開いているセット」を拾う。
//
// Live の Log.txt に出る並び（12.4.5 実機で確認）:
//   セットを開く:      Begin/End ExchangeDocument → Loading document "X.als" → Begin/End ExchangeDocument
//   新規セット(Cmd+N): Begin/End ExchangeDocument だけ（Loading document は出ない）
//   起動:              Begin/End ExchangeDocument → Loading document "…/Builtin/Templates/DefaultLiveSet.als" → Begin/End ExchangeDocument
//   トラック追加:      Loading document "…/Defaults/Creating Tracks/…/Default MIDI Track.als"（ExchangeDocument は出ない）
//
// なので、Live 内部のファイル（/Contents/App-Resources/）の読み込みは無視し、ユーザーのセットを読んだ後に
// ExchangeDocument が 2 回以上出たら「別のセットに入れ替わった（新規・未保存）」として null にする。
function parseCurrentDocument(text) {
  let doc = null;
  let exchanges = 0; // 最後にユーザーのセットを読んでからの End ExchangeDocument の回数（読み込み直後の 1 回は正常）
  const re = /Loading document "([^"]+\.als)"|End ExchangeDocument/g;
  for (const m of text.matchAll(re)) {
    if (m[1] === undefined) {
      exchanges++;
      if (exchanges >= 2) doc = null;
    } else if (!m[1].includes("/Contents/App-Resources/")) {
      doc = m[1];
      exchanges = 0;
    }
  }
  return doc;
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

// 検証用 Remote Script（LiveMCP_Probe）に今のセットを聞く。動いていなければ null。
// song.file_path が空なら未保存の新規セットなので { path: null } を返す
function probeCurrentDocument() {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: PORT }, () => {
      sock.write(JSON.stringify({ op: "state" }) + "\n");
    });
    let buf = "";
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(2000);
    sock.on("data", (d) => {
      buf += d.toString();
      try { const r = JSON.parse(buf); done("file_path" in r ? { path: r.file_path || null } : null); } catch { /* まだ途中 */ }
    });
    sock.on("timeout", () => done(null));
    sock.on("error", () => done(null));
  });
}

// 今開いているセット。Remote Script が答えられればそれを正とし、無ければログから推定する
async function currentLiveDocumentAsync() {
  const probed = await probeCurrentDocument();
  if (probed) return probed.path;
  return currentLiveDocument();
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

module.exports = { liveMessage, notify, currentLiveDocument, currentLiveDocumentAsync, probeCurrentDocument, parseCurrentDocument, isOpenInLive };
