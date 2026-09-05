#!/usr/bin/env node
// サンプルパックから .als を丸ごと生成する（Live を使わない）。
//
//   node scripts/als-generate.js <パックのフォルダ> <出力.als> [--loops <sub>,...] [--oneshots <sub>,...] [--name <セット名>]
//
// 配置は Hard Drops のとき（Issue #2）と同じ:
//   - ループ:     フォルダごとにオーディオトラック。クリップはテンポ → キー → 名前の順に縦に並べる
//   - ワンショット: フォルダごとに Drum Rack 入り MIDI トラック。C0(24) から半音ずつパッドへ
//   - ループ側は LOOPS、ワンショット側は ONE SHOTS のグループにまとめる
//   - テンポはパック内で最も多い BPM
//
// テンプレートは Live 12.4.5 が実際に書いたセットから起こしたもの（scripts/extract-templates.js）。
// スキーマは推測していない。可変部分だけを差し替え、ポインタ id は NextPointeeId から
// 文書順に連番で振る（Live の流儀。Group トラック生成で検証済み）。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const als = require("./als");
const { escapeAttr } = require("./als-refs");
const { audioInfo } = require("./audio-info");
const { parseSampleName, compareSamples, centralBpm } = require("./sample-meta");
const { parseMidi } = require("./midi-file");
const { classifySample, decideKind } = require("./sample-kind");
const { LoopcloudDb } = require("./loopcloud-db");

const TEMPLATE_DIR = path.join(__dirname, "..", "templates");
// 土台は Live 12.4.5 が書いた実物から起こした LiveSet（templates/live-set.xml）。
// Live 同梱の DefaultLiveSet.als は 12.1d1 製で、12.4.5 形式のトラックを入れると
// スキーマ移行に掛かって開けない
const DEFAULT_SET = path.join(TEMPLATE_DIR, "live-set.xml");
const AUDIO = /\.(wav|aif|aiff)$/i;
const FIRST_NOTE = 24; // Ableton 表記の C0
const MAX_PADS = 128 - FIRST_NOTE;
const LOOP_COLOR = 10;

// テンプレートはクリップ / パッドごとに読むので 1 度読んだら使い回す
const tplCache = new Map();
const tpl = (n) => { if (!tplCache.has(n)) tplCache.set(n, fs.readFileSync(path.join(TEMPLATE_DIR, n), "utf8")); return tplCache.get(n); };

// ---- 素材の収集 ----

function listAudio(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (AUDIO.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// トラック名: ベンダー接頭辞（SMD_ など）を外し、_ を空白に、大文字に。
// 楽器や種類を表す語（RIFF_ / DRUM_ / BASS_ …）は接頭辞ではないので残す
const NOT_PREFIX = /^(RIFF|RIFFS|DRUM|DRUMS|BASS|LOOP|LOOPS|VOX|VOCAL|KICK|SNARE|HAT|HATS|PERC|SYNTH|PAD|PADS|KEYS|FX|SFX|LEAD|ARP|TOP|TOPS|FILL|FILLS|HIT|HITS|MIX|STEM|STEMS|KIT|KITS|SONG|MIDI|WAV)$/i;
function trackNameOf(folder) {
  return folder
    .replace(/^([A-Z0-9]{2,6})_/, (m, p) => (NOT_PREFIX.test(p) ? m : ""))
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .replace(/\s+(LPS|WAV LOOPS|LOOPS|WAV)$/, "") // "ATMO LPS" / "GUITAR WAV LOOPS" → "ATMO" / "GUITAR"
    .trim()
    .replace(/^WAV$/, "LOOPS") || "LOOPS"; // フォルダ名が WAV_LOOPS だけなら LOOPS
}

// subfolders: フォルダ名の配列。文字列でも { name, strength } でもよい
//   strength は分類表の "explicit" / "weak" / "forced"（人が overrides で決めたフォルダ。ファイル判定をしない）
// prior: このフォルダ群に付いたフォルダ分類（"loop" | "oneshot" | null）。ファイル判定と合わせて最終の種別を決める
// fileKinds: { "<パック内相対パス>": "loop" | "oneshot" } 人が決めたファイル単位の指定（最優先）
// classify: false でファイル判定を切る（フォルダ分類だけで振る）
//
// 返り値: [{ name: トラック名, files: ループ, shots: ワンショット, review: 見直し候補 }]（メタ順にソート済み）
// フォルダの中にさらにフォルダがあれば、その 1 段下ごとにトラックを分ける
// （Sample Magic 型の WAV_LOOPS/Drums, /Music, /Bass … → 参考プロジェクトの DRUM / MUSIC / BASS と同じ形）。
// フォルダ直下にもファイルがあれば、それはフォルダ名のトラックにまとめる
// listedFolders: 分類表に載っている全フォルダ（ループ側・ワンショット側）。親の下りで、別の種別として
//   載っている子フォルダを二重に拾わないために使う。省略時はこの呼び出しの subfolders だけ
function collect(packDir, subfolders, { prior = null, fileKinds = {}, classify = true, listedFolders = null } = {}) {
  const groups = [];
  const entries = subfolders.map((s) => (typeof s === "string" ? { name: s, strength: "weak" } : s));
  const listed = new Set(listedFolders || entries.map((e) => e.name)); // 分類表が葉まで書いているときは、親側で子を二重に拾わない
  const push = (name, dir, recursive, strength) => {
    const list = recursive ? listAudio(dir) : fs.readdirSync(dir).filter((n) => AUDIO.test(n) && !n.startsWith(".")).map((n) => path.join(dir, n));
    const items = list
      .map((p) => ({ path: p, meta: parseSampleName(p), info: audioInfo(p) }))
      .filter((f) => f.info) // ヘッダが読めないものは飛ばす
      .map((f) => {
        // 名前に BPM が無ければ WAV の acid チャンクから（Loopmasters 系はこちらだけのことがある）
        if (f.meta.bpm == null && f.info.acidTempo) f.meta.bpm = Math.round(f.info.acidTempo);
        return f;
      });
    const files = [], shots = [], review = [];
    const lc = LoopcloudDb.shared();
    for (const f of items) {
      const rel = path.relative(packDir, f.path);
      const lcItem = lc && lc.lookup(f.path);
      // 名前にも acid にも BPM が無ければ Loopcloud の BPM（クリップのテンポに使う）
      if (f.meta.bpm == null && lcItem && lcItem.bpm) f.meta.bpm = Math.round(lcItem.bpm);
      let kind = fileKinds[rel] || null;
      if (!kind && strength === "forced") kind = prior; // 人が決めたフォルダはファイル判定をしない
      if (!kind && classify) {
        // フォルダ名のヒントは、パックからの相対パスのフォルダ部分ぜんぶ（"SOUNDS_&_FX/UPLIFTERS" のどちらの語も見る）。
        // Loopcloud の DB にタグがあればそれが正解になる
        const r = classifySample(f.path, { dir: path.dirname(rel), loopcloud: lcItem, info: f.info });
        const d = decideKind(r, prior, strength || "weak");
        kind = d.kind;
        if (d.flipped || d.uncertain) review.push({ file: rel, folder: prior, kind, final: d.final, flipped: d.flipped, uncertain: d.uncertain, tagged: d.tagged, reasons: r.reasons });
      }
      if (!kind) kind = prior || "loop";
      (kind === "oneshot" ? shots : files).push(f);
    }
    files.sort((a, b) => compareSamples(a.meta, b.meta));
    shots.sort((a, b) => compareSamples(a.meta, b.meta));
    if (files.length || shots.length) groups.push({ name, files, shots, review });
  };
  for (const sub of entries) {
    const dir = path.join(packDir, sub.name);
    if (!fs.existsSync(dir)) continue;
    const kids = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name)); // 並びを決定的にする
    if (!kids.length) { push(trackNameOf(path.basename(sub.name)), dir, true, sub.strength); continue; }
    push(trackNameOf(path.basename(sub.name)), dir, false, sub.strength);
    for (const k of kids) if (!listed.has(`${sub.name}/${k.name}`)) push(trackNameOf(k.name), path.join(dir, k.name), true, sub.strength);
  }
  return groups;
}

// ---- ポインタ id の割り当て ----
// テンプレートの __PID<n>__ をブロックごとに新しい連番へ。同じブロック内で同じ n は同じ id になる。
function makePidAllocator(start) {
  let next = start;
  return {
    apply(block) {
      const map = new Map();
      const out = block.replace(/__PID(\d+)__/g, (_, n) => {
        if (!map.has(n)) map.set(n, next++);
        return String(map.get(n));
      });
      return out;
    },
    get next() { return next; },
  };
}

// ---- ブロックの組み立て ----

function relFrom(alsDir, file) {
  return path.relative(alsDir, file).split(path.sep).join("/");
}

function warpMarkers(seconds, beats, bpm) {
  // Live は末尾に「1/32 拍先」のマーカーをもう 1 つ置く（実物で確認: 12.387→12.399s, 32→32.03125）
  const secPerBeat = 60 / bpm;
  const lines = [
    `<WarpMarker Id="0" SecTime="0" BeatTime="0" />`,
    `<WarpMarker Id="1" SecTime="${seconds}" BeatTime="${beats}" />`,
    `<WarpMarker Id="2" SecTime="${seconds + secPerBeat / 32}" BeatTime="${beats + 1 / 32}" />`,
  ];
  return lines.map((l) => "\t".repeat(12) + l).join("\n");
}

function audioClipSlot(index, file, alsDir, bpm) {
  const { info, meta } = file;
  const seconds = info.frames / info.sampleRate;
  // 拍数: 1/4 拍の格子に十分近ければ格子に載せる（ループはほぼ小節単位。実物: 12.387s @155 = 32.0 拍）。
  // 離れていれば丸めない（丸めるとクリップのテンポが名前の BPM からずれる）
  const raw = (seconds * bpm) / 60;
  const grid = Math.round(raw * 4) / 4;
  const beats = Math.max(0.25, Math.abs(raw - grid) < 0.02 ? grid : Math.round(raw * 10000) / 10000);
  return tpl("clip-slot-audio.xml")
    .replace(/__INDEX__/g, String(index))
    .replace(/__NAME__/g, escapeAttr(meta.stem))
    .replace(/__COLOR__/g, String(LOOP_COLOR))
    .replace(/__REL__/g, escapeAttr(relFrom(alsDir, file.path)))
    .replace(/__ABS__/g, escapeAttr(file.path))
    .replace(/__BYTES__/g, String(info.bytes))
    .replace(/__MTIME__/g, String(Math.floor(fs.statSync(file.path).mtimeMs / 1000)))
    .replace(/__FRAMES__/g, String(info.frames))
    .replace(/__RATE__/g, String(info.sampleRate))
    .replace(/__BEATS__/g, String(beats))
    .replace(/__WARP__/, warpMarkers(seconds, beats, bpm));
}

const emptySlot = (index) => tpl("clip-slot-empty.xml").replace(/__INDEX__/g, String(index));

function audioTrack({ id, name, color, files, scenes, alsDir, bpm, pid }) {
  const slots = [];
  // 拍数（= クリップ自身のテンポ）は必ずそのファイルの BPM で計算する。セットのテンポで計算すると
  // 155 BPM のループが「120 BPM の 6.2 拍」になり、Seg. BPM が名前と食い違って小節も合わなくなる。
  // BPM の分からないファイル（FX 等）だけセットのテンポ（原速で鳴る）
  for (let i = 0; i < scenes; i++) slots.push(files[i] ? audioClipSlot(i, files[i], alsDir, files[i].meta.bpm || bpm) : emptySlot(i));
  const freeze = [];
  for (let i = 0; i < scenes; i++) freeze.push(emptySlot(i));
  const block = tpl("audio-track.xml")
    .replace(/__ID__/g, String(id))
    .replace(/__NAME__/g, escapeAttr(name))
    .replace(/__COLOR__/g, String(color))
    .replace("__SLOTS__", slots.join("\n"))
    .replace("__FREEZE_SLOTS__", freeze.join("\n"));
  return pid.apply(block);
}

function drumBranch(index, file, note, alsDir, color, pid) {
  const { info, meta } = file;
  const block = tpl("drum-branch.xml")
    .replace(/__INDEX__/g, String(index))
    .replace(/__NAME__/g, escapeAttr(meta.stem))
    .replace(/__RECV__/g, String(128 - note)) // 実物: パッド C0(24) の ReceivingNote は 104
    .replace(/__REL__/g, escapeAttr(relFrom(alsDir, file.path)))
    .replace(/__ABS__/g, escapeAttr(file.path))
    .replace(/__BYTES__/g, String(info.bytes))
    .replace(/__MTIME__/g, String(Math.floor(fs.statSync(file.path).mtimeMs / 1000)))
    .replace(/__FRAMES__/g, String(info.frames))
    .replace(/__RATE__/g, String(info.sampleRate))
    .replace(/__LASTFRAME__/g, String(Math.max(0, info.frames - 1)))
    .replace(/__COLOR__/g, String(color));
  return pid.apply(block);
}

function drumRackTrack({ id, name, color, files, scenes, alsDir, pid }) {
  // 文書順に id を振るため、トラック本体 → パッドの順で確保する
  const branches = files.map((f, i) => drumBranch(i, f, FIRST_NOTE + i, alsDir, color, pid));
  const slots = [], freeze = [];
  for (let i = 0; i < scenes; i++) { slots.push(emptySlot(i)); freeze.push(emptySlot(i)); }
  const block = tpl("midi-drumrack-track.xml")
    .replace(/__ID__/g, String(id))
    .replace(/__NAME__/g, escapeAttr(name))
    .replace(/__COLOR__/g, String(color))
    .replace("__SLOTS__", slots.join("\n"))
    .replace("__FREEZE_SLOTS__", freeze.join("\n"));
  const body = pid.apply(block); // トラック本体の id はパッドより前に確保したいが、
  // テンプレート展開の都合でパッドを先に作っているため、id の順序は「パッド → 本体」になる。
  // 一意であれば Live は問題なく読む（Group トラック生成で確認済みの性質）。
  return body.replace("__BRANCHES__", branches.join("\n"));
}

// ---- MIDI クリップ ----
// Live の MidiClip はピッチごとの KeyTrack に MidiNoteEvent（拍）を持つ。
// テンプレートは 12.4.5 が書いた MPE 無しのクリップ（templates/clip-slot-midi.xml）
function keyTracksXml(notes) {
  const byPitch = new Map();
  for (const n of notes) { if (!byPitch.has(n.pitch)) byPitch.set(n.pitch, []); byPitch.get(n.pitch).push(n); }
  const T = (n) => "\t".repeat(n);
  const out = [];
  let noteId = 1, ktId = 0;
  for (const pitch of [...byPitch.keys()].sort((a, b) => a - b)) {
    out.push(`${T(14)}<KeyTrack Id="${ktId++}">`, `${T(15)}<Notes>`);
    for (const n of byPitch.get(pitch).sort((a, b) => a.time - b.time)) {
      out.push(`${T(16)}<MidiNoteEvent Time="${n.time}" Duration="${n.duration}" Velocity="${n.velocity}" OffVelocity="64" NoteId="${noteId++}" />`);
    }
    out.push(`${T(15)}</Notes>`, `${T(15)}<MidiKey Value="${pitch}" />`, `${T(14)}</KeyTrack>`);
  }
  return { xml: out.join("\n"), nextNoteId: noteId };
}

function midiClipSlot(index, file, color) {
  // 読めない MIDI が 1 本あってもパック全体を止めない（空のスロットにして続行）
  let midi;
  try { midi = parseMidi(file.path); } catch (e) { console.warn(`  警告: MIDI を読めないため空のスロットにしました: ${file.path}（${e.message}）`); return emptySlot(index); }
  const beats = Math.max(4, Math.ceil(midi.beats / 4) * 4); // 小節単位に切り上げ
  const kt = keyTracksXml(midi.notes);
  return tpl("clip-slot-midi.xml")
    .replace(/__INDEX__/g, String(index))
    .replace(/__NAME__/g, escapeAttr(file.meta.stem))
    .replace(/__COLOR__/g, String(color))
    .replace(/__BEATS__/g, String(beats))
    .replace("__KEYTRACKS__", kt.xml)
    .replace(/__NEXTNOTEID__/g, String(kt.nextNoteId));
}

function midiTrack({ id, name, color, files, scenes, pid }) {
  const slots = [], freeze = [];
  for (let i = 0; i < scenes; i++) { slots.push(files[i] ? midiClipSlot(i, files[i], color) : emptySlot(i)); freeze.push(emptySlot(i)); }
  const block = tpl("midi-track.xml")
    .replace(/__ID__/g, String(id))
    .replace(/__NAME__/g, escapeAttr(name))
    .replace(/__COLOR__/g, String(color))
    .replace("__SLOTS__", slots.join("\n"))
    .replace("__FREEZE_SLOTS__", freeze.join("\n"));
  return pid.apply(block);
}

// ---- 曲キット型パック（Singomakers Emotional Piano 等）----
// 「曲」を行、「パート（Full Mix / Piano 1 …）」を列にする。WAV の隣に同じパートの MIDI。
//   songs/ が曲ごとのフォルダ … その中の wav / mid を集める
//   WAV/ と MIDI/ が平坦     … ファイル名の曲番号で束ねる
const SONG_WORDS = /^(SONG|KIT|MELODY|THEME|BPM|BPMS?|FULL)$/i;

function roleAndSong(file, packPrefixes) {
  const stem = path.basename(file).replace(/\.[^.]+$/, "");
  const meta = parseSampleName(stem);
  const tokens = stem.split(/[_\s\-]+/).filter(Boolean);
  let song = null;
  const rest = [];
  const isKeyTok = (t) => /^[A-G](#|b)?(m|min|maj)?$/.test(t);
  const isBpmTok = (t) => (/^\d{2,3}$/.test(t) && Number(t) === meta.bpm) || /^BPM\d+$|^\d+BPM$|^(BPM|BPMS)$/i.test(t);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (packPrefixes.has(t.toUpperCase())) continue;
    if (isBpmTok(t)) continue;
    if (isKeyTok(t) && t === meta.key) continue;
    // "110_Bpm_G#" / "G#_110_Bpm" のように BPM の隣にある 1 文字の A〜G もキー
    if (isKeyTok(t) && ((tokens[i - 1] && isBpmTok(tokens[i - 1])) || (tokens[i + 1] && isBpmTok(tokens[i + 1])))) continue;
    if (song == null && /^\d{2}$/.test(t)) { song = Number(t); continue; }
    if (/^(SONG|KIT|MELODY|THEME)$/i.test(t)) continue;
    rest.push(t);
  }
  // "Full_Mix" は役割として残す。何も残らなければ MAIN
  const role = rest.join(" ").toUpperCase().replace(/\s+/g, " ").trim() || "MAIN";
  return { song, role, meta: { ...meta, stem } };
}

function collectSongs(packDir) {
  const entries = fs.readdirSync(packDir, { withFileTypes: true }).filter((e) => !e.name.startsWith(".") && !/PROMO|DISCOUNT/i.test(e.name));
  const allFiles = [];
  const walk = (d, songDir) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, songDir);
      else if (AUDIO.test(e.name) || /\.mid$/i.test(e.name)) allFiles.push({ path: p, songDir, isMidi: /\.mid$/i.test(e.name) });
    }
  };
  // ベンダー接頭辞（SEP5 など）はファイル名の先頭トークンの最頻値から
  const prefixes = new Set();
  // 曲フォルダは "Song_02" / "Kit_19" のように語の後ろに 2 桁が付くもの。"SEPT2_WAV_24" の 24 はビット深度なので曲番号にしない
  const songDirNumber = (name) => { const m = /(?:SONG|KIT|THEME|MELODY|TRACK)[_\s-]*(\d{2})/i.exec(name); return m ? Number(m[1]) : null; };
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) if (e.isDirectory()) walk(path.join(packDir, e.name), songDirNumber(e.name) != null ? e.name : null);
  const firstTokens = new Map();
  for (const f of allFiles) { const t = path.basename(f.path).split(/[_\s\-]+/)[0].toUpperCase(); firstTokens.set(t, (firstTokens.get(t) || 0) + 1); }
  for (const [t, n] of firstTokens) if (n >= allFiles.length * 0.3) prefixes.add(t);

  const songs = new Map(); // key → { number, name, parts: Map(role → { wav, mid }) }
  for (const f of allFiles) {
    const { song, role, meta } = roleAndSong(f.path, prefixes);
    const num = f.songDir ? songDirNumber(f.songDir) : song;
    if (num == null) continue;
    if (!songs.has(num)) songs.set(num, { number: num, parts: new Map() });
    const parts = songs.get(num).parts;
    if (!parts.has(role)) parts.set(role, {});
    const info = f.isMidi ? null : audioInfo(f.path);
    if (f.isMidi) parts.get(role).mid = { path: f.path, meta };
    else if (info) parts.get(role).wav = { path: f.path, meta: { ...meta, bpm: meta.bpm ?? (info.acidTempo ? Math.round(info.acidTempo) : null) }, info };
  }
  const ordered = [...songs.values()].sort((a, b) => a.number - b.number);
  return { songs: ordered, roles: orderRoles(ordered) };
}

// パート列の並び:
//   1. Full Mix / Main Mix を先頭（まず聴くのはミックス）
//   2. WAV のあるパートを初出順
//   3. MIDI しか無いパート（Vol.3 の "PIANO 1/2/3" など）は、名前の頭が一致する WAV パートの直後に
//      （"PIANO 1" は "PIANO" の後ろ）。相手が無ければ末尾
function orderRoles(songs) {
  const seen = [];
  const hasWav = new Set(), hasMid = new Set();
  for (const sg of songs) for (const [r, p] of sg.parts) {
    if (!seen.includes(r)) seen.push(r);
    if (p.wav) hasWav.add(r);
    if (p.mid) hasMid.add(r);
  }
  const isMix = (r) => /MIX$/.test(r);
  const wavRoles = seen.filter((r) => hasWav.has(r)).sort((a, b) => Number(isMix(b)) - Number(isMix(a)));
  const midOnly = seen.filter((r) => !hasWav.has(r));
  const out = [...wavRoles];
  const tail = [];
  for (const m of midOnly) {
    const parent = wavRoles.filter((w) => m.startsWith(w + " ") || m === w).sort((a, b) => b.length - a.length)[0];
    if (!parent) { tail.push(m); continue; }
    // 同じ親に付く MIDI パートは名前順で親の直後に並べる
    let at = out.indexOf(parent) + 1;
    while (at < out.length && out[at].startsWith(parent + " ") && out[at] < m) at++;
    out.splice(at, 0, m);
  }
  return [...out, ...tail];
}

function generateSongs({ packDir, output, name, baseSet, groups }) {
  const alsDir = path.dirname(path.resolve(output));
  const { songs, roles } = collectSongs(packDir);
  if (!songs.length) throw new Error("曲が見つかりません");
  const bpm = centralBpm(songs.flatMap((sg) => [...sg.parts.values()].filter((p) => p.wav).map((p) => p.wav.meta)));
  const scenes = Math.max(8, songs.length);
  // シーン＝曲。曲名とテンポをシーンに持たせる（起動するとセットのテンポが切り替わる）
  const sceneList = Array.from({ length: scenes }, (_, i) => {
    const sg = songs[i]; if (!sg) return null;
    const anyWav = [...sg.parts.values()].find((p) => p.wav);
    const m = anyWav ? anyWav.wav.meta : null;
    return { name: `${String(sg.number).padStart(2, "0")}${m && m.key ? " " + m.key : ""}${m && m.bpm ? " " + m.bpm : ""}`, tempo: m && m.bpm ? m.bpm : null };
  });

  let xml = /\.als$/i.test(baseSet) ? als.readAls(baseSet) : fs.readFileSync(baseSet, "utf8");
  for (const t of als.listTracks(xml).filter((t) => t.tag !== "ReturnTrack").reverse()) xml = xml.slice(0, t.start) + xml.slice(t.end + 1);
  xml = xml.replace("__SCENES__", scenesBlock(sceneList));
  xml = als.setTempo(xml, bpm);

  const basePointee = als.nextPointeeId(xml);
  const pid = makePidAllocator(basePointee);
  let trackId = Math.max(...als.listTracks(xml).map((t) => t.id), 10) + 1;
  const blocks = [], ids = [];
  let color = 0;
  const summary = [];

  for (const role of roles) {
    const wavs = songs.map((sg) => sg.parts.get(role)?.wav || null);
    const mids = songs.map((sg) => sg.parts.get(role)?.mid || null);
    const c = color++ % 60;
    if (wavs.some(Boolean)) {
      ids.push(trackId);
      blocks.push(audioTrack({ id: trackId++, name: role, color: c, files: wavs, scenes, alsDir, bpm, pid }));
      summary.push({ track: role, clips: wavs.filter(Boolean).length });
    }
    if (mids.some(Boolean)) {
      ids.push(trackId);
      blocks.push(midiTrack({ id: trackId++, name: `${role} MIDI`, color: c, files: mids, scenes, pid }));
      summary.push({ track: `${role} MIDI`, clips: mids.filter(Boolean).length });
    }
  }
  const firstReturn = als.listTracks(xml).find((t) => t.tag === "ReturnTrack");
  xml = xml.slice(0, firstReturn.start) + blocks.join("\n") + "\n" + xml.slice(firstReturn.start);
  xml = xml.replace(/<NextPointeeId Value="\d+" \/>/, `<NextPointeeId Value="${pid.next}" />`);
  if (groups && ids.length) xml = als.groupTracks(xml, { name: "SONGS", trackIds: ids }).xml;
  if (/__[A-Z_]+\d*__/.test(xml)) throw new Error("置換し残し: " + /__[A-Z_]+\d*__/.exec(xml)[0]);

  fs.mkdirSync(alsDir, { recursive: true });
  fs.mkdirSync(path.join(alsDir, "Ableton Project Info"), { recursive: true });
  als.writeAls(output, xml);
  return { output, bpm, scenes, layout: "songs", songs: songs.length, loops: summary, oneshots: [], pointeeIds: pid.next - basePointee };
}

// scenes: 個数、または [{ name, tempo }] の並び（曲キット型はシーン＝曲で、シーンにテンポを持たせる）
function scenesBlock(n) {
  const t = tpl("scene.xml");
  const out = [];
  const list = Array.isArray(n) ? n : Array.from({ length: n }, () => null);
  list.forEach((sc, i) => {
    let x = t.replace(/__INDEX__/g, String(i));
    if (sc) {
      x = x.replace(/<Name Value="[^"]*" \/>/, `<Name Value="${escapeAttr(sc.name || "")}" />`);
      if (sc.tempo) x = x.replace(/<Tempo Value="[^"]*" \/>/, `<Tempo Value="${sc.tempo}" />`).replace(/<IsTempoEnabled Value="false" \/>/, '<IsTempoEnabled Value="true" />');
    }
    out.push(x);
  });
  return out.join("\n");
}

// ---- セットの組み立て ----

function generate({ packDir, output, loops = [], oneshots = [], name, baseSet = DEFAULT_SET, groups = true, layout = "folders", fileKinds = {}, classify = true }) {
  if (layout === "songs") return generateSongs({ packDir, output, name, baseSet, groups });
  const alsDir = path.dirname(path.resolve(output));
  // フォルダ分類を事前情報に、ファイルごとにループ / ワンショットを決め直す。
  // ループのフォルダに入っていた単発は "OS <フォルダ>" の Drum Rack へ、逆はオーディオトラックへ
  // ループ側とワンショット側の両方に載っているフォルダ名の全体（親の下りで、別種別として載っている子を二重に拾わない）
  const nameOf = (x) => (typeof x === "string" ? x : x.name);
  const listedFolders = [...loops.map(nameOf), ...oneshots.map(nameOf)];
  const collected = [
    ...collect(packDir, loops, { prior: "loop", fileKinds, classify, listedFolders }),
    ...collect(packDir, oneshots, { prior: "oneshot", fileKinds, classify, listedFolders }),
  ];
  const loopGroups = collected.filter((g) => g.files.length).map((g) => ({ name: g.name, files: g.files }));
  const shotGroups = collected.filter((g) => g.shots.length).map((g) => ({ name: g.name, files: g.shots }));
  if (!loopGroups.length && !shotGroups.length) throw new Error("生成する素材がありません");
  const review = collected.flatMap((g) => g.review);

  const allLoops = loopGroups.flatMap((g) => g.files);
  const bpm = centralBpm(allLoops.map((f) => f.meta));
  const scenes = Math.max(8, ...loopGroups.map((g) => g.files.length));

  let xml = /\.als$/i.test(baseSet) ? als.readAls(baseSet) : fs.readFileSync(baseSet, "utf8");

  // 既定の 4 トラック（MIDI 2 + Audio 2）を外す。リターンは残す
  for (const t of als.listTracks(xml).filter((t) => t.tag !== "ReturnTrack").reverse()) {
    xml = xml.slice(0, t.start) + xml.slice(t.end + 1); // 末尾の改行ごと
  }
  // シーン
  xml = xml.replace("__SCENES__", scenesBlock(scenes));
  xml = xml.replace(/(\n\t\t<Scenes>)[\s\S]*?(\n\t\t<\/Scenes>)/, `$1\n${scenesBlock(scenes)}$2`);
  // テンポ
  xml = als.setTempo(xml, bpm);

  const basePointee = als.nextPointeeId(xml);
  const pid = makePidAllocator(basePointee);
  let trackId = Math.max(...als.listTracks(xml).map((t) => t.id), 10) + 1;
  const blocks = [];
  const loopIds = [], shotIds = [];
  let color = 0;

  for (const g of loopGroups) {
    const trackName = g.name;
    loopIds.push(trackId);
    blocks.push(audioTrack({ id: trackId++, name: trackName, color: color++ % 60, files: g.files, scenes, alsDir, bpm, pid }));
  }
  for (const g of shotGroups) {
    // 1 ラックに入るのは C0〜G8 の 104 音。超えたら分ける
    for (let part = 0; part * MAX_PADS < g.files.length; part++) {
      const files = g.files.slice(part * MAX_PADS, (part + 1) * MAX_PADS);
      const trackName = "OS " + g.name + (part ? ` ${part + 1}` : "");
      shotIds.push(trackId);
      blocks.push(drumRackTrack({ id: trackId++, name: trackName, color: color++ % 60, files, scenes, alsDir, pid }));
    }
  }

  // リターントラックの前に差し込む
  const firstReturn = als.listTracks(xml).find((t) => t.tag === "ReturnTrack");
  xml = xml.slice(0, firstReturn.start) + blocks.join("\n") + "\n" + xml.slice(firstReturn.start);
  xml = xml.replace(/<NextPointeeId Value="\d+" \/>/, `<NextPointeeId Value="${pid.next}" />`);

  // グループ化（検証済みの generator）
  if (groups && loopIds.length) xml = als.groupTracks(xml, { name: "LOOPS", trackIds: loopIds }).xml;
  if (groups && shotIds.length) xml = als.groupTracks(xml, { name: "ONE SHOTS", trackIds: shotIds }).xml;

  if (/__[A-Z_]+\d*__/.test(xml)) throw new Error("置換し残し: " + /__[A-Z_]+\d*__/.exec(xml)[0]);

  fs.mkdirSync(alsDir, { recursive: true });
  fs.mkdirSync(path.join(alsDir, "Ableton Project Info"), { recursive: true });
  als.writeAls(output, xml);

  return {
    output, bpm, scenes,
    loops: loopGroups.map((g) => ({ track: g.name, clips: g.files.length })),
    oneshots: shotGroups.map((g) => ({ track: "OS " + g.name, pads: g.files.length })),
    review, // フォルダ分類と逆になった / 自信が無いファイル（人が見直す候補）
    pointeeIds: pid.next - basePointee,
  };
}

module.exports = { generate, collect, collectSongs, roleAndSong, orderRoles, trackNameOf, audioClipSlot, drumBranch, midiClipSlot };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (k) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : null);
  // 値を取らないフラグ（--no-groups）の直後は位置引数として扱う
  const BOOL_FLAGS = new Set(["--no-groups"]);
  const isValueOf = (i) => i > 0 && argv[i - 1].startsWith("--") && !BOOL_FLAGS.has(argv[i - 1]);
  const [packDir, output] = argv.filter((a, i) => !a.startsWith("--") && !isValueOf(i));
  if (!packDir || !output) {
    console.error("使い方: node scripts/als-generate.js <パック> <出力.als> [--loops a,b] [--oneshots c,d]");
    process.exit(2);
  }
  const r = generate({
    packDir, output,
    loops: (opt("--loops") || "").split(",").filter(Boolean),
    oneshots: (opt("--oneshots") || "").split(",").filter(Boolean),
    groups: !argv.includes("--no-groups"),
    layout: opt("--layout") || "folders",
  });
  console.log(`${r.output}\n  テンポ ${r.bpm} / シーン ${r.scenes} / 確保した id ${r.pointeeIds}`);
  for (const l of r.loops) console.log(`  ${l.track.padEnd(24)} クリップ ${l.clips}`);
  for (const o of r.oneshots) console.log(`  ${o.track.padEnd(24)} パッド ${o.pads}`);
}
