# LiveMCP セットアップ手順

## 1. ビルドと導入

```bash
npm --prefix server install
npm run install-device
```

これだけで以下が行われます。

1. `server/src` を esbuild で `device/code/mcp-server.js` にバンドル
2. `device/LiveMCP.maxpat` から `device/LiveMCP.amxd` を生成
3. `.amxd` と 2 つの `.js` を User Library と Max の検索パスへ配置

配置先:

```
~/Music/Ableton/User Library/Presets/Audio Effects/Max Audio Effect/LiveMCP/
├── LiveMCP.amxd
├── livemcp-server.js   ← node.script が読む（バンドル済み）
└── livemcp-bridge.js   ← js が読む

~/Documents/Max 9/Library/
├── livemcp-server.js
└── livemcp-bridge.js
```

**Live 上のデバイスからは `.amxd` と同じフォルダが Max の検索パスに入りません。**
`js` も `node.script` もスクリプトを検索パスから解決するため、2 つの `.js` は
Max の標準ユーザーライブラリ（`~/Documents/Max 9/Library/`）にも配置します。
このライブラリは他のパッチと共有なので、ファイル名は `livemcp-` 接頭辞付きに固定しています。

配置されるファイル名は毎回同じです。User Library には `LiveMCP` が 1 つだけ並びます。

> `.amxd` は「4 バイトのチャンク ID + リトルエンディアン uint32 のサイズ + ペイロード」を並べただけの形式で、
> `ptch` チャンクの中身は素の maxpat JSON です。そのため Max エディタでの手作業保存は不要で、
> `scripts/amxd.js` が生成しています。書き出しロジックは Live 同梱の純正デバイスを
> バイト単位で再生成できることをテストで検証しています。

## 2. Live へロード

Live のブラウザから **User Library → Presets → Audio Effects → Max Audio Effect → LiveMCP** を任意のトラックへドラッグします。

サーバーは 1 インスタンスのみ動けばよいので、**セット内に 1 つだけ**置いてください。
テンプレートセットに含めておくと Live 起動と同時に立ち上がります。

## 3. Claude Code への登録

```bash
claude mcp add --transport http live-mcp http://localhost:3360/mcp
```

ポートを変える場合はデバイス側の環境変数 `LIVEMCP_PORT` と合わせてください。

## 4. サンプルフォルダ

未設定でも Node 側が以下を自動検出します。

- `~/Music/Ableton/User Library/Samples`
- `~/Music/Ableton/Factory Packs`
- Live の Core Library `Samples`

追加・変更するときはデバイス内の `folders` メッセージボックスを編集してクリックします。

```
folders "/Users/you/My Samples" /Volumes/Audio/Loops
```

空白を含むパスは `" "` で囲みます（Max は `~` を展開しないので絶対パスで書きます）。
1 回きりなら `live.samples.search` の `folder` 引数でも指定できます。

## 5. 動作確認

Claude Code で:

```
live.status を実行して
```

Live のバージョンが返れば接続完了です。

## デバイスを更新したとき

`server/src` や `device/code/live-bridge.js` を変更したら `npm run install-device` を再実行します。
配置されるファイル名は常に同じなので、User Library には `LiveMCP` が 1 つだけ並びます。

> **Max はパッチもスクリプトもファイルパス単位でキャッシュします。**
> 同じパスの `.amxd` を差し替えても、Live のセッション中は古いパッチが再利用されます。
> 入れ替えを反映させるには **Live を再起動してください**（デバイスの削除・再追加では足りません）。

## 自己診断

デバイスはロード 4 秒後から 5 秒ごとに 2 経路のプローブを送ります。`live.debug.state` で確認できます。

| メッセージ | 経路 | 意味 |
|---|---|---|
| `device_loaded` | `node.script` へ直通 | パッチの配線と node.script のインレットが生きている |
| `bridge_ready js` | `js` オブジェクト経由 | js が生成されスクリプトを読めている |

- 両方出る → ブリッジは正常
- `device_loaded` だけ → `js` が `livemcp-bridge.js` を見つけられていない
- どちらも出ない → 古いパッチがキャッシュから使われている（Live を再起動する）

## 調査用ツール

実機の LOM を直接叩けるツールを 2 つ用意しています。ツール化していない API を試すときに使います。

- `live.api.info` — LiveAPI パスの型・対応プロパティ・関数一覧を取得
- `live.api.raw` — 任意の `get` / `getcount` / `set` / `call` を実行

## トラブルシューティング

- **live.status がタイムアウトする** — デバイスが Live のトラックにロードされているか、Max コンソール（Live の Max Window）にエラーが出ていないか確認します
- **ポート使用中エラー** — 別のセットや Max 単体で LiveMCP を開いていないか確認します（サーバーは 1 インスタンスのみ）
- **`node.script` が起動しない** — `~/Documents/Max 9/Library/livemcp-server.js` があるか確認します（Live 上のデバイスからは `.amxd` と同じフォルダが検索パスに入りません）。プロセスが 1 つも無いときは `pgrep -lf "N4M PM"` で N4M のプロセスマネージャだけが動いていないか見ると切り分けられます
- **LiveAPI 関連のエラー** — LiveAPI は low-priority thread でしか生成できないため、`node.script` と `js` の間の `deferlow` を外さないでください
- **ブリッジが無応答（LiveAPI 系ツールが全部タイムアウトする）** — `live.debug.state` で `node.script` の受信ログを確認します。デバイスにはロード 4 秒後に動く自己診断が入っていて、`device_loaded`（node.script へ直通）と `bridge_ready js`（js オブジェクト経由）の 2 つが記録されます。`device_loaded` だけなら `js` オブジェクトが動いていません（`livemcp-bridge.js` が Max の検索パスから見つかっていない可能性）。どちらも無ければ古いデバイスがロードされたままです。**`v8` は使わないでください**（`v8.mxo` は `C74/extensions/` にあり Max アプリ起動時にしか読み込まれないため、Live 組み込みの Max ランタイムでは生成されません。`js.mxo` は `externals/` にあるので随時読み込まれます）
- **create_audio_clip がエラー** — 対象がオーディオトラックか、スロットが空か、トラックがフリーズされていないか確認します
