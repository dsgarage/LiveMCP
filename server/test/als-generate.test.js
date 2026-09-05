// scripts/als-generate.js — 小さな偽パックから .als を組み立てて構造を確かめる。
// テンプレートは Live 12.4.5 の実物から起こしたものを使う（templates/）。
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { generate } = require("../../scripts/als-generate");
const { readAls, listTracks, countScenes, nextPointeeId } = require("../../scripts/als");
const { listFileRefs } = require("../../scripts/als-refs");

function wav(frames, rate = 44100) {
  const data = Buffer.alloc(frames * 2 * 2);
  const b = Buffer.alloc(44);
  b.write("RIFF", 0); b.writeUInt32LE(36 + data.length, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(data.length, 40);
  return Buffer.concat([b, data]);
}

function fakePack(root) {
  const pack = path.join(root, "library", "FAKE_Pack (abc)");
  const loops = path.join(pack, "Loops", "Drums & Perc");
  const shots = path.join(pack, "Oneshots", "Kicks");
  fs.mkdirSync(loops, { recursive: true });
  fs.mkdirSync(shots, { recursive: true });
  // 155 BPM で 8 拍（= 2 小節）ぴったりの長さ
  const frames8beats = Math.round((60 / 155) * 8 * 44100);
  fs.writeFileSync(path.join(loops, "FK_Drum_155_E_b.wav"), wav(frames8beats));
  fs.writeFileSync(path.join(loops, "FK_Drum_155_E_a.wav"), wav(frames8beats));
  fs.writeFileSync(path.join(loops, "FK_Drum_120_a.wav"), wav(frames8beats));
  fs.writeFileSync(path.join(shots, "FK_Kick_1.wav"), wav(1000));
  fs.writeFileSync(path.join(shots, "FK_Kick_2.wav"), wav(2000));
  return pack;
}

test("偽パックから .als を組み立てられる", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "als-gen-"));
  const pack = fakePack(root);
  const out = path.join(root, "Project", "X TRACK Project", "FAKE_Pack.als");

  // 偽ファイルは無音なのでファイル判定は切る（ここで見るのは .als の構造）
  const r = generate({ packDir: pack, output: out, loops: ["Loops/Drums & Perc"], oneshots: ["Oneshots/Kicks"], classify: false });

  assert.ok(fs.existsSync(out));
  assert.ok(fs.existsSync(path.join(path.dirname(out), "Ableton Project Info")));
  assert.strictEqual(r.bpm, 155);        // 155 が 2 本、120 が 1 本
  assert.strictEqual(r.scenes, 8);       // 最低 8

  const xml = readAls(out);
  // クリップ自身のテンポ（WarpMarker の拍数）は、セットのテンポではなくそのファイルの BPM で計算する。
  // 155 BPM の長さ（8 拍）のファイルに 120 と名付けてあるので、120 で計算すると 6.25 拍になる
  const warp = (name) => { const m = new RegExp(`<Name Value="${name}" />[\\s\\S]*?<WarpMarker Id="1" SecTime="([^"]*)" BeatTime="([^"]*)" />`).exec(xml); return { sec: +m[1], beats: +m[2] }; };
  assert.strictEqual(warp("FK_Drum_155_E_a").beats, 8);
  assert.ok(Math.abs(warp("FK_Drum_120_a").beats - 6.1936) < 0.001, "格子から離れた拍数は丸めない");
  assert.ok(Math.abs(warp("FK_Drum_120_a").beats / warp("FK_Drum_120_a").sec * 60 - 120) < 0.05, "クリップのテンポが名前の 120 と一致する");
  assert.doesNotMatch(xml, /__[A-Z_]+\d*__/, "placeholder が残っている");
  assert.strictEqual(countScenes(xml), 8);
  assert.match(xml, /<Tempo>\s*<LomId Value="0" \/>\s*<Manual Value="155" \/>/);

  const tracks = listTracks(xml);
  assert.deepStrictEqual(
    tracks.map((t) => `${t.tag}:${t.name}${t.groupId >= 0 ? "*" : ""}`),
    ["GroupTrack:LOOPS", "AudioTrack:DRUMS & PERC*", "GroupTrack:ONE SHOTS", "MidiTrack:OS KICKS*", "ReturnTrack:A-Reverb", "ReturnTrack:B-Delay"]
  );

  // クリップはテンポ → キー → 名前の順（120 が先、155 は a → b）
  const names = [...xml.matchAll(/<AudioClip Id="\d+"[^>]*>[\s\S]*?<Name Value="([^"]*)" \/>/g)].map((m) => m[1]);
  assert.deepStrictEqual(names, ["FK_Drum_120_a", "FK_Drum_155_E_a", "FK_Drum_155_E_b"]);
  // 8 拍ぴったりの素材は 8 拍のクリップになる
  assert.ok(xml.includes('<CurrentEnd Value="8" />'));

  // パッドは C0(24) から。XML の ReceivingNote は 128 - ノート
  const recv = [...xml.matchAll(/<ReceivingNote Value="(\d+)" \/>/g)].map((m) => Number(m[1]));
  assert.deepStrictEqual(recv, [104, 103]);
  assert.ok(xml.includes('<SampleEnd Value="999" />'));

  // 参照は .als のあるフォルダからの相対 + 絶対、実在するファイル
  const refs = listFileRefs(xml).filter((f) => /\.wav$/.test(f.path));
  assert.strictEqual(refs.length, 5);
  for (const f of refs) {
    assert.ok(fs.existsSync(f.path), f.path);
    assert.ok(fs.existsSync(path.resolve(path.dirname(out), f.relativePath)), f.relativePath);
  }

  // ポインタ id は NextPointeeId の手前に収まり、重複しない
  const ids = [...xml.matchAll(/Id="(\d{4,})"/g)].map((m) => Number(m[1]));
  assert.ok(Math.max(...ids) < nextPointeeId(xml));
  const base = nextPointeeId(fs.readFileSync(path.join(__dirname, "../../templates/live-set.xml"), "utf8"));
  const inTracks = ids.filter((n) => n >= base); // 土台の NextPointeeId 以降が今回振った分
  assert.strictEqual(new Set(inTracks).size, inTracks.length, "ポインタ id が重複している");

  fs.rmSync(root, { recursive: true, force: true });
});

test("素材が無ければ失敗し、105 個以上のワンショットは複数ラックに分ける", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "als-gen-"));
  const pack = fakePack(root);
  assert.throws(() => generate({ packDir: pack, output: path.join(root, "x.als"), loops: ["nope"] }), /素材がありません/);

  const many = path.join(pack, "Oneshots", "Many");
  fs.mkdirSync(many);
  for (let i = 0; i < 110; i++) fs.writeFileSync(path.join(many, `S_${String(i).padStart(3, "0")}.wav`), wav(10));
  const r = generate({ packDir: pack, output: path.join(root, "P", "m.als"), oneshots: ["Oneshots/Many"], groups: false });
  const tracks = listTracks(readAls(r.output)).filter((t) => t.tag === "MidiTrack").map((t) => t.name);
  assert.deepStrictEqual(tracks, ["OS MANY", "OS MANY 2"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("フォルダの中にフォルダがあれば 1 段下ごとにトラックを分け、ベンダー接頭辞は外す", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "als-gen-"));
  const pack = path.join(root, "SM_Pack");
  for (const d of ["SMD_WAV_LOOPS/SMD_Drums", "SMD_WAV_LOOPS/SMD_Music"]) fs.mkdirSync(path.join(pack, d), { recursive: true });
  fs.writeFileSync(path.join(pack, "SMD_WAV_LOOPS/SMD_Drums/SMD_120_a.wav"), wav(44100));
  fs.mkdirSync(path.join(pack, "SMD_WAV_LOOPS/SMD_Atmo_Lps"));
  fs.writeFileSync(path.join(pack, "SMD_WAV_LOOPS/SMD_Atmo_Lps/SMD_70_x.wav"), wav(44100));
  fs.writeFileSync(path.join(pack, "SMD_WAV_LOOPS/SMD_Music/SMD_120_C_b.wav"), wav(44100));
  fs.writeFileSync(path.join(pack, "SMD_WAV_LOOPS/SMD_120_top.wav"), wav(44100)); // 直下のファイル
  // 無音 1 秒の偽ファイルなのでファイル判定は切る（ここで見るのはトラックの分け方）
  const r = generate({ packDir: pack, output: path.join(root, "P", "s.als"), loops: ["SMD_WAV_LOOPS"], groups: false, classify: false });
  const names = listTracks(readAls(r.output)).filter((t) => t.tag === "AudioTrack").map((t) => t.name);
  assert.deepStrictEqual(names, ["LOOPS", "ATMO", "DRUMS", "MUSIC"]);
  fs.rmSync(root, { recursive: true, force: true });
});

// 音の入った偽 WAV（16bit ステレオ）。amp(t) で包絡を与える
function toneWav(seconds, amp, rate = 44100) {
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((i / rate) * 220 * 2 * Math.PI) * amp(i / frames) * 20000);
    data.writeInt16LE(v, i * 4); data.writeInt16LE(v, i * 4 + 2);
  }
  const b = Buffer.alloc(44);
  b.write("RIFF", 0); b.writeUInt32LE(36 + data.length, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(data.length, 40);
  return Buffer.concat([b, data]);
}

test("ループのフォルダに入っていた単発は OS の Drum Rack へ、単発のフォルダに入っていたループはオーディオトラックへ", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "als-gen-"));
  const pack = path.join(root, "LCD_Pack");
  fs.mkdirSync(path.join(pack, "Bass Music/Closed Hats"), { recursive: true });
  fs.mkdirSync(path.join(pack, "Drums/Drum Loops"), { recursive: true });
  // "Bass Music" はフォルダ名だとループに見えるが、中身は 0.3 秒の減衰する単発
  for (const n of [1, 2, 3]) fs.writeFileSync(path.join(pack, `Bass Music/Closed Hats/LCD_ClosedHH_${n}.wav`), toneWav(0.3, (t) => Math.exp(-8 * t)));
  // "Drums" は単発に見えるが、中身は 120 BPM で 4 拍ちょうど・切りっぱなしのループ
  fs.writeFileSync(path.join(pack, "Drums/Drum Loops/LCD_120_Groove.wav"), toneWav(2.0, () => 1));
  const r = generate({
    packDir: pack, output: path.join(root, "P", "l.als"), groups: false,
    loops: [{ name: "Bass Music/Closed Hats", strength: "weak" }],
    oneshots: [{ name: "Drums/Drum Loops", strength: "weak" }],
  });
  const tracks = listTracks(readAls(r.output)).filter((t) => t.tag !== "ReturnTrack").map((t) => `${t.tag}:${t.name}`);
  assert.deepStrictEqual(tracks, ["AudioTrack:DRUM", "MidiTrack:OS CLOSED HATS"]); // "Drum Loops" の LOOPS は落ちる
  assert.strictEqual(r.review.filter((x) => x.flipped).length, 4); // 4 本ともフォルダ分類と逆になった
  // 人がファイル単位で指定すれば判定より優先
  const r2 = generate({
    packDir: pack, output: path.join(root, "P", "l2.als"), groups: false,
    loops: ["Bass Music/Closed Hats"], fileKinds: { "Bass Music/Closed Hats/LCD_ClosedHH_1.wav": "loop" },
  });
  assert.deepStrictEqual(r2.loops, [{ track: "CLOSED HATS", clips: 1 }]);
  assert.deepStrictEqual(r2.oneshots, [{ track: "OS CLOSED HATS", pads: 2 }]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("曲キット型のパート列は Mix が先頭、MIDI だけのパートは名前の頭が一致する WAV パートの直後", () => {
  const { orderRoles } = require("../../scripts/als-generate");
  const song = (parts) => ({ parts: new Map(Object.entries(parts)) });
  // Vol.3 の形: WAV は PIANO 1 本、MIDI は PIANO 1/2/3。MIDI フォルダが先に読まれても WAV が先
  const roles = orderRoles([
    song({ "PIANO 1": { mid: {} }, "PIANO 2": { mid: {} }, "PIANO 3": { mid: {} }, PIANO: { wav: {} } }),
  ]);
  assert.deepStrictEqual(roles, ["PIANO", "PIANO 1", "PIANO 2", "PIANO 3"]);
  // Vol.4 の形: PAD が先に見つかっても FULL MIX を先頭に。WAV+MIDI のあるパートはそのまま
  const roles2 = orderRoles([
    song({ PAD: { wav: {}, mid: {} }, "PIANO 1": { wav: {}, mid: {} }, "FULL MIX": { wav: {} }, STRINGS: { mid: {} } }),
  ]);
  assert.deepStrictEqual(roles2, ["FULL MIX", "PAD", "PIANO 1", "STRINGS"]);
});

// 曲キット型（Singomakers Emotional Piano の形）: 曲フォルダの中に Full_Mix.wav と WAV/ MIDI/
function varlen(n) { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return Buffer.from(b); }
function smf(events, ppq = 96) {
  const body = Buffer.concat(events.map(([d, ...b]) => Buffer.concat([varlen(d), Buffer.from(b)])));
  const trk = Buffer.concat([Buffer.from("MTrk"), Buffer.from([0, 0, 0, body.length]), body]);
  return Buffer.concat([Buffer.from("MThd"), Buffer.from([0, 0, 0, 6, 0, 0, 0, 1, ppq >> 8, ppq & 0xff]), trk]);
}
test("曲キット型は曲を行・パートを列に並べ、WAV の隣に同じパートの MIDI を置く", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "als-gen-"));
  const pack = path.join(root, "SEP5_Pack");
  for (const n of ["02", "01"]) {
    const d = path.join(pack, `SEP5_Song_${n}_E_120_BPM`);
    fs.mkdirSync(path.join(d, `SEP5_Song_${n}_WAV`), { recursive: true });
    fs.mkdirSync(path.join(d, `SEP5_Song_${n}_MIDI`), { recursive: true });
    fs.writeFileSync(path.join(d, `SEP5_Song_${n}_E_120_Bpm_Full_Mix.wav`), wav(88200));
    fs.writeFileSync(path.join(d, `SEP5_Song_${n}_WAV`, `SEP5_Song_${n}_E_120_Bpm_Piano_1.wav`), wav(88200));
    fs.writeFileSync(path.join(d, `SEP5_Song_${n}_MIDI`, `SEP5_Song_${n}_E_120_Bpm_Piano_1.mid`),
      smf([[0, 0x90, 60, 100], [96, 0x80, 60, 64], [0, 0xff, 0x2f, 0]]));
  }
  const r = generate({ packDir: pack, output: path.join(root, "P", "s.als"), layout: "songs" });
  assert.strictEqual(r.songs, 2);
  assert.strictEqual(r.bpm, 120);
  const xml = readAls(r.output);
  const tracks = listTracks(xml).filter((t) => t.tag !== "ReturnTrack").map((t) => `${t.tag}:${t.name}`);
  assert.deepStrictEqual(tracks, ["GroupTrack:SONGS", "AudioTrack:FULL MIX", "AudioTrack:PIANO 1", "MidiTrack:PIANO 1 MIDI"]);
  // 行 = 曲番号順（01 が先）
  const names = [...xml.matchAll(/<AudioClip Id="\d+"[^>]*>[\s\S]*?<Name Value="([^"]*)" \/>/g)].map((m) => m[1]);
  assert.deepStrictEqual(names.slice(0, 2), ["SEP5_Song_01_E_120_Bpm_Full_Mix", "SEP5_Song_02_E_120_Bpm_Full_Mix"]);
  // MIDI クリップにノートが入り、長さは小節単位（土台の LiveSet にも MidiClip が 1 つあるのでトラック内だけ数える）
  const midiTrack = listTracks(xml).find((t) => t.name === "PIANO 1 MIDI");
  assert.strictEqual((xml.slice(midiTrack.start, midiTrack.end).match(/<MidiClip Id=/g) || []).length, 2);
  assert.match(xml, /<MidiNoteEvent Time="0" Duration="1" Velocity="100" OffVelocity="64" NoteId="1" \/>/);
  assert.match(xml, /<MidiKey Value="60" \/>/);
  assert.doesNotMatch(xml, /__[A-Z_]+\d*__/);
  // シーンは曲名とテンポを持つ
  assert.match(xml, /<Name Value="01 E 120" \/>/);
  assert.ok((xml.match(/<IsTempoEnabled Value="true" \/>/g) || []).length >= 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("曲キット型: 曲番号はファイル名から。\"SEPT2_WAV_24\" の 24 は曲番号ではない", () => {
  const { collectSongs } = require("../../scripts/als-generate");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "als-gen-"));
  const pack = path.join(root, "SEPT2_Pack");
  fs.mkdirSync(path.join(pack, "SEPT2_WAV_24"), { recursive: true });
  fs.mkdirSync(path.join(pack, "SEPT 2_MIDI"), { recursive: true });
  for (const n of ["01", "02", "03"]) {
    fs.writeFileSync(path.join(pack, "SEPT2_WAV_24", `SEPT2_${n}_93_bpm_D.wav`), wav(88200));
    fs.writeFileSync(path.join(pack, "SEPT 2_MIDI", `SEPT2_${n}_93_bpm_D.mid`), smf([[0, 0x90, 60, 100], [96, 0x80, 60, 64], [0, 0xff, 0x2f, 0]]));
  }
  const { songs, roles } = collectSongs(pack);
  assert.deepStrictEqual(songs.map((s) => s.number), [1, 2, 3]);
  assert.deepStrictEqual(roles, ["MAIN"]);
  assert.ok(songs.every((s) => s.parts.get("MAIN").wav && s.parts.get("MAIN").mid));
  fs.rmSync(root, { recursive: true, force: true });
});

test("トラック名: ベンダー接頭辞は外すが、RIFF_ / DRUM_ のような語は残す", () => {
  const { trackNameOf } = require("../../scripts/als-generate");
  assert.strictEqual(trackNameOf("SMD_Drums"), "DRUMS");
  assert.strictEqual(trackNameOf("RIFF_Dist_Rch"), "RIFF DIST RCH");
  assert.strictEqual(trackNameOf("Bass_wav"), "BASS");
  assert.strictEqual(trackNameOf("GA2_Textures_FRK"), "TEXTURES FRK");
  assert.strictEqual(trackNameOf("SMD_WAV_LOOPS"), "LOOPS");
});

test("BPM の隣にある 1 文字のキーはパート名に混ぜない", () => {
  const { roleAndSong } = require("../../scripts/als-generate");
  assert.strictEqual(roleAndSong("SEP4_Melody_03_110_Bpm_D_Pad.wav", new Set(["SEP4"])).role, "PAD");
  assert.strictEqual(roleAndSong("SEP4_Melody_03_110_Bpm_G#_Full_Mix.wav", new Set(["SEP4"])).role, "FULL MIX");
  assert.strictEqual(roleAndSong("SEP9_130_C#_Kit_03_Piano_Main_Mix.wav", new Set(["SEP9"])).role, "PIANO MAIN MIX");
});

test("親フォルダの下りで、別の種別として分類表に載っている子フォルダは二重に拾わない", () => {
  const { collect } = require("../../scripts/als-generate");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "als-gen-"));
  const pack = path.join(root, "VOX_Pack");
  fs.mkdirSync(path.join(pack, "Vocals/Bonus_Phrases"), { recursive: true });
  for (const f of ["Vocals/v1.wav", "Vocals/v2.wav", "Vocals/Bonus_Phrases/p1.wav", "Vocals/Bonus_Phrases/p2.wav", "Vocals/Bonus_Phrases/p3.wav"]) fs.writeFileSync(path.join(pack, f), wav(44100));
  const count = (groups) => groups.reduce((a, g) => a + g.files.length + g.shots.length, 0);
  // 分類表: Vocals はワンショット側、Vocals/Bonus_Phrases はループ側（STAY_INSPIRED_VOCALS と同じ形）
  const listedFolders = ["Vocals", "Vocals/Bonus_Phrases"];
  const shots = collect(pack, ["Vocals"], { prior: "oneshot", classify: false, listedFolders });
  const loops = collect(pack, ["Vocals/Bonus_Phrases"], { prior: "loop", classify: false, listedFolders });
  assert.strictEqual(count(shots), 2, "ワンショット側は直下の 2 本だけ");
  assert.strictEqual(count(loops), 3);
  // listedFolders を渡さないと親側が子を再帰で拾って 5 本になる（以前の挙動）
  assert.strictEqual(count(collect(pack, ["Vocals"], { prior: "oneshot", classify: false })), 5);
  fs.rmSync(root, { recursive: true, force: true });
});
