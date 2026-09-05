// .als ファイルを対象にする操作（動いているセットの LOM 操作とは別系統）。
//
// 音楽家の UI は Claude との会話なので、.als の生成も CLI ではなくツールとして
// 露出させる。ここは Live を経由しない純粋なファイル操作で、判断が要る場面
// （Live で開いている等）は例外の文言で状況と選択肢を返し、会話に委ねる。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const als = require("../../scripts/als");
const notifyLib = require("../../scripts/notify");

// テンプレートはリポジトリでは templates/ から読む（scripts/als.js の既定動作）。
// esbuild のバンドルでは __dirname が導入先になり読めないため、
// バンドル専用エントリ（bundle-entry.js）が文字列として焼き込む。

function openInLiveApp(file) {
  return new Promise((resolve) => {
    execFile("open", [file], (err) => resolve(!err));
  });
}

/**
 * @param {object} deps テストから差し替えるための依存。既定は実物
 */
function createSetTools({
  isOpenInLive = notifyLib.isOpenInLive,
  currentLiveDocument = notifyLib.currentLiveDocumentAsync, // Remote Script が動いていれば実際の file_path（未保存なら null）
  liveMessage = notifyLib.liveMessage,
  openApp = openInLiveApp,
} = {}) {
  async function groupTracksInSet(args) {
    const setPath = args.setPath || (await currentLiveDocument());
    if (!setPath) {
      throw new Error(
        "対象のセットが分かりません（未保存の新規セットか、Live が開いているセットを判定できません）。setPath で .als の絶対パスを指定してください"
      );
    }
    if (!fs.existsSync(setPath)) {
      throw new Error(`セットが見つかりません: ${setPath}`);
    }

    const inPlace = !args.output;
    const output = args.output || setPath;

    // Live で開いたままのセットを置き換えると、Live の画面には反映されず、
    // Live 側から保存した時点で生成した内容が消える。ここでは書かずに状況を返し、
    // どうするか（先に別のセットを開く / 別名で書き出す）は会話で決めてもらう。
    if (inPlace && isOpenInLive(setPath)) {
      await liveMessage(`LiveMCP: ${path.basename(setPath)} は開いたままのため書き出しを保留しました`);
      throw new Error(
        `${path.basename(setPath)} は Live で開かれているため、置き換えでの書き出しを中止しました。` +
          "書き換えても Live の画面には反映されず、Live 側で保存すると生成内容が消えます。" +
          "選択肢: (1) Live で別のセットを開いてからもう一度実行する " +
          "(2) output に別のパスを指定して書き出し、そちらを Live で開く"
      );
    }
    if (!inPlace && fs.existsSync(output)) {
      throw new Error(`出力先が既にあります: ${output}`);
    }

    const xml = als.readAls(setPath);
    const trackIds = als.resolveTrackTargets(als.listTracks(xml), args.tracks);
    const r = als.groupTracks(xml, { name: args.groupName, trackIds });

    // 置き換えのときは Live 純正の Backup/ と同じ場所・同じ命名で退避してから書く
    let backup = null;
    if (inPlace) backup = als.writeAlsWithBackup(setPath, r.xml);
    else als.writeAls(output, r.xml);

    await liveMessage(
      `LiveMCP: ${path.basename(output)} に "${args.groupName}"（${trackIds.length} 本）を作成しました`
    );

    let opened = false;
    if (args.open) {
      opened = await openApp(output);
    }

    return {
      output,
      group_name: args.groupName,
      group_id: r.groupId,
      grouped_tracks: trackIds.length,
      backup,
      opened,
      note: opened
        ? "Live で開きました。未保存の変更がある場合は Live が保存を確認します"
        : "Live で開き直すと反映されます",
    };
  }

  return { groupTracksInSet };
}

module.exports = { createSetTools, backupPath: als.backupPath };
