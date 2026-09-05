#!/usr/bin/env node
// WAV / AIFF 1 本が「ループ」か「ワンショット」かをファイル自体から判定する。
//
//   node scripts/sample-kind.js <file|dir>...            判定結果を 1 行ずつ
//   node scripts/sample-kind.js --calibrate <packDir>    フォルダ名の分類（loopcloud-survey）と突き合わせて一致率を出す
//
// 判定はフォルダ名に頼らず、次の証拠を点数で合算する（+ がループ、− がワンショット）:
//   1. acid チャンクの type ビット（ベンダーが書いた正解。あれば最優先）
//   2. ファイル名の語（"Loop" / "One Shot" / "Hit" / "Riser" …）
//   3. 長さ（1 秒未満はワンショット、20 秒超はループ／ステム）
//   4. BPM（名前か acid）が分かるとき、長さが拍のちょうど整数倍か（ループは小節で切られている）
//   5. 波形の末尾: ワンショットは減衰して無音で終わる。ループは切りっぱなしで末尾にも音がある
//   6. 波形の先頭: ドラムのワンショットは頭にトランジェントが立つ
//
// 波形は末尾 1 秒・先頭 0.2 秒・全体を等間隔に 16 窓だけ読む（ファイル丸ごとは読まない）。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { audioInfo } = require("./audio-info");
const { parseSampleName } = require("./sample-meta");

const AUDIO = /\.(wav|aif|aiff)$/i;

// ---- 波形の読み出し --------------------------------------------------------

// startFrame から nFrames 分をモノラル（チャンネル平均）の Float64Array で返す
function readFrames(fd, info, startFrame, nFrames) {
  const bytesPerSample = info.bits / 8;
  const frameBytes = info.channels * bytesPerSample;
  const n = Math.max(0, Math.min(nFrames, info.frames - startFrame));
  const out = new Float64Array(n);
  if (n === 0) return out;
  const buf = Buffer.alloc(n * frameBytes);
  fs.readSync(fd, buf, 0, buf.length, info.dataOffset + startFrame * frameBytes);
  const be = info.bigEndian;
  const isFloat = info.formatTag === 3;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < info.channels; c++) {
      const o = i * frameBytes + c * bytesPerSample;
      let v;
      if (isFloat && info.bits === 32) v = be ? buf.readFloatBE(o) : buf.readFloatLE(o);
      else if (isFloat && info.bits === 64) v = be ? buf.readDoubleBE(o) : buf.readDoubleLE(o);
      else if (info.bits === 8) v = (buf[o] - 128) / 128;
      else if (info.bits === 16) v = (be ? buf.readInt16BE(o) : buf.readInt16LE(o)) / 32768;
      else if (info.bits === 24) v = (be ? readInt24BE(buf, o) : readInt24LE(buf, o)) / 8388608;
      else if (info.bits === 32) v = (be ? buf.readInt32BE(o) : buf.readInt32LE(o)) / 2147483648;
      else v = 0;
      sum += v;
    }
    out[i] = sum / info.channels;
  }
  return out;
}
const readInt24LE = (b, o) => { const v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); return v & 0x800000 ? v - 0x1000000 : v; };
const readInt24BE = (b, o) => { const v = (b[o] << 16) | (b[o + 1] << 8) | b[o + 2]; return v & 0x800000 ? v - 0x1000000 : v; };

const rms = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return a.length ? Math.sqrt(s / a.length) : 0; };
const peak = (a) => { let m = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v; } return m; };

// 波形の特徴量。tailRatio が小さいほど「減衰して終わる」
function waveformFeatures(file, info) {
  if (info.dataOffset == null || info.formatTag === 0 || info.frames < 8) return null;
  const sr = info.sampleRate;
  const fd = fs.openSync(file, "r");
  try {
    // 全体の RMS: 16 窓 × 50ms を等間隔に
    const win = Math.floor(sr * 0.05);
    const windows = [];
    for (let k = 0; k < 16; k++) {
      const start = Math.floor((info.frames - win) * (k / 15));
      windows.push(rms(readFrames(fd, info, Math.max(0, start), win)));
    }
    const bodyRms = Math.sqrt(windows.reduce((a, r) => a + r * r, 0) / windows.length);
    const bodyPeakRms = Math.max(...windows);

    // 末尾: 最後の 100ms と、無音（body の 1/100 = −40dB 未満）が続いている長さ
    const tailFrames = Math.min(info.frames, sr);
    const tail = readFrames(fd, info, info.frames - tailFrames, tailFrames);
    const tail100 = tail.subarray(Math.max(0, tail.length - Math.floor(sr * 0.1)));
    const tailRms = rms(tail100);
    let silent = 0;
    const thr = Math.max(bodyPeakRms * 0.01, 1e-4);
    for (let i = tail.length - 1; i >= 0; i--) { if (Math.abs(tail[i]) > thr) break; silent++; }

    // 先頭: 最初の 20ms の RMS が全体に対してどれだけ立っているか
    const head = readFrames(fd, info, 0, Math.floor(sr * 0.2));
    const head20 = head.subarray(0, Math.floor(sr * 0.02));
    const headRms = rms(head20);

    return {
      bodyRms, bodyPeakRms, tailRms,
      tailRatio: bodyPeakRms > 0 ? tailRms / bodyPeakRms : 0,
      silentTailSec: silent / sr,
      headRatio: bodyPeakRms > 0 ? headRms / bodyPeakRms : 0,
      peak: Math.max(peak(head), peak(tail)),
    };
  } finally {
    fs.closeSync(fd);
  }
}

// ---- 判定 ------------------------------------------------------------------

const NAME_LOOP = /LOOP|LPS\b|PHRASE|RIFF|PROGRESSION|GROOVE|BEAT\b|STEM|FULL.?MIX|MAIN.?MIX|SONG|MELODY|ARP\b|SEQ(UENCE)?\b|TOP.?LOOP|\bBAR\b|\d+BARS?|FILL\b|BUILD/i;
// 打楽器・スタブなどの短い素材。名前だけでは弱い証拠（"Kick" が付いたループもある）
const NAME_ONESHOT = /ONE.?SHOTS?|SHOTS?\b|HITS?\b|STAB|CRASH|KICK|SNARE|CLAP|HAT\b|HIHAT|CYMBAL|RIDE|TOM\b|RIM|PERC\b|SHAKER|SNAP|CLICK|BLIP|ZAP|LASER|DROP\b|VOX.?SHOT|CHORD.?SHOT|BOOM|SUB.?DROP/i;
// FX 系。ライザーやテクスチャは長くて小節に合わせてあり、末尾も鳴っているので、
// 波形と長さだけ見るとループに見える。名前が FX 系なら長さ・拍の証拠は使わない
const NAME_FX = /\bFX\b|_FX|FX_|EFFECT|SFX|IMPACT|RISER|UPLIFT|DOWNLIFT|DOWNSHIFT|SHIFTER|SWEEP|WHOOSH|TEXTURE|DRONE|NOISE|REVERSE|TRANSITION|SWELL/i;
// 音名 + オクターブ（"_A2" / "_C#3_"）が入っていればマルチサンプル（音ごとの単発）。入っているフォルダ名の MULTI も同じ
const NAME_NOTE = /[_\s-][A-G]#?\d([_\s-]|$)/;
const DIR_MULTI = /MULTI/i;

// 長さが拍の整数倍か（ループは小節で切られている）。誤差は 1 拍の 1.5% まで
function beatsFit(seconds, bpm) {
  if (!bpm || !seconds) return null;
  const beats = (seconds * bpm) / 60;
  const nearest = Math.round(beats);
  if (nearest < 1) return { beats, fits: false };
  const err = Math.abs(beats - nearest);
  return { beats, nearest, err, fits: err < 0.015 && nearest >= 1 };
}

// 返り値: { kind: "loop" | "oneshot", score, confidence, reasons, features }
//   score は −1（確実にワンショット）〜 +1（確実にループ）。0 はどちらとも言えない（フォルダの分類に従う）
//   confidence は |score|
//
// 重みは 6 パック 2,500 本（フォルダ名で分類済み）に当てて決めた。sample-kind.js --calibrate で再計測できる
//
// dir: 入っているフォルダ名（既定はファイルの親フォルダ）。"UPLIFTERS" / "BASS_MULTIS" のようにフォルダ名だけが
//      種類を言っているベンダーがあるので、FX 系とマルチサンプルの判定にはフォルダ名も使う
// loopcloud: LoopcloudDb.lookup() の結果（{ contentType, instrument, … }）。Loopcloud が付けた種別タグが
//      あればそれを正解として最優先にする（±1.0。フォルダ分類を足しても覆らない）
// info: 呼び出し側が既に読んだ audioInfo() の結果（ヘッダの二度読みを避ける）
function classifySample(file, { skipWaveform = false, dir = path.basename(path.dirname(file)), loopcloud = null, info: givenInfo = null } = {}) {
  const info = givenInfo || audioInfo(file);
  if (!info) return { kind: null, score: 0, confidence: 0, reasons: ["読めないフォーマット"], features: null };
  const meta = parseSampleName(file);
  const seconds = info.seconds;
  const bpm = meta.bpm || (info.acidTempo ? Math.round(info.acidTempo) : null) || (loopcloud && loopcloud.bpm ? Math.round(loopcloud.bpm) : null);
  const stem = path.basename(file).replace(/\.[^.]+$/, "");
  const reasons = [];
  let score = 0;
  const add = (v, why) => { score += v; reasons.push(`${v > 0 ? "+" : ""}${v.toFixed(2)} ${why}`); };

  // 0. Loopcloud のタグ（Content Types > One Shots / Loops）。あればこれが正解なので、他の証拠は見ない（波形も読まない）
  if (loopcloud && (loopcloud.contentType === "oneshot" || loopcloud.contentType === "loop")) {
    const isShot = loopcloud.contentType === "oneshot";
    add(isShot ? -1.0 : +1.0, `Loopcloud: ${isShot ? "One Shots" : "Loops"}${loopcloud.instrument ? "（" + loopcloud.instrument.join(" > ") + "）" : ""}`);
    return { kind: loopcloud.contentType, score, confidence: 1, reasons, tagged: true, features: { seconds, bpm, acidOneShot: info.acidOneShot, acidBeats: info.acidBeats } };
  }

  // 1. acid チャンク。one-shot ビットはほぼ正しいが、ループ側は単発のスネアに "loop 4 拍" と付けるベンダーもいる
  //    （Loopmasters の無料パックで確認）ので、ループ側は弱めにする
  if (info.acidOneShot === true) add(-0.9, "acid: one-shot");
  else if (info.acidOneShot === false && info.acidBeats > 0) add(+0.6, `acid: loop ${info.acidBeats} 拍`);

  // 2. ファイル名
  // "Combo_Fx_12Bar" のようにループ語と FX 語が同居していたらループ語を信じる
  const loopName = NAME_LOOP.test(stem);
  const fxName = (NAME_FX.test(stem) || NAME_FX.test(dir || "")) && !loopName;
  if (loopName) add(+0.5, "名前がループ系");
  if (fxName) add(-0.7, NAME_FX.test(stem) ? "名前が FX 系" : `フォルダが FX 系（${dir}）`);
  else if (NAME_ONESHOT.test(stem)) add(-0.5, "名前がワンショット系");
  if (NAME_NOTE.test(stem)) add(-0.5, "音名付き（マルチサンプル）");
  else if (DIR_MULTI.test(dir || "") && !loopName) add(-0.5, `マルチサンプルのフォルダ（${dir}）`);

  // 3. 長さ（FX 系は長くても単発なので見ない）
  if (seconds < 0.6) add(-0.8, `${seconds.toFixed(2)} 秒`);
  else if (seconds < 1.2) add(-0.4, `${seconds.toFixed(2)} 秒`);
  else if (fxName) { /* skip */ }
  else if (seconds > 10) add(+0.5, `${seconds.toFixed(1)} 秒`);
  else if (seconds > 6) add(+0.2, `${seconds.toFixed(1)} 秒`);

  // 4. 拍の整数倍（FX 系は小節に合わせたライザーが多いので見ない）
  const fit = beatsFit(seconds, bpm);
  if (fxName) { /* skip */ }
  else if (fit && fit.fits && fit.nearest >= 4) add(+0.7, `${bpm} BPM で ${fit.nearest} 拍ちょうど`);
  else if (fit && fit.fits) add(+0.2, `${bpm} BPM で ${fit.nearest} 拍ちょうど`);
  else if (fit && seconds >= 1.2 && fit.err > 0.1) add(-0.3, `${bpm} BPM で ${fit.beats.toFixed(2)} 拍（端数）`);

  // 5. 6. 波形
  let wf = null;
  if (!skipWaveform) {
    try { wf = waveformFeatures(file, info); } catch (e) { reasons.push("波形読めず: " + e.message); }
  }
  if (wf) {
    // 末尾の無音は短い素材ほど強い証拠（15 秒のフレーズが減衰して終わるのは普通）
    const w = seconds < 4 ? 1 : seconds < 10 ? 0.6 : 0.2;
    if (wf.tailRatio < 0.02 || wf.silentTailSec > 0.05) add(-0.5 * w, `末尾が無音（${(wf.tailRatio * 100).toFixed(1)}% / 無音 ${wf.silentTailSec.toFixed(2)}s）`);
    else if (wf.tailRatio < 0.08) add(-0.25 * w, `末尾が減衰（${(wf.tailRatio * 100).toFixed(1)}%）`);
    else if (wf.tailRatio > 0.3) add(+0.5, `末尾にも音（${(wf.tailRatio * 100).toFixed(0)}%）`);
    else if (wf.tailRatio > 0.15) add(+0.25, `末尾にも音（${(wf.tailRatio * 100).toFixed(0)}%）`);
    if (wf.headRatio > 0.9 && seconds < 2) add(-0.2, "頭にトランジェント");
  }

  score = Math.max(-1, Math.min(1, Math.round(score * 100) / 100));
  return {
    kind: score > 0 ? "loop" : score < 0 ? "oneshot" : null,
    score,
    confidence: Math.min(1, Math.abs(score)),
    reasons,
    tagged: !!(loopcloud && loopcloud.contentType), // Loopcloud のタグで決まった
    features: { seconds, bpm, acidOneShot: info.acidOneShot, acidBeats: info.acidBeats, beats: fit && fit.beats, ...(wf || {}) },
  };
}

// ファイルの判定とフォルダ名の分類（事前情報）を合わせて最終判定にする。
//   prior: "loop" | "oneshot" | null、priorStrength: "explicit"（Loops / One Shots のような明示）| "weak"（楽器名など）
// 返り値に flipped（フォルダと逆になった）と uncertain（|最終| < 0.3）を付ける。両方とも人が見直す候補。
// Loopcloud のタグで決まったものはフォルダを足さない（タグが正解）
function decideKind(fileResult, prior, priorStrength = "weak") {
  const p = prior === "loop" ? 1 : prior === "oneshot" ? -1 : 0;
  const pw = fileResult.tagged ? 0 : priorStrength === "explicit" ? 0.4 : 0.2;
  const final = Math.max(-1, Math.min(1, fileResult.score + p * pw));
  const kind = final > 0 ? "loop" : final < 0 ? "oneshot" : prior || "loop";
  return { kind, final: Math.round(final * 100) / 100, flipped: prior != null && kind !== prior, uncertain: Math.abs(final) < 0.3, tagged: !!fileResult.tagged };
}

// ---- CLI -------------------------------------------------------------------

function listAudioFiles(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return AUDIO.test(p) ? [p] : [];
  const out = [];
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const q = path.join(p, e.name);
    if (e.isDirectory()) out.push(...listAudioFiles(q));
    else if (AUDIO.test(e.name)) out.push(q);
  }
  return out;
}

// 自前の判定（Loopcloud タグ無し）を、Loopcloud のタグがあればそれと、無ければフォルダ名の分類と突き合わせる
function calibrate(packDir) {
  const { surveyPack } = require("./loopcloud-survey");
  const { LoopcloudDb } = require("./loopcloud-db");
  const lc = LoopcloudDb.shared();
  const s = surveyPack(packDir);
  const rows = [];
  for (const [folder, list] of [["loop", s.loops], ["oneshot", s.oneshots]]) {
    for (const f of list) {
      for (const file of listAudioFiles(path.join(packDir, f.name))) {
        const it = lc && lc.lookup(file);
        const label = (it && it.contentType) || folder;
        const r = classifySample(file, { dir: path.dirname(path.relative(packDir, file)) });
        rows.push({ label, source: it && it.contentType ? "Loopcloud" : "フォルダ", file, r });
      }
    }
  }
  const agree = rows.filter((x) => x.r.kind === x.label).length;
  const tie = rows.filter((x) => x.r.kind == null).length;
  const confident = rows.filter((x) => x.r.confidence >= 0.5);
  const agreeC = confident.filter((x) => x.r.kind === x.label).length;
  const lcN = rows.filter((x) => x.source === "Loopcloud").length;
  console.log(`${s.name}: ${rows.length} 本（正解: Loopcloud タグ ${lcN} / フォルダ ${rows.length - lcN}）  一致 ${agree} (${((agree / rows.length) * 100).toFixed(1)}%)  判定なし ${tie}  確信あり ${confident.length} 本中 一致 ${agreeC}`);
  for (const x of rows.filter((x) => x.r.kind != null && x.r.kind !== x.label)) {
    console.log(`  不一致  ${x.source}=${x.label.padEnd(7)} 判定=${x.r.kind.padEnd(7)} ${x.r.score.toFixed(2)}  ${path.relative(packDir, x.file)}`);
    console.log(`          ${x.r.reasons.join(" / ")}`);
  }
  return rows;
}

module.exports = { classifySample, decideKind, waveformFeatures, beatsFit, readFrames, listAudioFiles };

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--calibrate") {
    for (const d of argv.slice(1)) calibrate(d);
  } else {
    for (const p of argv) {
      for (const f of listAudioFiles(p)) {
        const r = classifySample(f);
        console.log(`${(r.kind || "?").padEnd(7)} ${r.score.toFixed(2).padStart(5)}  ${path.basename(f)}`);
        console.log(`        ${r.reasons.join(" / ")}`);
      }
    }
  }
}
