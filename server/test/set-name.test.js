// scripts/set-name.js — パック名からセット名を作る
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { setNameOf } = require("../../scripts/set-name");

test("ユーザー指定の形: レーベルとカタログ番号と (Full_Zip) を外し、語を詰め、番号は 2 桁", () => {
  const cases = [
    ["Singomakers_Emotional_Piano_Themes_Vol_6_(Full_Zip)", "Singomakers", "EmotionalPianoThemesVol06"],
    ["Singomakers_Emotional_Piano_Themes_Vol_9_(ZIP_Main)", "Singomakers", "EmotionalPianoThemesVol09"],
    ["Singomakers_Emotional_Piano_Theme_3", "Singomakers", "EmotionalPianoTheme03"],
    ["Singomakers_Emotional_Piano", "Singomakers", "EmotionalPiano"],
    ["Singomakers_EDM_2020_(Full_Zip)", "Singomakers", "EDM2020"],
    ["Freaky Loops - FL224 - Metalstep Vol. 2", "Freaky Loops", "MetalstepVol02"],
    ["FL205_Hard Drops", "Freaky Loops", "HardDrops"],
    ["FL164_GloomyAmbientVol2", "Freaky Loops", "GloomyAmbientVol02"],
    ["Blind Audio - BLX15 - Country Retreat - Ambient & Foley", "Blind Audio", "CountryRetreatAmbient&Foley"],
    ["Tsunami Track Sounds - The Game Shop - Rock Drum N Bass Vol. 3", "Tsunami Track Sounds", "TheGameShopRockDrumNBassVol03"],
    ["CHILL_HOUSE_&_GARAGE", "Sample Magic", "ChillHouse&Garage"],
    ["D&B_SHADOWS", null, "D&BShadows"],
    ["MAXIMUM_EDM", null, "MaximumEDM"],
    ["APS_Jazzadelic_Hip_Hop_Beats_MAIN", "APOLLO SOUND", "JazzadelicHipHopBeats"],   // APS はレーベルの略号
    ["APS_Jazzadelic_Hip_Hop_Beats_MAIN", null, "ApsJazzadelicHipHopBeats"],
    ["THE_BLUES_SESSIONS_2_WAV", "Loopmasters", "TheBluesSessions02"],
    ["KV_BALA_Indian_Sessions_Vol1", "Loopmasters", "KvBalaIndianSessionsVol01"],
    ["LA_TRAP", "Loopmasters", "LATrap"],                                             // 配給元の名前は略号照合に使わない
    ["ABSTRACT_FUTURE_HIP_HOP", "Loopmasters", "AbstractFutureHipHop"],
    ["Welcome_To_Loopcloud2020", "Loopmasters", "WelcomeToLoopcloud2020"],
    ["LoopcloudDrum_Intro_II_Drums", "Loopmasters", "LoopcloudDrumIntroIIDrums"],
    ["TTS_RockDrum&Bass2", "Tsunami Track Sounds", "RockDrum&Bass02"],
    ["TTS_ROCKDrum&Bass", "Tsunami Track Sounds", "RockDrum&Bass"],
    ["diverge synthesis - serum ultimate edm vol.1", "Diverge Synthesis", "SerumUltimateEDMVol01"],
    ["FL_AMERICAN_ROAD_TRIP", "Frontline Producer", "AmericanRoadTrip"],
    ["DNM_Essential_Minimal-Techno_vol_1", null, "DnmEssentialMinimalTechnoVol01"],
    ["TECH_HOUSE_PERCUSSION_AND_TOP_LPS", null, "TechHousePercussionAndTop"],
    ["deep house essentials - serum", null, "DeepHouseEssentialsSerum"],
  ];
  for (const [pack, label, want] of cases) assert.strictEqual(setNameOf(pack, { label }), want, pack);
});

test("レーベル名は先頭にあるときだけ外す", () => {
  assert.strictEqual(setNameOf("Loopmasters Welcome Free Samplepack", { label: "Loopmasters" }), "WelcomeFreeSamplepack");
  assert.strictEqual(setNameOf("Something Loopmasters", { label: "Loopmasters" }), "SomethingLoopmasters");
});

test("末尾の 24 は WAV / BIT の後ろにあるときだけ落とし、EP01 / Vol 24 のような番号付きの語は残す", () => {
  assert.strictEqual(setNameOf("Trap Vol 24"), "TrapVol24");        // Vol 23 と別名になる
  assert.strictEqual(setNameOf("Deep House 24"), "DeepHouse24");
  assert.strictEqual(setNameOf("Lofi EP01"), "LofiEP01");           // カタログ番号ではない
  assert.strictEqual(setNameOf("Some Pack WAV 24"), "SomePack");     // ビット深度
  assert.strictEqual(setNameOf("Blind Audio - BLX15 - Country Retreat", { label: "Blind Audio" }), "CountryRetreat");
});
