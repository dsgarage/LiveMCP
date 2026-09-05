#!/usr/bin/env node
// .als 生成用のテンプレートを、Live 12.4.5 が実際に書いたセットから起こす。
//
//   node scripts/extract-templates.js
//
// 取り出し元:
//   - DefaultLiveSet.als（Live 同梱の空セット）: オーディオトラック、シーン
//   - Hard Drops.als（Live が保存した実セット）: AudioClip、Drum Rack 入り MIDI トラック、DrumBranch
//
// スキーマは推測しない。実物のブロックをそのまま使い、可変部分だけ placeholder にする。
// ポインタ id（4 桁以上の Id 属性）は __PID<n>__ にして、組み立て時に連番で振り直す。
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readAls, listTracks } = require("./als");

const DEFAULT = "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Builtin/Templates/DefaultLiveSet.als";
const REAL = path.join(os.homedir(), "Music/Ableton/User Library/Project/METAL TRACK Project/Hard Drops.als");
const OUT = path.join(__dirname, "..", "templates");

function pidify(block) {
  const map = new Map();
  return block.replace(/Id="(\d{4,})"/g, (_, n) => {
    if (!map.has(n)) map.set(n, map.size);
    return `Id="__PID${map.get(n)}__"`;
  });
}
const zeroLom = (b) => b.replace(/LomId Value="\d+"/g, 'LomId Value="0"');

// <Tag>...</Tag> をインデントで対応づけて切り出す（同名タグの入れ子に引っかからない）
function cut(xml, openRe) {
  const m = openRe.exec(xml);
  if (!m) throw new Error("見つかりません: " + openRe);
  const indent = m[1];
  const tag = m[2];
  const close = `\n${indent}</${tag}>`;
  const end = xml.indexOf(close, m.index) + close.length;
  return xml.slice(m.index + 1, end); // 先頭の改行は含めない
}

function stripList(block, tag, marker, nth = 1) {
  // <tag> の nth 番目の中身を丸ごと placeholder にする（<tag> と </tag> は残す）。
  // 同じタグが 2 回出る（MainSequencer と FreezeSequencer の ClipSlotList）ので、
  // 何番目かを指定しないと 1 つ目を 2 回置き換えてしまう
  const re = new RegExp(`(\\n\\t*<${tag}>)[\\s\\S]*?(\\n\\t*</${tag}>)`, "g");
  let i = 0;
  const out = block.replace(re, (m, open, close) => (++i === nth ? `${open}\n${marker}${close}` : m));
  if (i < nth) throw new Error(`<${tag}> の ${nth} 番目が無い`);
  return out;
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const write = (n, s) => { fs.writeFileSync(path.join(OUT, n), s); console.log(`  ${n.padEnd(30)} ${s.length.toLocaleString()} bytes / PID ${(s.match(/__PID\d+__/g) || []).length} / placeholder ${[...new Set(s.match(/__[A-Z_]+\d*__/g) || [])].length}`); };

  // 抽出元の Hard Drops.als が無ければ、Hard Drops 由来のテンプレートはコミット済みのものを使い、
  // そこから派生するもの（デバイス無し MIDI トラック）と別の実物由来のもの（MIDI クリップ）だけ作る
  if (!fs.existsSync(REAL)) {
    console.log("Hard Drops.als が無いため、派生テンプレートだけ作ります");
    const at = fs.readFileSync(path.join(OUT, "audio-track.xml"), "utf8");
    const mb = fs.readFileSync(path.join(OUT, "midi-drumrack-track.xml"), "utf8").replace(/__PID(\d+)__/g, (_, n) => `Id_${n}`);
    deriveMidiTrack(at, mb.replace(/Id_(\d+)/g, (_, n) => `9${n.padStart(5, "0")}`), write);
    extractMidiClipSlot(write);
    return;
  }

  const d = readAls(DEFAULT);
  const h = readAls(REAL);

  // ---- 土台となる LiveSet（Hard Drops.als からトラックとシーンを抜いたもの）----
  // DefaultLiveSet.als は Live 12.1d1 が書いたもので、12.4.5 形式のトラックを差し込むと
  // スキーマ移行に掛かって「group track freeze sequencer slots not empty」で開けない。
  // 土台も同じバージョンの実物から起こす
  const ht = listTracks(h);
  let base = h;
  for (const t of ht.filter((t) => t.tag !== "ReturnTrack").reverse()) base = base.slice(0, t.start) + base.slice(t.end + 1);
  base = base.replace(/(\n\t\t<Scenes>)[\s\S]*?(\n\t\t<\/Scenes>)/, "$1\n__SCENES__$2");
  // 自分のホーム配下のパスが残っていたら止める。/Users/nsh/… は Ableton の純正テンプレート由来
  // （リターントラックの Delay プリセット参照）で、DefaultLiveSet.als にも入っているのでそのまま
  const home = os.homedir();
  if (base.includes(home)) throw new Error("土台に個人のパスが残っている: " + new RegExp(`[^"]*${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"]*`).exec(base)[0]);
  write("live-set.xml", base);

  // ---- オーディオトラック（Hard Drops の 808S からクリップを抜いたもの）----
  const dt = ht.find((t) => t.tag === "AudioTrack" && t.name === "808S");
  let at = h.slice(dt.start, dt.end);
  at = at.replace(/^(\t*<AudioTrack Id=")\d+"/, '$1__ID__"');
  at = at.replace(/<EffectiveName Value="[^"]*"/, '<EffectiveName Value="__NAME__"').replace(/<UserName Value="[^"]*"/, '<UserName Value="__NAME__"');
  at = at.replace(/<TrackGroupId Value="-?\d+"/, '<TrackGroupId Value="-1"');
  at = stripList(at, "ClipSlotList", "__SLOTS__"); // MainSequencer 側
  at = stripList(at, "ClipSlotList", "__FREEZE_SLOTS__", 2); // FreezeSequencer 側（2 つ目）
  at = at.replace(/<Color Value="\d+" \/>/, '<Color Value="__COLOR__" />');
  if (/<AudioClip /.test(at)) throw new Error("audio-track にクリップが残っている");
  write("audio-track.xml", zeroLom(pidify(at)));

  // 空スロット（Hard Drops の空スロット 4 = 実物）
  const hb = h.slice(dt.start, dt.end);
  const emptySlot = cut(hb, /\n(\t+)<(ClipSlot) Id="4">/);
  write("clip-slot-empty.xml", zeroLom(emptySlot.replace(/<ClipSlot Id="4">/, '<ClipSlot Id="__INDEX__">')));

  // クリップ入りスロット（Hard Drops のスロット 0）
  let slot = cut(hb, /\n(\t+)<(ClipSlot) Id="0">/);
  slot = slot.replace(/<ClipSlot Id="0">/, '<ClipSlot Id="__INDEX__">');
  const rep = (re, to) => { if (!re.test(slot)) throw new Error("無い: " + re); slot = slot.replace(re, to); };
  rep(/<Name Value="[^"]*" \/>/, '<Name Value="__NAME__" />');
  rep(/<Color Value="\d+" \/>/, '<Color Value="__COLOR__" />');
  rep(/<RelativePath Value="[^"]*" \/>/, '<RelativePath Value="__REL__" />');
  rep(/<Path Value="[^"]*" \/>/, '<Path Value="__ABS__" />');
  rep(/<OriginalFileSize Value="\d+" \/>/, '<OriginalFileSize Value="__BYTES__" />');
  rep(/<OriginalCrc Value="\d+" \/>/, '<OriginalCrc Value="0" />');
  rep(/<LastModDate Value="\d+" \/>/, '<LastModDate Value="__MTIME__" />');
  rep(/<DefaultDuration Value="\d+" \/>/, '<DefaultDuration Value="__FRAMES__" />');
  rep(/<DefaultSampleRate Value="\d+" \/>/, '<DefaultSampleRate Value="__RATE__" />');
  for (const k of ["CurrentEnd", "LoopEnd", "OutMarker", "HiddenLoopEnd"]) rep(new RegExp(`<${k} Value="[^"]*" \\/>`), `<${k} Value="__BEATS__" />`);
  rep(/<WarpMarkers>[\s\S]*?<\/WarpMarkers>/, "<WarpMarkers>\n__WARP__\n</WarpMarkers>");
  write("clip-slot-audio.xml", zeroLom(slot));

  // ---- Drum Rack 入り MIDI トラック（Hard Drops の OS VOX）と DrumBranch ----
  const mt = ht.find((t) => t.name === "OS VOX");
  let mb = h.slice(mt.start, mt.end);
  const branch = cut(mb, /\n(\t+)<(DrumBranch) Id="0">/);
  mb = mb.replace(/^(\t*<MidiTrack Id=")\d+"/, '$1__ID__"');
  mb = mb.replace(/<EffectiveName Value="OS VOX"/, '<EffectiveName Value="__NAME__"').replace(/<UserName Value="OS VOX"/, '<UserName Value="__NAME__"');
  mb = mb.replace(/<TrackGroupId Value="-?\d+"/, '<TrackGroupId Value="-1"');
  mb = stripList(mb, "Branches", "__BRANCHES__");
  mb = stripList(mb, "ClipSlotList", "__SLOTS__");
  mb = stripList(mb, "ClipSlotList", "__FREEZE_SLOTS__", 2);
  mb = mb.replace(/<Color Value="\d+" \/>/, '<Color Value="__COLOR__" />');
  write("midi-drumrack-track.xml", zeroLom(pidify(mb)));

  let br = branch.replace(/<DrumBranch Id="0">/, '<DrumBranch Id="__INDEX__">');
  // FileRef は 2 つあり、1 つ目は空（Path=""）。実パスを持つ 2 つ目だけを差し替える
  const stem = /<Path Value="[^"]*\/([^"/]+)\.wav" \/>/.exec(br)[1];
  br = br.replace(/<FileRef>[\s\S]*?<\/FileRef>/g, (blk) => {
    if (!/\.wav" \/>/.test(blk)) return blk;
    return blk
      .replace(/<RelativePath Value="[^"]*" \/>/, '<RelativePath Value="__REL__" />')
      .replace(/<Path Value="[^"]*" \/>/, '<Path Value="__ABS__" />')
      .replace(/<OriginalFileSize Value="\d+" \/>/, '<OriginalFileSize Value="__BYTES__" />')
      .replace(/<OriginalCrc Value="\d+" \/>/, '<OriginalCrc Value="0" />');
  });
  const brep = (re, to) => { if (!re.test(br)) throw new Error("branch に無い: " + re); br = br.replace(re, to); };
  brep(/<LastModDate Value="\d+" \/>/, '<LastModDate Value="__MTIME__" />');
  brep(/<DefaultDuration Value="\d+" \/>/, '<DefaultDuration Value="__FRAMES__" />');
  brep(/<DefaultSampleRate Value="\d+" \/>/, '<DefaultSampleRate Value="__RATE__" />');
  brep(/<ReceivingNote Value="\d+" \/>/, '<ReceivingNote Value="__RECV__" />');
  br = br.replace(/<SampleEnd Value="\d+" \/>/, '<SampleEnd Value="__LASTFRAME__" />');
  br = br.replace(/<End Value="51212" \/>/g, '<End Value="__LASTFRAME__" />');
  br = br.replace(/<Color Value="\d+" \/>/, '<Color Value="__COLOR__" />');
  // 名前はブランチ名・Simpler のサンプル名など複数箇所に出る。実物の名前を全部 placeholder に
  br = br.split(stem).join("__NAME__");
  write("drum-branch.xml", zeroLom(pidify(br)));

  deriveMidiTrack(at, mb, write);
  extractMidiClipSlot(write);

  // ---- シーン（Hard Drops の Scene 0）----

  // ---- シーン（Hard Drops の Scene 0）----
  const sc = cut(h, /\n(\t+)<(Scene) Id="0">/);
  write("scene.xml", zeroLom(sc.replace(/<Scene Id="0">/, '<Scene Id="__INDEX__">')));

  console.log("\n確認: TimeSignatureId は全シーンで同じか →", [...new Set([...h.matchAll(/<TimeSignatureId Value="(\d+)"/g)].map((m) => m[1]))].join(","));
}

// デバイス無し MIDI トラック: Drum Rack 入り MIDI トラックから Devices の中身を空にする。
// 12.4.5 が書いたデバイス無しの MIDI トラック実物が手元に無いための派生。
// 空リストの書き方は 808S（デバイス無しオーディオ）に合わせる
function deriveMidiTrack(audioTrackXml, midiTrackXml, write) {
  const emptyDevices = /<Devices \/>|<Devices>\s*<\/Devices>/.exec(audioTrackXml);
  if (!emptyDevices) throw new Error("空の Devices の書き方が取れない");
  let plain = midiTrackXml.replace(/<Devices>[\s\S]*?\n(\t*)<\/Devices>/, emptyDevices[0]);
  if (/<DrumGroupDevice|<DrumBranch|__BRANCHES__/.test(plain)) throw new Error("midi-track に Drum Rack が残っている");
  write("midi-track.xml", zeroLom(pidify(plain)));
}

// MIDI クリップ入りスロット: Live 12.4.5 が書いた、MPE データ無しの MidiClip から
function extractMidiClipSlot(write) {
  const MIDI_SRC = path.join(os.homedir(), "Music/Ableton/User Library/Project/Ambient TRACK Project/20260612_ModelledAmbient.als");
  if (!fs.existsSync(MIDI_SRC)) { console.log("  clip-slot-midi.xml は抽出元が無いためスキップ"); return; }
  const mx = readAls(MIDI_SRC);
  const re = /\n(\t+)<ClipSlot Id="(\d+)">\n\1\t<LomId Value="\d+" \/>\n\1\t<ClipSlot>\n\1\t\t<Value>\n\1\t\t\t<MidiClip [\s\S]*?\n\1<\/ClipSlot>/g;
  const cands = [...mx.matchAll(re)].map((m) => m[0]).filter((c) => !/<PerNoteEventList /.test(c));
  let ms = cands.sort((a, b) => a.length - b.length)[0].slice(1); // 先頭の改行を除く
  const mrep = (rx, to) => { if (!rx.test(ms)) throw new Error("midi slot に無い: " + rx); ms = ms.replace(rx, to); };
  mrep(/<ClipSlot Id="\d+">/, '<ClipSlot Id="__INDEX__">');
  mrep(/<MidiClip Id="\d+" Time="[^"]*">/, '<MidiClip Id="0" Time="0">');
  mrep(/<Name Value="[^"]*" \/>/, '<Name Value="__NAME__" />');
  mrep(/<Color Value="\d+" \/>/, '<Color Value="__COLOR__" />');
  mrep(/<CurrentStart Value="[^"]*" \/>/, '<CurrentStart Value="0" />');
  mrep(/<CurrentEnd Value="[^"]*" \/>/, '<CurrentEnd Value="__BEATS__" />');
  mrep(/<LoopStart Value="[^"]*" \/>/, '<LoopStart Value="0" />');
  mrep(/<LoopEnd Value="[^"]*" \/>/, '<LoopEnd Value="__BEATS__" />');
  mrep(/<OutMarker Value="[^"]*" \/>/, '<OutMarker Value="__BEATS__" />');
  mrep(/<HiddenLoopStart Value="[^"]*" \/>/, '<HiddenLoopStart Value="0" />');
  mrep(/<HiddenLoopEnd Value="[^"]*" \/>/, '<HiddenLoopEnd Value="__BEATS__" />');
  mrep(/<TimeSelection>[\s\S]*?<\/TimeSelection>/, "<TimeSelection>\n<AnchorTime Value=\"0\" />\n<OtherTime Value=\"0\" />\n</TimeSelection>");
  mrep(/<ScrollerTimePreserver>[\s\S]*?<\/ScrollerTimePreserver>/, "<ScrollerTimePreserver>\n<LeftTime Value=\"0\" />\n<RightTime Value=\"0\" />\n</ScrollerTimePreserver>");
  mrep(/<GrooveId Value="-?\d+" \/>/, '<GrooveId Value="-1" />');
  mrep(/<KeyTracks>[\s\S]*?<\/KeyTracks>/, "<KeyTracks>\n__KEYTRACKS__\n</KeyTracks>");
  mrep(/<NoteIdGenerator>\s*<NextId Value="\d+" \/>/, '<NoteIdGenerator>\n<NextId Value="__NEXTNOTEID__" />');
  if (/<MidiNoteEvent /.test(ms)) throw new Error("midi slot にノートが残っている");
  write("clip-slot-midi.xml", zeroLom(ms));
}

main();
