#!/usr/bin/env node
// サンプルのファイル名から BPM とキーを読む。
//
// ベンダーごとの命名（実物で確認したもの）:
//   HD_808Loop_155_E_ColdHearted_FRK.wav      … Freaky Loops: <種別>_<BPM>_<キー>_<名前>
//   SMD_60_Bb_Oceanic_FX_Atmos.wav           … Sample Magic: <接頭辞>_<BPM>_<キー>_<名前>
//   SEP5_Song_01_F_130_BPM                   … Singomakers: <キー>_<BPM>_BPM
//   TTS_..._Right_C_BPM195_08.wav            … Tsunami: <キー>_BPM<数字>
//   Life-Beat 2026-06-06 - 128 bpm.wav       … Live の書き出し: "<数字> bpm"
"use strict";

const path = require("node:path");

const KEY = /^([A-G])(#|b)?(m|min|maj|M)?$/;

function parseSampleName(file) {
  const stem = path.basename(file).replace(/\.[^.]+$/, "");
  const tokens = stem.split(/[_\s\-]+/).filter(Boolean);

  let bpm = null;
  let bpmIdx = -1;
  let key = null;

  // "BPM195" / "195BPM" / "128 bpm"
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let m;
    if ((m = /^BPM(\d{2,3})$/i.exec(t)) || (m = /^(\d{2,3})BPM$/i.exec(t))) { bpm = Number(m[1]); bpmIdx = i; break; }
    if (/^bpm$/i.test(t) && i > 0 && /^\d{2,3}$/.test(tokens[i - 1])) { bpm = Number(tokens[i - 1]); bpmIdx = i - 1; break; }
  }
  // 素の 2〜3 桁（60〜200）を BPM とみなす。最初の 1 つだけ
  if (bpm == null) {
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (/^\d{2,3}$/.test(t)) { const n = Number(t); if (n >= 60 && n <= 200) { bpm = n; bpmIdx = i; break; } }
    }
  }
  // キー: BPM の隣を優先、無ければ最初に見つかったもの。1 文字だけの大文字は誤検出しやすいので
  // "E" のような単独は BPM の隣にある場合だけ採用する
  const isKey = (t) => KEY.test(t);
  if (bpmIdx >= 0) {
    // "93_bpm_D" のように bpm の語を挟んだ隣も見る
    const after = tokens[bpmIdx + 1] && /^bpm$/i.test(tokens[bpmIdx + 1]) ? bpmIdx + 2 : bpmIdx + 1;
    for (const j of [after, bpmIdx - 1]) if (tokens[j] && isKey(tokens[j])) { key = tokens[j]; break; }
  }
  if (key == null) {
    const cand = tokens.find((t) => isKey(t) && t.length >= 2);
    if (cand) key = cand;
  }
  return { bpm, key, stem };
}

// 並び順: テンポ → キー → ファイル名（ユーザー指定の規則）
const KEY_ORDER = ["C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B"];
function keyRank(k) {
  if (!k) return 99;
  const root = k.replace(/(m|min|maj|M)$/, "");
  const i = KEY_ORDER.indexOf(root);
  return (i < 0 ? 50 : i) + (/m|min$/.test(k) ? 0.5 : 0);
}
function compareSamples(a, b) {
  return (a.bpm || 0) - (b.bpm || 0) || keyRank(a.key) - keyRank(b.key) || a.stem.localeCompare(b.stem, undefined, { numeric: true });
}

// パック内で最も多い BPM をセットのテンポにする
function dominantBpm(list, fallback = 120) {
  const c = new Map();
  for (const s of list) if (s.bpm) c.set(s.bpm, (c.get(s.bpm) || 0) + 1);
  if (!c.size) return fallback;
  return [...c].sort((x, y) => y[1] - x[1])[0][0];
}

// セットのテンポ: 最も多い BPM が過半数ならそれ。そうでなければ中央値（クリップ群の真ん中。
// 200 BPM が 25% で最多でも残り 75% が 80〜125 なら 125 にする）
function centralBpm(list, fallback = 120) {
  const bpms = list.map((s) => s.bpm).filter(Boolean).sort((a, b) => a - b);
  if (!bpms.length) return fallback;
  const c = new Map();
  for (const b of bpms) c.set(b, (c.get(b) || 0) + 1);
  const [mode, count] = [...c].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0];
  if (count / bpms.length >= 0.5) return mode;
  return bpms[Math.floor(bpms.length / 2)];
}

module.exports = { parseSampleName, compareSamples, dominantBpm, centralBpm, keyRank };

if (require.main === module) for (const f of process.argv.slice(2)) console.log(f, parseSampleName(f));
