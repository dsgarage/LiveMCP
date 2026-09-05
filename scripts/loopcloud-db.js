#!/usr/bin/env node
// Loopcloud のローカル DB を読む（読み取り専用）。
//
//   ~/Library/Loopcloud/<アカウント>/local.db   … SQLite。全項目（CLOUDITEMS）、タグ割り当て、Loopcloud 自身の波形解析
//   ~/Library/Loopcloud/<アカウント>/tags.cache … XML。タグの uuid → 名前と階層（System Tags > Content Types > One Shots …）
//
// Loopcloud が全ファイルに付けている「種別（Loops / One Shots）」「楽器」「キー」「ジャンル」「レーベル」と BPM、
// それに解析値（長さ・無音を除いた長さ・アタック/減衰・トランジェント強さ …）を、ファイルのパスから引けるようにする。
//
//   const lc = LoopcloudDb.shared();            // 無ければ null（Loopcloud 未導入・DB 未生成）
//   const item = lc && lc.lookup("/Users/…/Loopcloud/library/FL205_Hard Drops (126c8ee25cd5)/Oneshots/Kicks/HD_Kick_1.wav");
//   item.contentType  → "oneshot" | "loop" | null
//   item.instrument   → ["Drum", "Kick"]（Instruments 配下の階層）
//   item.key / item.bpm / item.genres / item.label / item.tags（全タグのフルパス） / item.attrs（解析値）
//
//   node scripts/loopcloud-db.js <file>...   判定用に中身を表示
//
// DB は Loopcloud が書く。ここでは開くだけで、コピーもロックもしない。
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LOOPCLOUD_HOME = path.join(os.homedir(), "Library/Loopcloud");
const DEFAULT_LIBRARY = path.join(LOOPCLOUD_HOME, "library");

// アカウントフォルダ（local.db があるフォルダ）を探す
function findAccountDir(home = LOOPCLOUD_HOME) {
  if (!fs.existsSync(home)) return null;
  for (const e of fs.readdirSync(home, { withFileTypes: true })) {
    if (e.isDirectory() && fs.existsSync(path.join(home, e.name, "local.db"))) return path.join(home, e.name);
  }
  return null;
}

// tags.cache（XML）→ Map(uuid → { uuid, parentId, name })
function parseTagsCache(xml) {
  const tags = new Map();
  for (const m of xml.matchAll(/<LcTag\s+([^>]*?)\/>/gs)) {
    const a = {};
    for (const k of m[1].matchAll(/(\w+)="([^"]*)"/g)) a[k[1]] = k[2].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
    if (a.uuid) tags.set(a.uuid.toLowerCase(), a);
  }
  return tags;
}

const hexToUuid = (h) => h.toLowerCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
const stripHash = (name) => name.replace(/ \([0-9a-f]{12}\)$/, "");

class LoopcloudDb {
  // { dbPath, tagsPath, libraryDir } はテスト用。省略時はアカウントフォルダから探す
  constructor({ dbPath, tagsPath, libraryDir = DEFAULT_LIBRARY } = {}) {
    if (!dbPath) {
      const acct = findAccountDir();
      if (!acct) throw new Error("Loopcloud の local.db が見つかりません");
      dbPath = path.join(acct, "local.db");
      tagsPath = tagsPath || path.join(acct, "tags.cache");
    }
    const { DatabaseSync } = require("node:sqlite");
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    this.libraryDir = libraryDir;
    this.tags = tagsPath && fs.existsSync(tagsPath) ? parseTagsCache(fs.readFileSync(tagsPath, "utf8")) : new Map();
    this._tagPath = new Map(); // uuid → ["System Tags", "Content Types", "One Shots"]
    this._items = null;        // 相対パス → { rowid, name, bpm, isDir }
    this._stmtTags = this.db.prepare("select hex(t.taguuid) u from AssignedTags a join TagIdMap t using(tagId) where a.itemrowId = ?");
    this._stmtAttrs = this.db.prepare("select * from audio_attributes where item_row_id = ?");
  }

  static available() {
    if (findAccountDir() == null) return false;
    try { require("node:sqlite"); return true; } catch { return false; } // Node 22.5 未満には node:sqlite が無い
  }

  // プロセス内で 1 つだけ開いて使い回す。無ければ null
  static shared() {
    if (LoopcloudDb._shared === undefined) {
      try { LoopcloudDb._shared = process.env.LIVEMCP_NO_LOOPCLOUD_DB ? null : new LoopcloudDb(); }
      catch (e) { LoopcloudDb._shared = null; console.warn(`Loopcloud DB を使いません（自前判定にフォールバック）: ${e.message}`); } // 黙って落ちない
    }
    return LoopcloudDb._shared;
  }

  // 全項目を読み、親子を辿って「パック名/相対パス」の索引を作る（11 万件で 1 秒ほど）
  index() {
    if (this._items) return this._items;
    const rows = this.db.prepare("select rowid, name, bpm, hex(parentuuid) p, hex(itemuuid) u, isDirectory d from CLOUDITEMS").all();
    const byUuid = new Map(rows.map((r) => [r.u, r]));
    const pathOf = new Map(); // uuid → 相対パス（ROOT は ""）
    const resolve = (r) => {
      if (pathOf.has(r.u)) return pathOf.get(r.u);
      const parent = r.p && byUuid.get(r.p);
      const rel = !parent ? "" : (resolve(parent) ? resolve(parent) + "/" : "") + r.name;
      pathOf.set(r.u, rel);
      return rel;
    };
    this._items = new Map();
    for (const r of rows) {
      const rel = resolve(r);
      if (rel) this._items.set(rel, { rowid: r.rowid, name: r.name, bpm: r.bpm || null, isDir: r.d === 1 });
    }
    return this._items;
  }

  tagPath(uuid) {
    if (this._tagPath.has(uuid)) return this._tagPath.get(uuid);
    const t = this.tags.get(uuid);
    const p = t ? (t.parentId && this.tags.has(t.parentId.toLowerCase()) ? [...this.tagPath(t.parentId.toLowerCase()), t.name] : [t.name]) : [uuid];
    this._tagPath.set(uuid, p);
    return p;
  }

  // 絶対パス（Loopcloud ライブラリ内）か「パック名/相対パス」で引く
  lookup(file) {
    let rel = file;
    if (path.isAbsolute(file)) {
      rel = path.relative(this.libraryDir, file);
      if (rel.startsWith("..")) return null;
      const parts = rel.split(path.sep);
      parts[0] = stripHash(parts[0]); // パックフォルダの "(hash)" は DB 側に無い
      rel = parts.join("/");
    }
    const it = this.index().get(rel);
    return it ? this.item(it) : null;
  }

  item(it) {
    const tags = this._stmtTags.all(it.rowid).map((r) => this.tagPath(hexToUuid(r.u)));
    const under = (root) => tags.filter((t) => t[1] === root).map((t) => t.slice(2));
    const content = under("Content Types").flat();
    const instruments = under("Instruments").sort((a, b) => b.length - a.length);
    const keys = under("Key").flat();
    const attrs = this._stmtAttrs.get(it.rowid) || null;
    return {
      rowid: it.rowid,
      name: it.name,
      bpm: it.bpm,
      contentType: content.some((c) => /^One Shots?$/i.test(c)) ? "oneshot" : content.some((c) => /^Loops?$/i.test(c)) ? "loop" : null,
      contentTypes: content,
      instrument: instruments[0] || null,     // いちばん深い階層（["Drum", "Cymbal", "Hi Hat", "Closed Hi Hat"]）
      key: keys[0] || null,
      genres: under("Genres").map((g) => g.join(" > ")),
      label: (under("Labels")[0] || [])[0] || null,
      tags: tags.map((t) => t.join(" > ")),
      attrs,
    };
  }

  // パック（"FL205_Hard Drops"）の下にある全ファイルを [相対パス, 項目] で返す
  packItems(packName) {
    const prefix = stripHash(packName) + "/";
    return [...this.index()].filter(([rel, it]) => !it.isDir && rel.startsWith(prefix));
  }

  close() { this.db.close(); }
}

module.exports = { LoopcloudDb, parseTagsCache, findAccountDir, stripHash };

if (require.main === module) {
  const lc = LoopcloudDb.shared();
  if (!lc) { console.error("Loopcloud の DB が見つかりません"); process.exit(1); }
  for (const f of process.argv.slice(2)) {
    const it = lc.lookup(path.resolve(f));
    if (!it) { console.log(`${f}: DB に無い`); continue; }
    console.log(`${it.name}  種別 ${it.contentType || "-"} / 楽器 ${(it.instrument || []).join(" > ") || "-"} / キー ${it.key || "-"} / BPM ${it.bpm || "-"} / ${it.label || "-"}`);
    if (it.attrs) console.log(`  長さ ${it.attrs.fileDuration?.toFixed(3)}s（無音除く ${it.attrs.lengthExcludingSilence?.toFixed(3)}s） アタック ${it.attrs.oneShotAttackTime?.toFixed(4)} 減衰 ${it.attrs.oneShotDecayTime?.toFixed(4)} トランジェント ${it.attrs.transientStrength?.toFixed(3)}`);
    console.log(`  ${it.tags.join(" | ")}`);
  }
}
