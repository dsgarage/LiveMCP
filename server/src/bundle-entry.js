// esbuild 専用のエントリポイント。
// --loader:.xml=text で templates/ をビルド時に文字列として焼き込む。
// 素の Node（テスト・CLI）はこのファイルを通らず、als.js がディスクから読む。
"use strict";

require("../../scripts/als").setTemplates({
  group: require("../../templates/group-track.xml"),
  slot: require("../../templates/group-track.slot.xml"),
  clipslot: require("../../templates/group-track.clipslot.xml"),
  send: require("../../templates/group-track.send.xml"),
});

require("./mcp-server");
