#!/usr/bin/env node
// パック名 → セット（.als）名。
//
//   Singomakers_Emotional_Piano_Themes_Vol_6_(Full_Zip)  →  EmotionalPianoThemesVol06
//   Freaky Loops - FL224 - Metalstep Vol. 2              →  MetalstepVol02
//   FL205_Hard Drops                                     →  HardDrops
//   CHILL_HOUSE_&_GARAGE                                 →  ChillHouse&Garage
//
// 規則（ユーザー指定の形に合わせた）:
//   - レーベル名（Loopcloud の Labels タグ。Singomakers / Freaky Loops / Blind Audio …）が先頭にあれば外す
//   - カタログ番号（FL205 / BLX15 / RC01 のような英字 + 数字）を外す
//   - "(Full_Zip)" "(ZIP_Main)" と、末尾の MAIN / WAV / Full を外す
//   - 語ごとに先頭だけ大文字にして詰める。3 文字以下の全大文字（EDM / FX / DNB / II）はそのまま
//   - Vol / Theme / Part などの後ろの 1〜2 桁と、末尾の 1〜2 桁は 2 桁にそろえる（Vol_6 → Vol06）
"use strict";

// 大文字のまま残す略語。それ以外の全大文字（HIP / DUB / NU / VOX …）は先頭だけ大文字にする
const KEEP_CAPS = /^(EDM|IDM|FX|SFX|DNB|D&B|R&B|EP|LP|II|III|IV|DJ|LA|UK|US|USA|TV|VIP|EQ|LFO|AI|UFO|MIDI|VST|RnB)$/;
const NUM_WORDS = /^(VOL|VOLUME|THEME|THEMES|PART|PT|EP|CHAPTER|SESSION|SESSIONS|EDITION|NO)$/i;
const DROP_TAIL = /^(MAIN|WAV|FULL|ZIP|LPS|16BIT|24BIT)$/i;
const BIT_DEPTH = /^(16|24)$/;                              // "WAV 24" のようにビット深度の語の後ろにあるときだけ落とす（"Vol 24" は残す）
const CATALOG = /^[A-Z]{1,4}\d{2,3}$/;                   // FL205 / BLX15 / RC01 / FA149 / PW82 / BL18 / V13
const isCatalog = (t) => CATALOG.test(t) && !NUM_WORDS.test(t.replace(/\d+$/, "")); // EP01 / VOL02 は番号付きの語なので残す
// 配給元の名前は、パック名の先頭に付く略号（APS / TTS / VR …）の照合には使わない
const DISTRIBUTOR = /^(Loopmasters|Loopcloud)$/i;

function splitWords(name) {
  return name
    .replace(/\([^)]*\)/g, " ")                          // (Full_Zip)
    .replace(/'/g, "")
    .split(/[\s_\-.,/]+/)
    .filter(Boolean)
    .filter((t) => !isCatalog(t))                        // カタログ番号は分割前に落とす
    .flatMap((t) => {
      // "Vol1" / "Bass2" / "Vol.2" → 語 + 数字。"Loopcloud2020" は 4 桁なので分ける（詰め直すだけ）
      const m = /^([A-Za-z&]+)(\d+)$/.exec(t);
      return m ? [m[1], m[2]] : [t];
    });
}

function caseWord(t) {
  if (/^\d+$/.test(t)) return t;
  if (KEEP_CAPS.test(t.toUpperCase())) return KEEP_CAPS.test(t) ? t : t.toUpperCase(); // edm → EDM、RnB はそのまま
  if (/^[A-Z&]+$/.test(t)) return t[0] + t.slice(1).toLowerCase();  // AMBIENT → Ambient
  if (/^[a-z&]+$/.test(t)) return t[0].toUpperCase() + t.slice(1);  // deep → Deep
  // "ROCKDrum" のように大文字の語に語がくっついたもの → RockDrum。GloomyAmbient / RnB はそのまま
  return (t[0].toUpperCase() + t.slice(1)).replace(/^([A-Z])([A-Z]{2,})(?=[A-Z][a-z])/, (m, a, b) => a + b.toLowerCase());
}

// "APS" が "APOLLO SOUND" の、"TTS" が "Tsunami Track Sounds" の略号か（文字が順に現れるか）
function isAbbreviationOf(token, label) {
  if (!/^[A-Z]{2,4}$/.test(token)) return false;
  const L = label.toUpperCase().replace(/[^A-Z]/g, "");
  let pos = 0;
  for (const ch of token) { pos = L.indexOf(ch, pos); if (pos < 0) return false; pos++; }
  return true;
}

// label: Loopcloud の Labels タグ（無ければ null）。パック名の先頭がレーベル名かその略号なら外す
function setNameOf(packName, { label = null } = {}) {
  let words = splitWords(packName);
  if (label) {
    const lw = splitWords(label).map((w) => w.toLowerCase());
    if (lw.length && words.slice(0, lw.length).map((w) => w.toLowerCase()).join(" ") === lw.join(" ")) words = words.slice(lw.length);
    else if (!DISTRIBUTOR.test(label) && words.length > 1 && isAbbreviationOf(words[0], label)) words = words.slice(1);
  }
  while (words.length > 1) {
    const last = words[words.length - 1];
    if (DROP_TAIL.test(last)) { words.pop(); continue; }
    if (BIT_DEPTH.test(last) && words.length > 2 && /^(WAV|BIT)$/i.test(words[words.length - 2])) { words.splice(-2); continue; }
    break;
  }

  const out = [];
  for (let i = 0; i < words.length; i++) {
    let w = words[i];
    if (/^\d{1,2}$/.test(w) && (i === words.length - 1 || NUM_WORDS.test(words[i - 1] || ""))) w = w.padStart(2, "0");
    out.push(caseWord(w));
  }
  return out.join("") || packName;
}

module.exports = { setNameOf };

if (require.main === module) for (const n of process.argv.slice(2)) console.log(`${n}  →  ${setNameOf(n)}`);
