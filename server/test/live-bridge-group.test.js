// device/code/live-bridge.js の group_prepare / group_finish — Cmd+G 方式のグループ化の前後処理
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const BRIDGE = path.resolve(__dirname, "../../device/code/live-bridge.js");

// tracks: [{ id, name, foldable, groupId }]。view.selected は id。
function loadBridge(live) {
  let mkArray = null;
  const byId = (id) => live.tracks.find((t) => t.id === id);
  function LiveAPI(pathStr) {
    this.path = pathStr;
    let m;
    if ((m = /^live_set tracks (\d+)$/.exec(pathStr))) this.track = live.tracks[Number(m[1])];
    else if ((m = /^id (\d+)( group_track)?$/.exec(pathStr))) this.track = m[2] ? byId(byId(Number(m[1])).groupId) : byId(Number(m[1]));
    else if (pathStr === "live_set view selected_track") this.track = byId(live.selected);
    else if (pathStr === "live_set view") this.view = true;
    this.id = this.track ? this.track.id : this.view ? 1 : 0;
  }
  LiveAPI.prototype.get = function (name) {
    const t = this.track;
    if (name === "is_foldable") return mkArray(t.foldable ? 1 : 0);
    if (name === "is_grouped") return mkArray(t.groupId ? 1 : 0);
    if (name === "name") return mkArray(t.name);
    return mkArray();
  };
  LiveAPI.prototype.set = function (name, a, b) {
    if (this.view && name === "selected_track") live.selected = b;
    else if (name === "name") this.track.name = a;
    return 0;
  };
  const ctx = { LiveAPI, post: () => {}, outlet: () => {}, error: () => {} };
  vm.createContext(ctx);
  const CtxArray = vm.runInContext("Array", ctx);
  mkArray = (...items) => CtxArray.of(...items);
  vm.runInContext(fs.readFileSync(BRIDGE, "utf8"), ctx, { filename: BRIDGE });
  return ctx;
}

test("group_prepare は隣接した対象だけ受け付け、先頭を選択する", () => {
  const live = { selected: 0, tracks: [{ id: 10, name: "A" }, { id: 11, name: "B" }, { id: 12, name: "C" }] };
  const bridge = loadBridge(live);
  const r = { ...bridge.groupPrepare({ trackIndices: [2, 1] }) };
  assert.strictEqual(r.first_index, 1);
  assert.deepStrictEqual([...r.track_ids], [11, 12]);
  assert.strictEqual(live.selected, 11);
  assert.throws(() => bridge.groupPrepare({ trackIndices: [0, 2] }), /隣接していません/);
});

test("group_finish は選択がグループでなければ失敗し、全員が入っていれば命名する", () => {
  const live = { selected: 11, tracks: [{ id: 10, name: "A" }, { id: 11, name: "B" }, { id: 12, name: "C" }] };
  const bridge = loadBridge(live);
  assert.throws(() => bridge.groupFinish({ trackIds: [11, 12], name: "G" }), /グループが作られていません/);
  // Cmd+G 後の状態: 新しいグループ 20 が選択され、B と C がその子
  live.tracks.splice(1, 0, { id: 20, name: "Group", foldable: true });
  live.tracks[2].groupId = 20; live.tracks[3].groupId = 20; live.selected = 20;
  const r = { ...bridge.groupFinish({ trackIds: [11, 12], name: "RIFF DIST" }) };
  assert.strictEqual(r.name, "RIFF DIST");
  assert.strictEqual(r.grouped, 2);
  // 1 本だけ入っていない
  live.tracks[3].groupId = null;
  assert.throws(() => bridge.groupFinish({ trackIds: [11, 12], name: "X" }), /入っていないトラック/);
});
