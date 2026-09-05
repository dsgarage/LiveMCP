#!/usr/bin/env node
// 分類表（data/loopcloud-packs.json + overrides）に従って、全パックの .als をジャンル別プロジェクトへ生成する。
//
//   node scripts/loopcloud-build.js [--dry-run] [--only <パック名の一部>] [--genre <ジャンル>] [--limit N] [--force] [--no-backup] [--library <dir>]
//
// 分類表（data/loopcloud-packs.json）は loopcloud-survey.js が作る生成物で git 管理外。無ければ先に survey を実行する。
// 分類表の dir はライブラリ直下のフォルダ名なので、--library（既定 ~/Library/Loopcloud/library）と結合して読む
//
// --no-backup は、まだ誰も触っていない生成物を作り直すときだけ使う（Backup/ が増えないように）
//
// 出力先: ~/Music/Ableton/User Library/Project/<ジャンルのプロジェクト>/<パック名>.als
// 既にあるセットは上書きしない（--force で Backup/ へ退避してから置き換え）。
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { generate } = require("./als-generate");
const { backupPath } = require("./als");
const { isOpenInLive } = require("./notify");

const PROJECT_ROOT = path.join(os.homedir(), "Music/Ableton/User Library/Project");
const DEFAULT_LIBRARY = path.join(os.homedir(), "Library/Loopcloud/library");
const PACKS_JSON = path.join(__dirname, "..", "data", "loopcloud-packs.json");

// 既存プロジェクトの名前に揃える（METAL は大文字、Pops は "Project" だけ）
const PROJECT_FOR = {
  Metal: "METAL TRACK Project",
  HipHop: "HipHop TRACK Project",
  Ambient: "Ambient TRACK Project",
  EDM: "EDM TRACK Project",
  Pops: "Pops Project",
};
const projectFor = (genre) => PROJECT_FOR[genre] || `${genre} TRACK Project`;

// セット名は分類表の setName（scripts/set-name.js: "EmotionalPianoThemesVol06" の形）。無ければパック名そのまま
const { setNameOf } = require("./set-name");
const setName = (p) => (p.setName || setNameOf(p.name, { label: p.label })).replace(/[\/:]/g, "-").trim();
// 以前のセット名（パック名そのまま）。残っていれば新しい名前に改名する
const legacyName = (p) => p.name.replace(/[\/:]/g, "-").replace(/\s+/g, " ").trim();

function main() {
  const argv = process.argv.slice(2);
  const opt = (k) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : null);
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const noBackup = argv.includes("--no-backup");
  const only = opt("--only");
  const genreFilter = opt("--genre");
  const limit = Number(opt("--limit") || 0);

  const library = opt("--library") || DEFAULT_LIBRARY;
  if (!fs.existsSync(PACKS_JSON)) throw new Error(`分類表がありません: ${PACKS_JSON}\n先に node scripts/loopcloud-survey.js を実行してください`);
  const packs = JSON.parse(fs.readFileSync(PACKS_JSON, "utf8"));
  let targets = packs.filter((p) => !p.skipPack && p.genre && p.genre !== "（対象外）" && (p.counts.loops + p.counts.oneshots) > 0);
  if (only) targets = targets.filter((p) => p.name.toLowerCase().includes(only.toLowerCase()));
  if (genreFilter) targets = targets.filter((p) => p.genre === genreFilter);
  if (limit) targets = targets.slice(0, limit);

  console.log(`対象 ${targets.length} パック${dryRun ? "（dry-run）" : ""}\n`);
  const result = { done: 0, skipped: 0, failed: 0 };
  const t0 = Date.now();

  // split 指定のパックは 1 段目のフォルダごとに別セットへ（TTS_ThrashHardcore_Full → Deathrash / Metalcore …）。
  // 指定フォルダの外にあるもの（One Shots など）は各セットに共通で入れる
  const jobs = targets.flatMap((p) => {
    if (!Array.isArray(p.split) || !p.split.length) return [p];
    const under = (list, dir) => list.filter((f) => f.name === dir || f.name.startsWith(dir + "/"));
    const shared = (list) => list.filter((f) => !p.split.some((dir) => f.name === dir || f.name.startsWith(dir + "/")));
    return p.split.map((dir) => ({
      ...p,
      name: `${p.name} / ${dir}`,
      legacy: p.name, // 分割前のセット名（残っていれば片付ける）
      setName: setNameOf(dir),
      loops: [...under(p.loops, dir), ...shared(p.loops)],
      oneshots: [...under(p.oneshots, dir), ...shared(p.oneshots)],
    }));
  });

  // split で作った名前が別パックと同じ出力先になったら、パック名を頭に付けて区別する（黙って上書き / 見送りにしない）
  const outKey = (j) => `${projectFor(j.genre)}/${setName(j)}`;
  const outCount = new Map();
  for (const j of jobs) outCount.set(outKey(j), (outCount.get(outKey(j)) || 0) + 1);
  for (const j of jobs) if (j.legacy && outCount.get(outKey(j)) > 1) { j.setName = setNameOf(j.legacy) + j.setName; console.warn(`  注意: 出力先が重複するためパック名を付けた: ${j.name} → ${j.setName}`); }

  for (const p of jobs) {
    const project = path.join(PROJECT_ROOT, projectFor(p.genre));
    const output = path.join(project, setName(p) + ".als");
    const label = `${p.genre.padEnd(9)} ${p.name} → ${path.basename(output, ".als")}`;

    // 分割前の 1 本にまとめたセットが残っていれば、分割後のセットと重複するので Backup/ へ退避
    if (p.legacy) {
      const whole = path.join(project, (targets.find((t) => t.name === p.legacy)?.setName || setNameOf(p.legacy)) + ".als");
      if (fs.existsSync(whole) && !dryRun && !isOpenInLive(whole)) {
        const b = backupPath(whole);
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.renameSync(whole, b);
        console.log(`  退避    ${path.basename(whole)} → ${path.relative(project, b)}（分割したため）`);
      }
    }

    // 旧名（パック名そのまま）のセットが残っていれば改名（Live で開いていれば見送り）
    const legacy = path.join(project, legacyName(p) + ".als");
    if (legacy !== output && fs.existsSync(legacy) && !fs.existsSync(output)) {
      if (isOpenInLive(legacy)) { console.log(`  見送り  ${label}（旧名のセットを Live で開いている）`); result.skipped++; continue; }
      if (!dryRun) fs.renameSync(legacy, output);
      console.log(`  改名    ${path.basename(legacy)} → ${path.basename(output)}`);
    }

    if (fs.existsSync(output) && !force) {
      console.log(`  既存    ${label}`);
      result.skipped++;
      continue;
    }
    if (dryRun) {
      console.log(`  生成予定 ${label}  → ${path.relative(PROJECT_ROOT, output)}  (ループ ${p.counts.loops} / ワンショット ${p.counts.oneshots})`);
      continue;
    }
    if (fs.existsSync(output) && isOpenInLive(output)) {
      console.log(`  見送り  ${label}（Live で開いている）`);
      result.skipped++;
      continue;
    }
    try {
      if (fs.existsSync(output) && !noBackup) {
        const b = backupPath(output);
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.copyFileSync(output, b);
      }
      const r = generate({
        packDir: path.isAbsolute(p.dir) ? p.dir : path.join(library, p.dir),
        output,
        loops: p.loops.map((f) => ({ name: f.name, strength: f.strength || "weak" })),
        oneshots: p.oneshots.map((f) => ({ name: f.name, strength: f.strength || "weak" })),
        layout: p.layout || "folders",
        fileKinds: p.fileKinds || {},
      });
      const clips = r.loops.reduce((a, l) => a + l.clips, 0);
      const pads = r.oneshots.reduce((a, o) => a + (o.pads || 0), 0);
      const review = r.review || [];
      const flipped = review.filter((x) => x.flipped).length;
      const unsure = review.filter((x) => !x.flipped && x.uncertain).length;
      console.log(`  生成    ${label}  (テンポ ${r.bpm} / クリップ ${clips} / パッド ${pads} / シーン ${r.scenes}${r.layout === "songs" ? ` / 曲 ${r.songs}` : ""}${flipped || unsure ? ` / 判定でフォルダと逆 ${flipped} / 迷い ${unsure}` : ""})`);
      kinds[p.name] = { set: path.relative(PROJECT_ROOT, output), review };
      result.done++;
    } catch (e) {
      console.log(`  失敗    ${label}: ${e.message}`);
      result.failed++;
    }
  }

  if (!dryRun && result.done) {
    fs.writeFileSync(KINDS_JSON, JSON.stringify(kinds, null, 1));
    fs.writeFileSync(KINDS_MD, kindsMarkdown(kinds));
    console.log(`→ ${KINDS_MD}`);
  }
  console.log(`\n生成 ${result.done} / 既存のため見送り ${result.skipped} / 失敗 ${result.failed}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

// ファイル判定の見直し候補（パックごとに上書き。生成しなかったパックの分は残る）
const KINDS_JSON = path.join(__dirname, "..", "data", "loopcloud-kinds.json");
const KINDS_MD = path.join(__dirname, "..", "docs", "loopcloud-kind-review.md");
const kinds = fs.existsSync(KINDS_JSON) ? JSON.parse(fs.readFileSync(KINDS_JSON, "utf8")) : {};

function kindsMarkdown(all) {
  const lines = [];
  lines.push("# ループ / ワンショット判定の見直し候補", "");
  lines.push("`scripts/sample-kind.js` がファイル自体（acid チャンク・名前・長さ・拍・波形）から決めた種別が、");
  lines.push("フォルダ名の分類と**逆になった**もの、あるいは**迷った**もの（|点| < 0.3）です。");
  lines.push("直したいファイルは `data/loopcloud-overrides.json` の `files` に `\"<パック内の相対パス>\": \"loop\" | \"oneshot\"` で指定し、`--force` で作り直します。", "");
  const packs = Object.entries(all).filter(([, v]) => v.review.length).sort((a, b) => b[1].review.length - a[1].review.length);
  const total = packs.reduce((a, [, v]) => a + v.review.length, 0);
  lines.push(`パック ${packs.length} / ファイル ${total}`, "");
  for (const [name, v] of packs) {
    const flipped = v.review.filter((x) => x.flipped);
    const unsure = v.review.filter((x) => !x.flipped);
    lines.push(`## ${name}`, "", `セット: \`${v.set}\` — 逆転 ${flipped.length} / 迷い ${unsure.length}`, "");
    const row = (x) => `| ${x.flipped ? "逆転" : "迷い"} | ${x.folder === "loop" ? "ループ" : "ワンショット"} → **${x.kind === "loop" ? "ループ" : "ワンショット"}** | ${x.final.toFixed(2)} | \`${x.file}\` | ${x.reasons.join(" / ")} |`;
    lines.push("| | フォルダ → 判定 | 点 | ファイル | 根拠 |", "|---|---|---|---|---|");
    for (const x of [...flipped, ...unsure].slice(0, 60)) lines.push(row(x));
    if (v.review.length > 60) lines.push(`| … | | | 他 ${v.review.length - 60} 件 | |`);
    lines.push("");
  }
  return lines.join("\n");
}

main();
