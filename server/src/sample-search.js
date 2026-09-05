// サンプルファイル検索。Live ブラウザは M4L から触れないため、
// node.script のファイルシステムアクセスで代替する。
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const AUDIO_EXTENSIONS = new Set([".wav", ".aif", ".aiff", ".flac", ".mp3", ".m4a", ".ogg"]);
const MAX_DEPTH = 6;
const MAX_RESULTS_HARD = 200;

/** ディレクトリを再帰走査してオーディオファイルの絶対パス一覧を返す */
function collectAudioFiles(root, depth = 0, out = []) {
  if (depth > MAX_DEPTH || out.length >= MAX_RESULTS_HARD * 10) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collectAudioFiles(full, depth + 1, out);
    } else if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

/**
 * クエリの各語がパスに含まれるファイルを返す（大文字小文字無視・AND 条件）
 * @param {string[]} folders 検索対象フォルダ（絶対パス）
 * @param {string} query 空文字なら全件
 * @param {number} limit
 */
function searchSamples(folders, query = "", limit = 25) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results = [];
  for (const folder of folders) {
    const files = collectAudioFiles(folder);
    for (const file of files) {
      const haystack = file.toLowerCase();
      if (terms.every((t) => haystack.includes(t))) {
        results.push(file);
        if (results.length >= Math.min(limit, MAX_RESULTS_HARD)) return results;
      }
    }
  }
  return results;
}

/**
 * サンプルフォルダの既定値。デバイス側で folders メッセージを送らなくても
 * 標準的な置き場所は検索できるようにする（存在するものだけ返す）。
 */
function defaultSampleFolders() {
  const home = os.homedir();
  const candidates = [
    path.join(home, "Music/Ableton/User Library/Samples"),
    path.join(home, "Music/Ableton/Factory Packs"),
  ];
  for (const edition of ["Suite", "Standard", "Intro", "Lite"]) {
    candidates.push(
      `/Applications/Ableton Live 12 ${edition}.app/Contents/App-Resources/Core Library/Samples`
    );
  }
  return candidates.filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

module.exports = { searchSamples, collectAudioFiles, defaultSampleFolders, AUDIO_EXTENSIONS };
