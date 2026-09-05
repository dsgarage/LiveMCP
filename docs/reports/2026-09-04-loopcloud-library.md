# Loopcloud ライブラリの整理

購入済みの Loopcloud パック 159 個を、Live を一切使わずにジャンル別プロジェクトの `.als` に起こした記録です。
併せて、参照が切れて開けなくなっていた既存プロジェクトを修復しました。

| | |
|---|---|
| 日付 | 2026-09-04 |
| 環境 | Ableton Live 12.4.5 / Loopcloud ライブラリ 159 パック・59,245 音声・149GB |
| 関連 | Issue #19（参照修復）/ #20（分類）/ #21（生成エンジン） |

## 結果

### 生成したセット

**145 セット**を 12 のジャンルプロジェクトへ。所要 2 分。失敗 0。

| プロジェクト | セット数 |
|---|---|
| House TRACK Project | 25 |
| Ambient TRACK Project | 19（+ 修復した既存 13） |
| Techno TRACK Project | 16 |
| Pops Project | 16 |
| METAL TRACK Project | 12（+ 既存 13） |
| HipHop TRACK Project | 12 |
| Cinematic TRACK Project | 12 |
| EDM TRACK Project | 11 |
| Drums TRACK Project | 8 |
| Misc TRACK Project | 6 |
| Bass TRACK Project | 5 |
| Vocals TRACK Project | 2 |

セット名はパック名から作ります（`scripts/set-name.js`、2026-09-04 に変更）。
レーベル名（Loopcloud の Labels タグ。Singomakers / Freaky Loops …）とその略号（APS / TTS）、カタログ番号（FL205）、
`(Full_Zip)`、末尾の MAIN / WAV を外し、語を詰めて番号は 2 桁にそろえます。

```
Singomakers_Emotional_Piano_Themes_Vol_6_(Full_Zip)  →  EmotionalPianoThemesVol06
Freaky Loops - FL224 - Metalstep Vol. 2              →  MetalstepVol02
FL205_Hard Drops                                     →  HardDrops
CHILL_HOUSE_&_GARAGE                                 →  ChillHouse&Garage
```

対応表は `docs/loopcloud-packs.md` の「セット名」列。変えたい名前は `data/loopcloud-overrides.json` の `setName` で指定できます。

1 パックを複数のセットに分けたいときは overrides の `split` に 1 段目のフォルダ名を並べます。
`TTS_ThrashHardcore_Full` は `Deathrash` / `GrooveMetal01〜03` / `Metalcore` の 5 セット
（2025-09-28 に手作業で作られていたセットと同じ分け方）になり、`One Shots` は各セットに共通で入ります。
生成対象外にしたのは、Loopcloud Play のマルチサンプル楽器 8 パック、Cloud Storage、
REX / Serum プリセット / Drum Rack キット（`.adg`）しか入っていない 13 パックです。

### 修復した既存プロジェクト

Ambient TRACK Project の 13 セットで **4,195 件**の音声参照を Loopcloud の実ファイルへ向け直しました。
原因は Collect の不足ではなく、**プロジェクトフォルダの移動**でした。`FileRef` の相対パスが
旧所在地（`~/Music/Ableton/Ambient TRACK Project`）基準のまま残っていたためで、
`User Library/Project/` へ移した後は存在しない場所を指していました。他のプロジェクトは健全でした。

見つからなかった 31 種類はご自身の録音・バウンス（`Life-Beat 2026-06-06_…` / `Bounce 5-Life …`）と
ライブラリに無い `… Agile Shot.aif` 群で、Loopcloud 由来ではないため対象外です。
旧所在地にも Spotlight にも無く、Time Machine からでないと戻りません。

## セットの中身（Hard Drops のときと同じ流儀）

```
LOOPS（グループ）
├── DRUM      ← ループはフォルダの 1 段下ごとにオーディオトラック
├── MUSIC        クリップはテンポ → キー → 名前の順に縦に並ぶ
├── BASS
└── ATMO
ONE SHOTS（グループ）
├── OS DRUM HITS    ← ワンショットはフォルダごとに Drum Rack
├── OS DRUM HITS 2     C0(24) から半音ずつ。104 個を超えたら分ける
└── OS FX
```

- セットのテンポは、最も多い BPM が過半数ならそれ、そうでなければクリップ群の中央値（テンポがばらつくパックで
  25% の 200 BPM が選ばれ残りから遠くなるのを避ける。2026-09-04 変更）。各ファイルの BPM は名前 → WAV の `acid` チャンク → Loopcloud DB の順。
  どれにも無ければ 120
- **クリップ自身のテンポ（WarpMarker の拍数）は必ずそのファイルの BPM で計算する。** 当初はセットのテンポで計算していて、
  70 BPM のセットに入った 60 BPM のループが「70 BPM の素材」として並び、Seg. BPM が名前と食い違っていた
  （AmbientWaves で 312 中 246 クリップ。2026-09-04 に修正、全セット作り直し）。BPM の分からないファイル（FX 等）だけセットのテンポで原速再生

### Loopcloud のローカル DB が正解を持っている

Loopcloud はアプリ内の分類のために、全ファイルにタグと解析値を付けて **ローカルの SQLite** に持っています。
`~/Library/Loopcloud/<アカウント>/local.db` と、タグの名前・階層を持つ `tags.cache`（XML）です。

| 表 | 中身 |
|---|---|
| `CLOUDITEMS` | 全項目 116,881（フォルダ 7,516）。名前・BPM・親子関係（uuid） |
| `AssignedTags` + `TagIdMap` + `tags.cache` | 1 ファイルに複数のタグ。**Content Types（Loops / One Shots）**、Instruments（Drum > Cymbal > Hi Hat > Closed Hi Hat …）、Key、Genres、Labels |
| `audio_attributes` | Loopcloud 自身の波形解析。長さ・無音を除いた長さ・アタック/減衰時間・トランジェント強さ・リズム密度など |

`scripts/loopcloud-db.js` がこれを読み取り専用で開き（Node 標準の `node:sqlite`。コピーもロックもしない）、
ファイルのパスから種別・楽器・キー・BPM・解析値を返します。パックフォルダの `(hash)` は DB 側に無いので外して照合します。

ライブラリの音声 58,996 本のうち **99.5% に Loopcloud の種別タグ**があり、生成ではこれを正解として使います
（タグのあるファイルは波形を読まないので速くもなりました）。下の自前判定は、タグの無い 0.5% と、
Loopcloud を通っていないファイル（自分の録音など）のためのフォールバックです。自前判定とタグの一致は 95〜100% でした。

楽器タグ（Kick / Snare / Closed Hi Hat …）とキーは、Drum Rack の並びやトラック分けに使える見込みです（Issue #25）。

### ループかワンショットかは、ファイル 1 本ずつ決める（タグの無いときの手段）

フォルダ名だけで振ると間違います。実際にあった例:

- `Bass Music/Closed Hats` — 親の "Bass" でループ集と判定され、0.5 秒のハイハット 80 本がオーディオトラックに並んでいた
- `Drums/Drum Loops` — 親の "Drums" で単発と判定され、8 小節のドラムループが Drum Rack のパッドになっていた
- `Loops/Synths` に混ざった 0.27 秒のスタブ、`Oneshots/Bonus/FXs` の 25 秒のテクスチャ

そこで `scripts/sample-kind.js` が WAV / AIFF を 1 本ずつ見て、次の証拠を点数で合算します（＋がループ、−がワンショット）。

| 順 | 証拠 | 重み |
|---|---|---|
| 1 | `acid` チャンクの one-shot ビット（ベンダーが書いた正解。あれば最優先） | ±0.9 |
| 2 | 名前の語。Loop / Bar / Phrase はループ、Kick / Hit / Stab は単発。**FX 系（Riser / Impact / Texture …）は長さと拍の証拠を使わない**（小節に合わせた長いライザーがループに見えるため） | ±0.5 / FX −0.7 |
| 3 | 長さ。0.6 秒未満は単発、10 秒超はループ | −0.8 〜 +0.5 |
| 4 | 名前か acid の BPM で、長さが拍のちょうど整数倍か（ループは小節で切られている） | +0.7（4 拍以上）|
| 5 | 波形の末尾。単発は減衰して無音で終わる。ループは切りっぱなしで末尾にも音がある。長い素材ほど弱く見る | ±0.5 |
| 6 | 波形の先頭のトランジェント（2 秒未満のとき） | −0.2 |

これにフォルダ名の分類を事前情報として足します（`Loops` / `One Shots` のような明示は ±0.4、楽器名などの弱い手がかりは ±0.2）。
波形は末尾 1 秒・先頭 0.2 秒・全体を等間隔に 16 窓だけ読むので、1 パック 500 本で 5 秒ほどです。

重みは 6 パック 2,500 本（フォルダ名で分類済み）に当てて決めました。フォルダ名が正しいパック（AMBIENT_WAVES / DEEP_GROOVE_HOUSE）では 98〜100% 一致し、
食い違ったところはほぼ上の例のようにフォルダ側が間違っていました。`node scripts/sample-kind.js --calibrate <パック>` で再計測できます。

結果として、ループのフォルダに入っていた単発は同じ名前の `OS <フォルダ>` Drum Rack へ、逆はオーディオトラックへ行きます。

全 145 パックを作り直した結果（2026-09-04、Loopcloud タグ適用後。所要 3 分）:

| | 件数 |
|---|---|
| 判定した音声 | 58,894 |
| フォルダ分類と逆になった | 1,942（3.3%。ループ → 単発 814 / 単発 → ループ 1,128）。うち 1,808 は Loopcloud のタグによる |
| 迷った（点の絶対値 0.3 未満） | 15（タグの無いファイルだけ） |
| 見直し候補のあるパック | 48 |

逆転が多いのは、ベンダーのフォルダ名と Loopcloud の分類が食い違うパックです。`Hip_Hop_Progressions` は `DrumKits/90BPM` に入った
8 拍のドラム・アトモスのループ 319 本、`Jay-Js_Drum_Library` は `Hats` / `Kicks` フォルダに入った 1 小節のハット・キックの**パターン**（単発ではない）、
`VR_NIGHTCLUB VOCALS` は `DRY_PHRASES` のボーカル 1 フレーズ（Loopcloud は単発扱い）です。自前判定だけのときの逆転 1,374 本も、
Loopcloud タグとの突き合わせでほぼ同じ向きでした。
判定がフォルダと**逆になった**ものと**迷った**もの（点の絶対値 0.3 未満）は `docs/loopcloud-kind-review.md` に根拠付きで並ぶので、
直したいファイルは `data/loopcloud-overrides.json` の `files` に `"<パック内の相対パス>": "loop" | "oneshot"` と書いて作り直します。

フォルダ名の分類（`loopcloud-survey.js`）も葉のフォルダまで下りるようにし、親子で食い違ったときは
「子の明示 > 親の明示 > 子の弱い手がかり > 親の弱い手がかり」で決めます。
`Loops/Drum Builds & Fills` は Loops が勝ってループ、`Sounds & FX/Drum Kits/Bill Board Kit` は Drum Kits が勝って単発です。

### 曲キット型（Singomakers Emotional Piano など）

曲ごとのフォルダに Full Mix とパート別の WAV / MIDI が入っているパックは、
フォルダ単位だと 20 曲 × 2 トラックの縦長になって使えないため、別のレイアウトにしています
（`data/loopcloud-overrides.json` の `"layout": "songs"`）。

```
SONGS（グループ）        シーン = 曲（番号順）。シーンに曲名とテンポを持たせる
├── FULL MIX             → 起動するとその曲のテンポに切り替わる
├── PIANO 1
├── PIANO 1 MIDI         ← WAV の隣に同じパートの MIDI クリップ（.mid をノートに展開）
├── PIANO 2
└── PIANO 2 MIDI
```

- パート名はファイル名から接頭辞・曲番号・BPM・キーを除いた残り（`Full_Mix` → `FULL MIX`）
- 列の並びは Mix を先頭、続いて WAV のあるパート。MIDI しか無いパート（Vol.3 の `PIANO 1/2/3`）は
  名前の頭が一致する WAV パート（`PIANO`）の直後に置く。以前は MIDI フォルダが先に読まれて MIDI が左に来ていた
- MIDI クリップの雛形は Live 12.4.5 が書いた MPE 無しの MidiClip から抽出。
  ノートは KeyTrack（ピッチごと）に拍で入る。長さは小節単位に切り上げ
- シーン数はいちばん長い列に合わせる（最低 8）
- サンプルは **Loopcloud を直参照**。コピーは作らない

## 仕組み

`.als` は gzip された XML です。テンプレートは推測で書かず、**Live 12.4.5 が実際に書いたセット**
（Hard Drops.als）から起こしています（`scripts/extract-templates.js`）。可変部分だけを差し替え、
ポインタ id は `NextPointeeId` から連番で振り直します。

実物から読み取った規則:

- AudioClip の長さは拍数で持つ。WarpMarker は (0,0)(秒,拍) に加えて「1/32 拍先」をもう 1 つ置く
- DrumBranch の `ReceivingNote` は 128 − MIDI ノート（C0 = 24 → 104）
- Simpler の `SampleEnd` / `SustainLoop.End` はフレーム数 − 1
- `ClipSlotList` は MainSequencer と FreezeSequencer で 2 回出る
- `LomId` は 0 でよい。`OriginalCrc` が 0 でも Live は開く
- **テンポは `<Tempo>` の `Manual` だけでは変わらない。** 実物には MainTrack の AutomationEnvelope にテンポの初期値
  （`FloatEvent Time="-63072000" Value="155"`）が残っていて、Live はこちらを表示する。両方を書き換える（`als.setTempo`）。
  2026-09-05 にテンプレートセットで発覚し、それまでの生成物は Live 上では全部 155 だった → 全セット作り直し
- 分類の `Kit` は曲単位のコンストラクションキット（ループ）が大半。ドラム系パック（Loopcloud Drum 等）の Kit だけがワンショット

### 実機で初めて分かったこと

**土台に Live 同梱の `DefaultLiveSet.als` を使うと開けません。** あれは Live 12.1d1 製で、
そこに 12.4.5 形式のトラックを差し込むと、Live が文書のバージョンを見てスキーマ移行を掛け、
「group track freeze sequencer slots not empty」で破損扱いにします。土台も 12.4.5 が書いた実物から
起こして解決しました。Group トラックの構造自体は Live の実物と同一でした。

もう 1 つ、比較が無ければ見逃していたバグがありました。`ClipSlotList` の 1 つ目を 2 回置き換えて
**クリップが全部消えた状態で「クリップ 108」と報告していた**というものです。
Live が書いたセットとタグ出現数で突き合わせて気付きました。

## 使い方

```bash
# 分類し直す（data/loopcloud-packs.json を更新。生成物なので git 管理外。人の判断は data/loopcloud-overrides.json に残る）
node scripts/loopcloud-survey.js

# 全パックを生成（既存は上書きしない）
node scripts/loopcloud-build.js
node scripts/loopcloud-build.js --only Metalstep        # 一部だけ
node scripts/loopcloud-build.js --force                 # 作り直す（Backup/ へ退避してから）

# 参照が切れたプロジェクトを直す
node scripts/als-repair.js "<プロジェクトフォルダ>" --dry-run
node scripts/als-repair.js "<プロジェクトフォルダ>" --allow-size-mismatch
```

Loopcloud はパックのフォルダ名にハッシュ（`(126c8ee25cd5)`）を付けます。再同期でこれが変わると
参照が切れますが、そのときは `als-repair.js` がそのまま使えます（ファイル名で索引を引く）。

## 気になるところ（判断待ち）

- **テンポ 120 のセット 30 本** — 名前にも `acid` チャンクにも BPM が無いもの。FX やヒット系が大半で、
  120 のまま原速で鳴るので実害は小さいが、ループ系が混じっていれば要確認
- **1 トラックに数百クリップのセット** — `THE_BLUES_SESSIONS_2_WAV` の GUITAR 610 本など。
  パックの構造そのままなので仕様どおりだが、使いにくければ楽器・BPM で分ける改善案がある
- **サイズ不一致で受け入れた 117 件** — Ambient の修復で、同名だが数 MB サイズが違う
  ファイルへ向け直したもの。AMBIENT WAVES（SMD）系に集中。フォーマット違いの再取得と推定

## 片付け候補（削除は判断待ち）

- ~~`METAL TRACK Project/Hard Drops.als` 他 3 本（検証用）~~ — 2026-09-04 に片付け済み。`FL205_Hard Drops.als` が正。
  なお、この `Hard Drops.als` はテンプレートの抽出元だった。テンプレートは `templates/` にコミット済みなので
  生成には影響しないが、`scripts/extract-templates.js` を再実行するには Live 12.4.5 で保存した
  同じ構成のセット（クリップ入りオーディオトラック + Drum Rack 入り MIDI トラック）が要る
- 手作業で作られた旧セット（`Metalstep Vol01.als` 等）と、同じパックから生成したセット
  （`FL191_Metalstep.als` 等）の重複。旧セットは `Samples/Imported` のコピーを参照している
- `Samples/Imported` のコピー自体（Ambient だけで 11GB）。Loopcloud 直参照に統一すれば不要
