# Ableton Live のプロジェクト / ファイル構成

LiveMCP から Live のファイルを直接扱う判断（`.als` 生成など）のために、
実機（Live 12.4.5 / macOS）で中身を確認した記録です。推測ではなく、実際のファイルを開いて書いています。

## 1. 三階層になっている

Live のファイルは「ライブラリ → プロジェクト → セット」の入れ子です。ここが最初に混乱しやすい点です。

```
~/Music/Ableton/                        ライブラリの置き場
├── User Library/                       ユーザーライブラリ（ブラウザの「User Library」）
│   ├── Presets/ Clips/ Samples/ Grooves/ Templates/ Defaults/ ...
│   ├── Remote Scripts/                 自作 Remote Script はここ
│   └── Project/
│       ├── METAL TRACK Project/        ← プロジェクト
│       └── Ambient TRACK Project/
├── Factory Packs/
├── Live Recordings/
└── VinalLibrary Project/               プロジェクトはライブラリ外にも置ける
```

**プロジェクトは「1 曲」ではなく「1 つの作業単位」です。** 中に複数のセット（`.als`）が入ります。

実際 `METAL TRACK Project` には 13 個のセットが同居しています。

```
METAL TRACK Project/
├── Ableton Project Info/     ← このフォルダの存在がプロジェクトの目印
├── Backup/                   ← 保存のたびに自動で世代を残す
├── Samples/
│   ├── Imported/             Collect で取り込んだサンプル
│   ├── Processed/            Freeze / Consolidate などの生成物
│   └── Recorded/             このプロジェクトで録音したもの
├── Deathrash.als
├── Metalstep Vol01.als
├── Hard Drops.als            ← 今回作ったセット
└── ...
```

`Ableton Project Info/` は空のこともあります（Live 12.4.5 の実機で空を確認）。
Live はこのフォルダの有無でプロジェクトのルートを判定するため、中身が無くても意味があります。

`Backup/` の命名は `<セット名> [YYYY-MM-DD HHMMSS].als` です。上書き保存のたびに増えます。

## 2. `.als` の正体は gzip された XML

```
$ file "Hard Drops.als"
gzip compressed data, original size modulo 2^32 24211916
```

**1.78 MB の `.als` は、展開すると 24 MB の XML です。** バイナリではありません。
`gunzip -c foo.als > foo.xml` で普通に読めます。

ルート要素にバージョンが入っています。

```xml
<Ableton MajorVersion="5" MinorVersion="12.0_12402"
         SchemaChangeCount="5" Creator="Ableton Live 12.4.5"
         Revision="225ce5e356e024356d5210512bae46fb466f6968">
```

`.amxd`（Max for Live デバイス）が「チャンク ID + サイズ + ペイロード」の独自コンテナだったのに対し、
`.als` は素直に gzip + XML です。読むのも書くのも容易です。

## 3. `.als` の中の構造

`<Ableton>` の下に `<LiveSet>` があり、その直下に 70 個ほどの要素が並びます。主なものだけ挙げます。

| 要素 | 中身 |
|---|---|
| `Tracks` | トラック全部。`AudioTrack` / `MidiTrack` / `GroupTrack` / `ReturnTrack` |
| `MainTrack` | マスタートラック |
| `PreHearTrack` | プレビュー（ヘッドホン）用トラック |
| `Scenes` | シーン。セッションビューの行 |
| `Transport` | テンポ・拍子・ループ範囲・再生位置 |
| `GroovePool` | グルーヴ |
| `Locators` | アレンジメントのロケーター |
| `ViewStates` ほか多数 | ウィンドウの開閉、ズーム、選択状態などの UI 状態 |

残りの大半は UI の状態です。`.als` は「曲のデータ」だけでなく
**「Live を閉じたときの画面の状態」も丸ごと保存している**ため、あれだけの分量になります。

トラックの中はこうなっています。

```
AudioTrack
├── Name/EffectiveName              トラック名
├── TrackGroupId                    所属グループの Id（-1 なら未所属）
├── DeviceChain
│   ├── DeviceChain/Devices         デバイス（EQ Eight, DrumGroupDevice など）
│   └── MainSequencer/ClipSlotList  セッションビューのクリップスロット
```

Group トラックは `GroupTrack` という別の要素で、
**子トラック側が `TrackGroupId` で親を指す**方式です。親が子を列挙するのではありません。

Drum Rack は `DrumGroupDevice` で、パッドは `Branches/DrumBranch` の並びです。
各 `DrumBranch` の中に Simpler（`OriginalSimpler`）が 1 つ入り、
`ZoneSettings/ReceivingNote` で反応する MIDI ノートが決まります。
LiveMCP が LOM 経由で組み立てているものと同じ構造です。

## 4. サンプルはコピーされない（既定では）

これが実務で一番効く仕様です。**セットにサンプルの中身は入りません。参照だけです。**

参照は `SampleRef/FileRef` に書かれます。今回 Hard Drops を並べた直後の状態はこうでした。

```xml
<FileRef>
  <RelativePathType Value="1" />
  <RelativePath Value="../../../../../Library/Loopcloud/library/FL205_Hard Drops (...)/Loops/808s/HD_808Loop_155_E_ColdHearted_FRK.wav" />
  <Path Value="/Users/<you>/Library/Loopcloud/library/FL205_Hard Drops (...)/..." />
  <Type Value="2" />
  <OriginalFileSize Value="3277766" />
  <OriginalCrc Value="36090" />
</FileRef>
```

Loopcloud のライブラリを直接指しています。**このセットは Loopcloud のフォルダに依存しています。**
移動や削除をすればサンプルが行方不明になります。

対して **File → Collect All and Save** を通したセットはこうなります。

```xml
<FileRef>
  <RelativePathType Value="3" />
  <RelativePath Value="Samples/Imported/TTS_THC_Deathrash_..._01.wav" />
  <Path Value="/Users/.../METAL TRACK Project/Samples/Imported/..._01.wav" />
</FileRef>
```

`RelativePathType` が変わり、`RelativePath` がプロジェクトフォルダ基準の相対パスになります。
実ファイルは `Samples/Imported/` にコピーされます。

同じセットの `Path`（絶対パス）は、実際には今と違う古い場所を指したままでした。
それでも Live が開けるのは、**相対パスを先に見て解決している**からです。
プロジェクトフォルダごと移動しても壊れないのはこの仕組みによります。

`OriginalFileSize` と `OriginalCrc` は、パスが両方とも外れたときに
「ファイルが見つかりません」ダイアログで候補を探すための手がかりです。

## 5. `.asd` は Live が勝手に作る解析ファイル

サンプルの隣に `<元のファイル名>.wav.asd` が作られます。ワープマーカー、トランジェント、
音量解析の結果が入ったバイナリで、数百 KB になることもあります。

ユーザーライブラリ配下では **`.wav` が 5,179 個に対して `.asd` が 5,216 個**ありました。
実質すべてのサンプルに 1 つ付いている状態です。

今回 Hard Drops を読み込んだ結果、**Loopcloud のパックフォルダの中にも `.asd` が作られていました**。
Live は参照先のフォルダに書き込みます。消しても再生成されるだけで害はありませんが、
「読み込んだだけのつもりのフォルダが変更される」ことは知っておく必要があります。

## 6. Live のファイル形式まとめ

実機で `file` コマンドにかけて確認した結果です。

| 拡張子 | 中身 | 形式 |
|---|---|---|
| `.als` | Live セット | gzip + XML |
| `.adg` | デバイスラック（Drum Rack, Instrument Rack 等） | gzip + XML |
| `.adv` | 単体デバイスのプリセット | gzip + XML（一部の内部用は非圧縮） |
| `.alc` | クリップ（ブラウザからドラッグできる単位） | gzip + XML |
| `.agr` | グルーヴ | gzip + XML |
| `.amxd` | Max for Live デバイス | 独自チャンク形式（中の `ptch` は素の JSON） |
| `.asd` | サンプル解析結果 | バイナリ |
| `.alp` | Live Pack（配布用アーカイブ） | 独自アーカイブ |

**`.amxd` 以外は基本的に gzip + XML** です。`.amxd` だけが例外で、
これは `scripts/amxd.js` で読み書きできるようにしてあります。

## 7. LiveMCP から見た意味

### `.als` を直接生成する案は現実的

gzip + XML であり、`.amxd` を純正デバイスとバイト単位で一致させて生成できた実績があるので、
同じ手が使えます。既存の `.als` をテンプレートとして読み、`Tracks` と `Scenes` を差し替える方式なら、
未知のスキーマを全部理解する必要もありません。

この方式なら、LOM に無い操作も制約を受けません。

- **Group トラック** — `GroupTrack` 要素を足し、子の `TrackGroupId` を書き換えるだけ
- **保存** — ファイルを書くこと自体が保存
- **Collect** — サンプルをコピーして `FileRef` を書き換えるだけ

### 一方で向かない用途

動いているセットには触れません。Live が開いている `.als` を書き換えても、
メモリ上のセットは変わらず、保存時に上書きされて消えます。

つまり住み分けはこうなります。

| やりたいこと | 適した経路 |
|---|---|
| 動いているセットを操作する（再生、パラメータ、クリップ追加） | LOM（M4L / Remote Script） |
| セットを一から組み立てる（パックの一括配置、テンプレート生成） | `.als` の直接生成 |
| ブラウザからデバイス・プリセットを読み込む | Remote Script（`Browser.load_item`） |

### 注意点

- `.als` には UI 状態が大量に含まれる。テンプレートから差分を作る方式にしないと、開いたときの見た目が壊れる
- `MinorVersion` / `SchemaChangeCount` はバージョン依存。生成物は Live のバージョンを跨ぐと危うい
- サンプルを参照するだけのセットは、参照先を動かすと壊れる。配布や保管の前に Collect を通す
