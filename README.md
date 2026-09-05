# LiveMCP — Ableton Live 内で完結する MCP サーバー

Claude Code から Ableton Live を直接操作するための MCP サーバーと、Live を介さずに `.als` を組み立てる周辺ツール群です。
外部プロセス不要で、**M4L デバイス 1 個を Live のトラックに置くだけ**で動作します。

```
Claude Code ←(HTTP: localhost:3360/mcp)→ LiveMCP.amxd
                                           ├ node.script … MCP サーバー本体
                                           └ js …………… LiveAPI ブリッジ
Claude Code ←(会話)→ live.set.* ─→ scripts/als*.js ─→ .als ファイル（Live を介さない）
```

使い方の詳細は **[Wiki](https://github.com/dsgarage/LiveMCP/wiki)** にあります。

## できること

### 動いているセットの操作（MCP ツール）

| ツール | 内容 |
|---|---|
| `live.status` / `live.debug.state` | 接続確認・ブリッジの自己診断 |
| `live.set.read` | セット概要（テンポ・トラック・クリップ・デバイス）読み取り |
| `live.samples.search` | サンプルフォルダからオーディオファイル検索（絶対パス返却） |
| `live.clip.create_audio` / `create_audio_batch` | ループをクリップスロットへ配置（1 件 / 連続シーンへ一括） |
| `live.drumrack.build` | ワンショット群を Drum Rack のパッドへ一括配置 |
| `live.device.insert` / `replace_sample` | デバイス追加・Simpler へサンプル読み込み |
| `live.device.params` / `set_param` | デバイス（M4L 含む）のパラメータ取得・設定 |
| `live.api.info` / `live.api.raw` | 未対応の LOM を調べる低レベル手段 |
| `live.set.group_tracks` | `.als` を書いて Group トラックを作る（LOM に無い操作） |

→ [MCP ツール リファレンス](https://github.com/dsgarage/LiveMCP/wiki/Reference-MCP-Tools)

### セットの組み立て（`.als` 直書き）

- サンプルパックから **クリップ入りトラックと Drum Rack を含むセットを数秒で生成**（`scripts/als-generate.js`）
- Loopcloud の全パックをジャンル別プロジェクトへ一括生成。Loopcloud のタグ・BPM を使った分類（`scripts/loopcloud-build.js`）
- 移動で切れたサンプル参照の修復、Group 化、セットの比較

→ [.als スクリプト](https://github.com/dsgarage/LiveMCP/wiki/Reference-ALS-Scripts) / [Loopcloud](https://github.com/dsgarage/LiveMCP/wiki/Reference-Loopcloud)

## 動作要件

- Ableton Live **12.4 以上** + Max for Live（Suite または M4L 追加）
- Node.js **22 以上**（`.als` 系スクリプトと Loopcloud DB の読み取り）
- Claude Code

（`create_audio_clip` は Live 12.0.5+、`replace_sample` は Live 12.4+ の LOM API を使用）

## セットアップ

```bash
npm --prefix server install
npm run install-device                                              # ビルドして User Library へ導入
claude mcp add --transport http live-mcp http://localhost:3360/mcp  # Claude Code に登録
```

Live のブラウザから **User Library → Presets → Audio Effects → Max Audio Effect → LiveMCP** をトラックへ置き、Claude Code で `live.status` が返れば完了です。
詳細と注意点（Max のキャッシュ、サンプルフォルダ）は [セットアップ](https://github.com/dsgarage/LiveMCP/wiki/Setup)、動かないときは [トラブルシューティング](https://github.com/dsgarage/LiveMCP/wiki/Troubleshooting)。

## 開発

```bash
npm test          # node:test（Live 不要で実行可能）
npm run build     # esbuild で node.script 用バンドル + .amxd 生成
```

- ブランチ運用は Git Flow（`main` / `develop` / `feature/<issue>-<slug>`）。Issue 駆動、PR は `develop` へ
- 設計上の制約（`v8` 不可、`deferlow` 必須、ESM 不可）は [CLAUDE.md](CLAUDE.md) と [構成と設計方針](https://github.com/dsgarage/LiveMCP/wiki/Architecture)
- 設計判断の記録は [docs/reports/](docs/reports/)
- Wiki はリポジトリ直下の `wiki/`（git 管理外）に clone して編集し、Wiki リポジトリへ直接 push する

## ライセンス

MIT
