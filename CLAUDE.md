# LiveMCP

Ableton Live 内で完結する MCP サーバー。M4L デバイス内の node.script（HTTP/MCP）+ js（LiveAPI）で構成。

## 構成

- `server/src/` — MCP サーバー本体（CommonJS。Node for Max 互換のため ESM 不可）
- `server/test/` — node:test（Live 不要で実行可能）
- `device/code/live-bridge.js` — js 側 LiveAPI ブリッジ（Max の js オブジェクトで動く。ES5 で書く。Node API 使用不可）
- `device/code/mcp-server.js` — esbuild バンドル成果物（git 管理外、`npm run build` で生成）
- `device/LiveMCP.maxpat` — パッチソース（`.amxd` はここから生成する）
- `scripts/amxd.js` / `scripts/build-device.js` — `.maxpat` → `.amxd` 生成と User Library への導入

## コマンド

- `npm test` — テスト実行
- `npm run build` — node.script 用バンドル + `.amxd` 生成
- `npm run install-device` — ビルドして User Library へ導入

## 制約・前提

- 動作要件: Live 12.4+（`replace_sample`）。`create_audio_clip` は 12.0.5+
- node.script からは LiveAPI 直接アクセス不可 → 必ず js ブリッジ経由（`server/src/bridge.js` の JSON プロトコル）
- **`v8` オブジェクトは使わない** — `v8.mxo` は `C74/extensions/` にあり Max アプリ起動時にしか読み込まれないため、Live 組み込みの Max ランタイムでは生成されず無応答になる（`js.mxo` は `externals/` にあり随時読み込まれる）
- LiveAPI は low-priority thread でしか生成できないため node.script → js の経路に `deferlow` が必須
- `.amxd` は `npm run install-device` で生成・導入する（Max エディタでの手作業は不要）
- Live ブラウザは M4L から触れない → サンプル探索は fs ベース（`sample-search.js`）
- MCP は stateless Streamable HTTP（ポート 3360、`LIVEMCP_PORT` で変更可）
- Producer Pal (GPL-3.0) はコード流用禁止。仕様参照のみ

## ブランチ運用

Git Flow: `main`（リリース）/ `develop`（デフォルト・統合）/ `feature/<issue>-<slug>`。main / develop へは PR 経由のみ。
