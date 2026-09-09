// LiveMCP - js 側 LiveAPI ブリッジ。
// node.script から "to_v8 <json>" を受けて LiveAPI を実行し、
// "from_v8 <json>" をアウトレットから返す。
// このファイルは Max の js オブジェクトで動く（Node ではない）。ES5 で書くこと。
//
// ブリッジは v8 ではなく js を使う。js.mxo は C74/externals/ にあり
// オブジェクト参照時に随時読み込まれるのに対し、v8.mxo は C74/extensions/ にあり
// Max アプリ起動時にしか読み込まれない。Live 内で確実に動くのは js の方。
//
// LiveAPI は low-priority thread でしか生成できないため、
// パッチ側で node.script との間に deferlow を挟んでいる。

autowatch = 1;
inlets = 1;
outlets = 1;

// ---- 受信 ----
// node.script は Max.outlet("to_v8", json) で "to_v8 <json>" を出す。
function to_v8(json) {
  handleRequest(json);
}

// セレクタ無しで JSON が飛んできた場合の保険
function anything() {
  handleRequest(messagename);
}

// live.thisdevice からのバング。
// node.script 側へも通知する。これが live.debug.state の受信ログに出れば
// js オブジェクトが生成されスクリプトが読めていることの証明になる。
function bang() {
  post("LiveMCP: js ブリッジ準備完了\n");
  outlet(0, "bridge_ready", "js");
}

function handleRequest(json) {
  var req;
  try {
    req = JSON.parse(json);
  } catch (e) {
    return; // JSON 以外は無視
  }
  var reply = { id: req.id, ok: true, result: null };
  try {
    reply.result = dispatch(req.op, req.args || {});
  } catch (e) {
    reply.ok = false;
    reply.error = String(e && e.message ? e.message : e);
    post("LiveMCP: op=" + req.op + " でエラー: " + reply.error + "\n");
  }
  outlet(0, "from_v8", JSON.stringify(reply));
}

// ---- op ディスパッチ ----
function dispatch(op, args) {
  switch (op) {
    case "ping":
      return ping();
    case "info":
      return apiInfo(args);
    case "raw":
      return raw(args);
    case "read_set":
      return readSet(args);
    case "create_audio_clip":
      return createAudioClip(args);
    case "create_audio_clips":
      return createAudioClips(args);
    case "create_midi_clip":
      return createMidiClip(args);
    case "build_drum_rack":
      return buildDrumRack(args);
    case "insert_device":
      return insertDevice(args);
    case "replace_sample":
      return replaceSample(args);
    case "list_device_params":
      return listDeviceParams(args);
    case "set_device_param":
      return setDeviceParam(args);
    default:
      throw new Error("unknown op: " + op);
  }
}

// ---- LiveAPI ヘルパー ----
// LiveAPI.get() は常に配列を返す。名前に空白が含まれると複数アトムに割れるため、
// 文字列化はカンマ結合（"" + array）ではなく空白結合を使う。
function str(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Array) return v.join(" ");
  return "" + v;
}

function num(v) {
  if (v instanceof Array) return Number(v[0]);
  return Number(v);
}

function api(path) {
  var a = new LiveAPI(path);
  if (!a || Number(a.id) === 0) throw new Error("LiveAPI パスが見つかりません: " + path);
  return a;
}

function ping() {
  var app = api("live_app");
  return {
    live_version: str(app.call("get_version_string")),
    bridge: "js",
  };
}

// 実機の LOM を直接問い合わせるための調査用 op。
// 対応プロパティ・関数の一覧が .info に入っている。
function apiInfo(args) {
  var a = api(args.path);
  return {
    path: args.path,
    id: str(a.id),
    type: str(a.type),
    info: str(a.info),
  };
}

// 任意の LiveAPI 呼び出し。ツール化していない LOM を実機で試すために使う。
function raw(args) {
  var a = api(args.path);
  var method = args.method || "get";
  var extra = args.args || [];
  if (method === "get") return { value: a.get(args.property) };
  if (method === "getcount") return { value: a.getcount(args.property) };
  if (method === "set") return { value: a.set.apply(a, [args.property].concat(extra)) };
  if (method === "call") return { value: a.call.apply(a, [args.property].concat(extra)) };
  throw new Error("unknown method: " + method + " (get / getcount / set / call)");
}

function readSet(args) {
  var set = api("live_set");
  var trackCount = set.getcount("tracks");
  var sceneCount = set.getcount("scenes");
  var tracks = [];
  for (var t = 0; t < trackCount; t++) {
    var track = api("live_set tracks " + t);
    var deviceCount = track.getcount("devices");
    var devices = [];
    for (var d = 0; d < deviceCount; d++) {
      var dev = api("live_set tracks " + t + " devices " + d);
      devices.push({
        index: d,
        name: str(dev.get("name")),
        class_name: str(dev.get("class_name")),
      });
    }
    var entry = {
      index: t,
      name: str(track.get("name")),
      type: num(track.get("has_midi_input")) === 1 ? "midi" : "audio",
      devices: devices,
    };
    if (args.includeClips) {
      var clips = [];
      for (var s = 0; s < sceneCount; s++) {
        var slot = api("live_set tracks " + t + " clip_slots " + s);
        if (num(slot.get("has_clip")) === 1) {
          var clip = api("live_set tracks " + t + " clip_slots " + s + " clip");
          clips.push({
            scene: s,
            name: str(clip.get("name")),
            is_audio: num(clip.get("is_audio_clip")) === 1,
            length: num(clip.get("length")),
          });
        }
      }
      entry.clips = clips;
    }
    tracks.push(entry);
  }
  return {
    tempo: num(set.get("tempo")),
    track_count: trackCount,
    scene_count: sceneCount,
    tracks: tracks,
  };
}

function createAudioClip(args) {
  var slot = api("live_set tracks " + args.trackIndex + " clip_slots " + args.sceneIndex);
  if (num(slot.get("has_clip")) === 1) {
    throw new Error("クリップスロットが空ではありません (track " + args.trackIndex + ", scene " + args.sceneIndex + ")");
  }
  // Live 12.0.5+ の LOM 関数。オーディオトラック以外・フリーズ中はエラーになる
  slot.call("create_audio_clip", args.filePath);
  var clip = api("live_set tracks " + args.trackIndex + " clip_slots " + args.sceneIndex + " clip");
  return {
    created: true,
    name: str(clip.get("name")),
    length: num(clip.get("length")),
    file_path: str(clip.get("file_path")),
  };
}

// ノート入りの MIDI クリップを 1 つ作る。
// Live 12 の add_new_notes は辞書引数（{ notes: [{ pitch, start_time, duration, velocity, mute }] }）。
// 旧式の set_notes / notes / note / done は LiveAPI オブジェクトをまたぐと効かないので、ここで 1 つのオブジェクトの中で済ませる。
// js から辞書を渡す方法は Max のバージョンで違うため、JS オブジェクト → Dict の順に試す。
function createMidiClip(args) {
  var t = args.trackIndex, sc = args.sceneIndex;
  var slot = api("live_set tracks " + t + " clip_slots " + sc);
  if (num(slot.get("has_clip")) === 1) {
    throw new Error("クリップスロットが空ではありません (track " + t + ", scene " + sc + ")");
  }
  var length = args.lengthBeats || 16;
  slot.call("create_clip", length);
  var clip = api("live_set tracks " + t + " clip_slots " + sc + " clip");
  var notes = [];
  for (var i = 0; i < (args.notes || []).length; i++) {
    var n = args.notes[i];
    notes.push({
      pitch: n.pitch,
      start_time: n.start || 0,
      duration: n.duration || 1,
      velocity: n.velocity === undefined ? 100 : n.velocity,
      mute: 0,
    });
  }
  var how = "none";
  if (notes.length) {
    // 実機（Live 12.4.5 / Max 9.1）: JS オブジェクトをそのまま渡すとエラーにならないがノートも入らない。Dict を使う
    var d = new Dict();
    d.parse(JSON.stringify({ notes: notes }));
    clip.call("add_new_notes", d);
    how = "dict";
    d.freepeer();
  }
  if (args.name) clip.set("name", args.name);
  // 入ったノート数は get_notes_extended（JSON 文字列を返す）で数える。旧式の get_notes は Live 12 では常に 0
  var count = -1;
  try {
    var r = clip.call("get_notes_extended", 0, 128, 0, length);
    var parsed = JSON.parse(str(r));
    count = parsed.notes ? parsed.notes.length : 0;
  } catch (e2) {}
  return {
    created: true,
    name: str(clip.get("name")),
    length: num(clip.get("length")),
    notes_requested: notes.length,
    notes_in_clip: count,
    method: how,
  };
}

// 複数のクリップをまとめて作る。1 件ずつ node.script と往復すると
// ファイル数ぶんラウンドトリップが必要になるため、ここでループする。
// 1 件失敗しても続行し、結果に理由を残す。
function createAudioClips(args) {
  var created = [];
  var errors = [];
  for (var i = 0; i < args.filePaths.length; i++) {
    var sceneIndex = args.startSceneIndex + i;
    try {
      var r = createAudioClip({
        trackIndex: args.trackIndex,
        sceneIndex: sceneIndex,
        filePath: args.filePaths[i],
      });
      created.push({ scene_index: sceneIndex, name: r.name, length: r.length });
    } catch (e) {
      errors.push({ scene_index: sceneIndex, file_path: args.filePaths[i], error: String(e.message || e) });
    }
  }
  return { created: created.length, failed: errors.length, clips: created, errors: errors };
}

// Drum Rack のパッドを一括で組み立てる。
// パッド 1 枚につき insert_chain → in_note → Simpler 挿入 → サンプル読込 → 命名 の
// 5 往復が必要なので、まとめてここで処理する。
function buildDrumRack(args) {
  var track = api("live_set tracks " + args.trackIndex);
  var rackIndex = ensureDrumRack(track, args.trackIndex);
  var rackPath = "live_set tracks " + args.trackIndex + " devices " + rackIndex;
  var rack = api(rackPath);

  var added = [];
  var errors = [];
  for (var i = 0; i < args.samples.length; i++) {
    var sample = args.samples[i];
    try {
      var chainId = idOf(rack.call("insert_chain"));
      if (!chainId) throw new Error("パッドを追加できませんでした");

      // insert_chain は末尾に追加されるので、直後の chains 数 - 1 が今作った位置
      var chainIndex = rack.getcount("chains") - 1;
      var chainPath = rackPath + " chains " + chainIndex;
      var chain = api(chainPath);
      chain.set("in_note", sample.note);

      var simplerId = idOf(chain.call("insert_device", "Simpler"));
      if (!simplerId) throw new Error("Simpler を挿入できませんでした");

      var simpler = api(chainPath + " devices 0");
      simpler.call("replace_sample", sample.filePath);
      if (sample.name) chain.set("name", sample.name);

      added.push({ note: sample.note, name: sample.name || "" });
    } catch (e) {
      errors.push({ note: sample.note, file_path: sample.filePath, error: String(e.message || e) });
    }
  }
  return { device_index: rackIndex, added: added.length, failed: errors.length, pads: added, errors: errors };
}

// 既に Drum Rack があればその番号を返し、無ければ挿入する
function ensureDrumRack(track, trackIndex) {
  var count = track.getcount("devices");
  for (var i = 0; i < count; i++) {
    var dev = new LiveAPI("live_set tracks " + trackIndex + " devices " + i);
    if (str(dev.get("class_name")) === "DrumGroupDevice") return i;
  }
  var id = idOf(track.call("insert_device", "Drum Rack"));
  if (!id) throw new Error("Drum Rack を挿入できませんでした（MIDI トラックか確認してください）");
  return indexOfDevice(trackIndex, id);
}

function insertDevice(args) {
  var track = api("live_set tracks " + args.trackIndex);
  var result;
  if (args.position !== undefined && args.position !== null) {
    result = track.call("insert_device", args.deviceName, args.position);
  } else {
    result = track.call("insert_device", args.deviceName);
  }

  // 成功すると ["id", <n>] が返る。失敗しても例外にはならず id 0 が返るだけなので、
  // ここで弾かないと挿入できていないのに inserted: true を返してしまう
  // （オーディオトラックに Simpler を挿そうとした場合など、実機で確認済み）。
  var id = idOf(result);
  if (!id) {
    throw new Error(
      "デバイスを挿入できませんでした: " + args.deviceName +
        "（デバイス名が違うか、トラックの種別に対応していない可能性があります）"
    );
  }

  return { inserted: true, device_id: id, device_index: indexOfDevice(args.trackIndex, id) };
}

// LiveAPI の call は成功時 ["id", <n>]、失敗時 0 相当を返す
function idOf(v) {
  if (v instanceof Array) {
    for (var i = 0; i < v.length; i++) {
      if (String(v[i]) === "id") return Number(v[i + 1]) || 0;
    }
    return Number(v[0]) || 0;
  }
  return Number(v) || 0;
}

// 挿入位置は position 指定の有無で変わるため、id を突き合わせて実際の番号を返す
function indexOfDevice(trackIndex, id) {
  var track = api("live_set tracks " + trackIndex);
  var count = track.getcount("devices");
  for (var i = 0; i < count; i++) {
    var dev = new LiveAPI("live_set tracks " + trackIndex + " devices " + i);
    if (Number(dev.id) === id) return i;
  }
  return -1;
}

function replaceSample(args) {
  var dev = api("live_set tracks " + args.trackIndex + " devices " + args.deviceIndex);
  var className = str(dev.get("class_name"));
  if (className !== "OriginalSimpler") {
    throw new Error("対象が Simpler ではありません (class_name=" + className + ")");
  }
  // Live 12.4+ のネイティブ API
  dev.call("replace_sample", args.filePath);
  return { replaced: true, file_path: args.filePath };
}

function listDeviceParams(args) {
  var dev = api("live_set tracks " + args.trackIndex + " devices " + args.deviceIndex);
  var count = dev.getcount("parameters");
  var params = [];
  for (var p = 0; p < count; p++) {
    var param = api("live_set tracks " + args.trackIndex + " devices " + args.deviceIndex + " parameters " + p);
    var value = num(param.get("value"));
    params.push({
      index: p,
      name: str(param.get("name")),
      value: value,
      min: num(param.get("min")),
      max: num(param.get("max")),
      is_quantized: num(param.get("is_quantized")) === 1,
      display_value: str(param.call("str_for_value", value)),
    });
  }
  return {
    device: str(dev.get("name")),
    class_name: str(dev.get("class_name")),
    parameters: params,
  };
}

function setDeviceParam(args) {
  var param = api(
    "live_set tracks " + args.trackIndex +
    " devices " + args.deviceIndex +
    " parameters " + args.paramIndex
  );
  var min = num(param.get("min"));
  var max = num(param.get("max"));
  if (args.value < min || args.value > max) {
    throw new Error("値が範囲外です (" + min + " 〜 " + max + ")");
  }
  param.set("value", args.value);
  return {
    name: str(param.get("name")),
    value: num(param.get("value")),
  };
}
