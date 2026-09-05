#!/usr/bin/env node
// プロジェクト内の .als の切れた音声参照を、Loopcloud ライブラリの実ファイルへ向け直す。
//
//   node scripts/als-repair.js <プロジェクトフォルダ | .als> [--dry-run] [--library <dir>] [--allow-size-mismatch]
//
// 既定のライブラリは ~/Library/Loopcloud/library。
// --allow-size-mismatch は、同名で一意に見つかるがサイズが違うものも向け直す
// （Loopcloud の再ダウンロードでメタデータチャンクだけ変わった場合）。
// 索引に無いものはプロジェクト自身の Samples/Imported・Recorded・Processed を探す。
//
// 書き換える前に Live 純正の Backup/ と同じ流儀で退避する。削除は一切しない。
// Live で開いているセットは対象外（画面に反映されず、保存で消えるため）。
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readAls, writeAlsWithBackup } = require("./als");
const { buildIndex, repairXml } = require("./als-refs");
const { isOpenInLive, notify } = require("./notify");

const DEFAULT_LIBRARY = path.join(os.homedir(), "Library/Loopcloud/library");

function targets(input) {
  const st = fs.statSync(input);
  if (st.isFile()) return [path.resolve(input)];
  return fs
    .readdirSync(input)
    .filter((f) => f.endsWith(".als"))
    .map((f) => path.join(path.resolve(input), f));
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const allowSizeMismatch = argv.includes("--allow-size-mismatch");
  const libIdx = argv.indexOf("--library");
  const library = libIdx >= 0 ? argv[libIdx + 1] : DEFAULT_LIBRARY;
  const input = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--library")[0];
  if (!input) {
    console.error("使い方: node scripts/als-repair.js <プロジェクトフォルダ | .als> [--dry-run] [--library <dir>] [--allow-size-mismatch]");
    process.exit(2);
  }

  console.log(`索引を作成: ${library}`);
  const t0 = Date.now();
  const index = buildIndex(library);
  console.log(`  ${index.size.toLocaleString()} ファイル名 (${((Date.now() - t0) / 1000).toFixed(1)}s)${dryRun ? "  [dry-run: 書き込みません]" : ""}\n`);

  const totals = { ok: 0, repaired: 0, unresolved: 0, ambiguous: 0, sizeMismatch: 0, written: 0, skippedOpen: 0 };
  const unresolvedNames = new Set();
  const bigDiffs = []; // サイズ差が大きいもの（メタデータ差では説明できない）

  for (const file of targets(input)) {
    const alsDir = path.dirname(file);
    const fallbackDirs = ["Imported", "Recorded", "Processed"].map((d) => path.join(alsDir, "Samples", d));
    const r = repairXml(readAls(file), alsDir, { index, fallbackDirs, allowSizeMismatch });

    const flag = r.repaired.length ? (dryRun ? "修復可" : "修復") : r.unresolved.length || r.ambiguous.length || r.sizeMismatch.length ? "要確認" : "健全";
    console.log(
      `${path.basename(file).padEnd(40)} 解決 ${String(r.ok).padStart(4)} / 向け直し ${String(r.repaired.length).padStart(4)}` +
        ` / 見つからず ${String(r.unresolved.length).padStart(3)} / 曖昧 ${r.ambiguous.length} / サイズ不一致 ${r.sizeMismatch.length}   ${flag}`
    );
    for (const u of r.unresolved) unresolvedNames.add(u.name);
    for (const x of r.repaired) if (x.sizeDiff != null && Math.abs(x.sizeDiff) > 64 * 1024) bigDiffs.push(x);
    for (const k of ["ok", "unresolved", "ambiguous", "sizeMismatch"]) totals[k] += Array.isArray(r[k]) ? r[k].length : r[k];
    totals.repaired += r.repaired.length;

    if (r.repaired.length && !dryRun) {
      if (isOpenInLive(file)) {
        console.log(`   → Live で開いているため書き込みを見送りました`);
        totals.skippedOpen++;
        continue;
      }
      const backup = writeAlsWithBackup(file, r.xml);
      console.log(`   → 書き込み。退避: ${path.relative(alsDir, backup)}`);
      totals.written++;
    }
  }

  console.log(
    `\n合計: 解決 ${totals.ok} / 向け直し ${totals.repaired} / 見つからず ${totals.unresolved} / 曖昧 ${totals.ambiguous}` +
      ` / サイズ不一致 ${totals.sizeMismatch} / 書き込んだセット ${totals.written}${totals.skippedOpen ? ` / Live で開いていて見送り ${totals.skippedOpen}` : ""}`
  );
  if (unresolvedNames.size) {
    console.log(`\n見つからなかったファイル（${unresolvedNames.size} 種類。Loopcloud 由来でないものは対象外です）:`);
    for (const n of [...unresolvedNames].sort()) console.log(`  - ${n}`);
  }
  if (bigDiffs.length) {
    console.log(`\nサイズ差が 64KB を超えるもの（${bigDiffs.length} 件。同名だがフォーマット違いの可能性。音は同じでも長さが違えば要確認）:`);
    for (const x of bigDiffs.slice(0, 15)) console.log(`  - ${x.name}  差 ${(x.sizeDiff / 1024 / 1024).toFixed(2)} MB`);
    if (bigDiffs.length > 15) console.log(`  … 他 ${bigDiffs.length - 15} 件`);
  }
  if (!dryRun && totals.written) {
    await notify(`参照を修復しました（${totals.repaired} 件 / ${totals.written} セット）。開き直すと反映されます`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
