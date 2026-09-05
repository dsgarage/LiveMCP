// device/code/live-bridge.js は Max の js オブジェクト用（ES5 / Node API 不可）なので、
// LiveAPI などの Max グローバルを差し替えた vm コンテキストで読み込んで検証する。
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const BRIDGE = path.resolve(__dirname, "../../device/code/live-bridge.js");

// tracks: [{ devices: [{ id, name }] }] を持つ最小の LiveAPI スタブ。
// insert_device は Live と同じく、失敗しても例外を投げず id 0 を返す。
//
// 戻り値の配列は vm コンテキスト側の Array で作る。realm が違うと
// ブリッジ内の `instanceof Array` が成立せず、実機と挙動が変わってしまう。
function loadBridge(live) {
  let mkArray = null;
  function LiveAPI(pathStr) {
    const track = /^live_set tracks (\d+)/.exec(pathStr);
    const device = /^live_set tracks (\d+) devices (\d+)$/.exec(pathStr);
    this.path = pathStr;
    if (device) {
      const d = live.tracks[Number(device[1])].devices[Number(device[2])];
      this.id = d ? d.id : 0;
    } else if (track) {
      this.id = live.tracks[Number(track[1])] ? 100 + Number(track[1]) : 0;
    } else {
      this.id = 0;
    }
    this.trackIndex = track ? Number(track[1]) : -1;
  }
  LiveAPI.prototype.getcount = function (name) {
    if (name !== "devices") return 0;
    return live.tracks[this.trackIndex].devices.length;
  };
  LiveAPI.prototype.get = function () {
    return mkArray();
  };
  LiveAPI.prototype.call = function (op, name, position) {
    if (op !== "insert_device") return 0;
    const t = live.tracks[this.trackIndex];
    const inserted = live.insertable.indexOf(name) >= 0;
    if (!inserted) return 0; // Live は失敗を戻り値でしか知らせない
    const dev = { id: live.nextId++, name: name };
    t.devices.splice(position === undefined ? t.devices.length : position, 0, dev);
    return mkArray("id", dev.id);
  };

  const ctx = { LiveAPI, post: () => {}, outlet: () => {}, error: () => {} };
  vm.createContext(ctx);
  const CtxArray = vm.runInContext("Array", ctx);
  mkArray = (...items) => CtxArray.of(...items);
  vm.runInContext(fs.readFileSync(BRIDGE, "utf8"), ctx, { filename: BRIDGE });
  return ctx;
}

test("insert_device が失敗したときに成功扱いにしない", () => {
  const live = { nextId: 40, insertable: ["Simpler"], tracks: [{ devices: [] }] };
  const bridge = loadBridge(live);

  assert.throws(
    () => bridge.insertDevice({ trackIndex: 0, deviceName: "Nonexistent Device" }),
    /デバイスを挿入できませんでした/
  );
  assert.strictEqual(live.tracks[0].devices.length, 0);
});

test("insert_device が成功したら id と実際の位置を返す", () => {
  const live = { nextId: 40, insertable: ["Simpler"], tracks: [{ devices: [] }] };
  const bridge = loadBridge(live);

  // 戻り値は vm コンテキスト側のオブジェクトなので、比較前にホスト側へ写す
  const r = { ...bridge.insertDevice({ trackIndex: 0, deviceName: "Simpler" }) };
  assert.deepStrictEqual(r, { inserted: true, device_id: 40, device_index: 0 });
});

test("position を指定したときはその位置を device_index に返す", () => {
  const live = {
    nextId: 40,
    insertable: ["Simpler"],
    tracks: [{ devices: [{ id: 1, name: "EQ Eight" }, { id: 2, name: "Reverb" }] }],
  };
  const bridge = loadBridge(live);

  const r = bridge.insertDevice({ trackIndex: 0, deviceName: "Simpler", position: 1 });
  assert.strictEqual(r.device_index, 1);
  assert.deepStrictEqual(live.tracks[0].devices.map((d) => d.name), [
    "EQ Eight",
    "Simpler",
    "Reverb",
  ]);
});
