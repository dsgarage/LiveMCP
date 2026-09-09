// device/code/live-bridge.js の create_midi_clip — Live 12 の add_new_notes（辞書引数）を Dict で渡す
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const BRIDGE = path.resolve(__dirname, "../../device/code/live-bridge.js");

// クリップスロット 1 つ分の LiveAPI / Dict スタブ。add_new_notes に渡った辞書と set された名前を記録する
function loadBridge(state) {
  let mkArray = null;
  function LiveAPI(pathStr) {
    this.path = pathStr;
    this.id = /clip_slots \d+( clip)?$/.test(pathStr) ? 5 : 0;
  }
  LiveAPI.prototype.get = function (name) {
    if (name === "has_clip") return mkArray(state.hasClip ? 1 : 0);
    if (name === "name") return mkArray(state.name);
    if (name === "length") return mkArray(state.length);
    return mkArray();
  };
  LiveAPI.prototype.set = function (name, value) { if (name === "name") state.name = value; return 0; };
  LiveAPI.prototype.call = function (op, arg) {
    if (op === "create_clip") { state.hasClip = true; state.length = arg; return 0; }
    if (op === "add_new_notes") { state.received = arg; return 0; }
    if (op === "get_notes_extended") return JSON.stringify({ notes: state.received ? state.received.data.notes : [] });
    throw new Error("unexpected call " + op);
  };
  function Dict() { this.data = null; }
  Dict.prototype.parse = function (json) { this.data = JSON.parse(json); };
  Dict.prototype.freepeer = function () {};

  const ctx = { LiveAPI, Dict, post: () => {}, outlet: () => {}, error: () => {} };
  vm.createContext(ctx);
  const CtxArray = vm.runInContext("Array", ctx);
  mkArray = (...items) => CtxArray.of(...items);
  vm.runInContext(fs.readFileSync(BRIDGE, "utf8"), ctx, { filename: BRIDGE });
  return ctx;
}

test("create_midi_clip はクリップを作り、ノートを Dict で add_new_notes に渡し、名前を付ける", () => {
  const state = { hasClip: false, name: "", length: 0, received: null };
  const bridge = loadBridge(state);
  const r = { ...bridge.createMidiClip({ trackIndex: 1, sceneIndex: 3, lengthBeats: 16, name: "C1", notes: [{ pitch: 36, start: 0, duration: 16, velocity: 100 }] }) };
  assert.strictEqual(state.length, 16);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(state.received.data)), { notes: [{ pitch: 36, start_time: 0, duration: 16, velocity: 100, mute: 0 }] });
  assert.strictEqual(r.name, "C1");
  assert.strictEqual(r.notes_in_clip, 1);
  assert.strictEqual(r.method, "dict");
});

test("create_midi_clip はスロットが埋まっていれば作らない", () => {
  const state = { hasClip: true, name: "x", length: 4, received: null };
  const bridge = loadBridge(state);
  assert.throws(() => bridge.createMidiClip({ trackIndex: 0, sceneIndex: 0, notes: [] }), /空ではありません/);
  assert.strictEqual(state.received, null);
});
