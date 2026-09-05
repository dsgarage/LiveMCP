#!/usr/bin/env node
// .als の中のサンプル参照（FileRef）を調べ、切れているものを向け直す。
//
// FileRef は Live が書いた実物（Hard Drops.als）でこういう形:
//
//   <FileRef>
//     <RelativePathType Value="1" />
//     <RelativePath Value="../../../../../Library/Loopcloud/library/.../x.wav" />
//     <Path Value="/Users/.../Library/Loopcloud/library/.../x.wav" />
//     <Type Value="2" />
//     ...
//     <OriginalFileSize Value="3277766" />
//     <OriginalCrc Value="36090" />
//   </FileRef>
//
// RelativePath は .als のあるフォルダからの相対。プロジェクトフォルダごと移動すると
// 「../../../<旧プロジェクト名>/Samples/Imported/...」が旧位置を指して切れる。
// Live は相対パスを先に見るので、ここを実在のファイルへ向け直せば復旧する。
//
// 向け直しは RelativePath と Path の値だけを差し替え、他は 1 バイトも変えない
// （scripts/als.js と同じ方針。属性値は &amp; 等で XML エスケープする）。
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const AUDIO_EXT = /\.(wav|aif|aiff|flac|mp3|ogg|m4a)$/i;

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function unescapeAttr(s) {
  return String(s)
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// ライブラリ配下の音声ファイルをファイル名で引ける索引にする。
// 59,000 件規模でも数秒。stat はせず、サイズ確認が要るときだけ後で取る。
function buildIndex(roots) {
  const index = new Map();
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (AUDIO_EXT.test(e.name)) {
        const list = index.get(e.name) || [];
        list.push(p);
        index.set(e.name, list);
      }
    }
  };
  for (const r of [].concat(roots)) walk(r);
  return index;
}

// XML 上の FileRef を位置つきで列挙する
function listFileRefs(xml) {
  const out = [];
  const re = /<FileRef>[\s\S]*?<\/FileRef>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[0];
    const rel = /<RelativePath Value="([^"]*)" \/>/.exec(block);
    const abs = /<Path Value="([^"]*)" \/>/.exec(block);
    const size = /<OriginalFileSize Value="(\d+)" \/>/.exec(block);
    if (!rel || !abs) continue;
    out.push({
      start: m.index,
      end: m.index + block.length,
      relativePath: unescapeAttr(rel[1]),
      path: unescapeAttr(abs[1]),
      originalSize: size ? Number(size[1]) : null,
    });
  }
  return out;
}

function isAudioRef(ref) {
  return AUDIO_EXT.test(ref.path) || AUDIO_EXT.test(ref.relativePath);
}

// Live と同じ順で解決を試みる: 相対 → 絶対
function resolveRef(ref, alsDir) {
  if (ref.relativePath) {
    const p = path.resolve(alsDir, ref.relativePath);
    if (fs.existsSync(p)) return p;
  }
  if (ref.path && fs.existsSync(ref.path)) return ref.path;
  return null;
}

// 切れた参照の行き先を決める。
//   1. 索引（Loopcloud）でファイル名が一意に見つかればそれ
//   2. 複数あればサイズが一致するもの
//   3. 無ければ fallbackDirs（プロジェクト自身の Samples/Imported 等）
function findTarget(ref, { index, fallbackDirs = [] }) {
  const name = path.basename(ref.path || ref.relativePath);
  const candidates = index.get(name) || [];

  const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return -1; } };
  const pick = (list) => {
    if (list.length === 1) return { target: list[0], reason: "unique" };
    if (ref.originalSize != null) {
      const hit = list.filter((p) => sizeOf(p) === ref.originalSize);
      if (hit.length === 1) return { target: hit[0], reason: "size" };
      if (hit.length > 1) return { target: null, reason: "ambiguous" };
    }
    return { target: null, reason: "ambiguous" };
  };

  if (candidates.length) {
    const r = pick(candidates);
    if (r.target) return r;
    return r; // ambiguous
  }
  for (const dir of fallbackDirs) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return { target: p, reason: "fallback" };
  }
  return { target: null, reason: "not_found" };
}

// 1 ブロックの RelativePath / Path を差し替える
function retarget(block, alsDir, target) {
  const rel = path.relative(alsDir, target).split(path.sep).join("/");
  return block
    .replace(/<RelativePath Value="[^"]*" \/>/, `<RelativePath Value="${escapeAttr(rel)}" />`)
    .replace(/<Path Value="[^"]*" \/>/, `<Path Value="${escapeAttr(target)}" />`);
}

/**
 * 切れている音声参照を向け直した XML を返す。触っていない部分は変えない。
 * @returns {{ xml, repaired: object[], unresolved: object[], ambiguous: object[], sizeMismatch: object[], ok: number }}
 */
function repairXml(xml, alsDir, opts) {
  // allowSizeMismatch: 同名で一意に見つかるがサイズが違うものも向け直す。
  // Loopcloud の再ダウンロードでメタデータチャンクだけが変わった場合に使う
  // （実測では記録より一定量小さいだけで、音声本体は同じと判断できた）。
  const { index, fallbackDirs = [], checkSize = true, allowSizeMismatch = false } = opts;
  const refs = listFileRefs(xml).filter(isAudioRef);

  const repaired = [], unresolved = [], ambiguous = [], sizeMismatch = [];
  let ok = 0;

  // 後ろから置換すると前の位置がずれない
  let out = xml;
  for (const ref of [...refs].reverse()) {
    if (resolveRef(ref, alsDir)) { ok++; continue; }

    const { target, reason } = findTarget(ref, { index, fallbackDirs });
    const name = path.basename(ref.path || ref.relativePath);
    if (!target) {
      (reason === "ambiguous" ? ambiguous : unresolved).push({ name, path: ref.path });
      continue;
    }
    let sizeDiff = null;
    if (checkSize && ref.originalSize != null) {
      const size = fs.statSync(target).size;
      if (size !== ref.originalSize) {
        if (!allowSizeMismatch) {
          sizeMismatch.push({ name, path: ref.path, target, expected: ref.originalSize, actual: size });
          continue;
        }
        sizeDiff = ref.originalSize - size;
      }
    }
    const block = out.slice(ref.start, ref.end);
    out = out.slice(0, ref.start) + retarget(block, alsDir, target) + out.slice(ref.end);
    repaired.push({ name, from: ref.path, to: target, reason: sizeDiff != null ? "size_mismatch_allowed" : reason, sizeDiff });
  }

  return { xml: out, repaired: repaired.reverse(), unresolved, ambiguous, sizeMismatch, ok };
}

module.exports = { AUDIO_EXT, escapeAttr, unescapeAttr, buildIndex, listFileRefs, isAudioRef, resolveRef, findTarget, retarget, repairXml };
