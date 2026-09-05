#!/usr/bin/env node
// LiveMCP を載せたテンプレートセット（LiveMCP.als）を作る。
//
//   node scripts/template-set.js <出力.als>
//
// 土台は templates/live-set.xml（Live 12.4.5 が書いた実物。既定の MIDI 2 + Audio 2 トラック入り）。
// そこへ「LiveMCP」という名前のオーディオトラックを 1 本足し、デバイスチェーンに LiveMCP（Max Audio Effect）を置く。
// デバイスの XML は Live が保存した実物から起こした templates/device-livemcp.xml。
// .amxd の参照は User Library の Presets からの相対パスで、install.sh の配置先と一致させる。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const als = require("./als");

const TEMPLATE_DIR = path.join(__dirname, "..", "templates");
const tpl = (n) => fs.readFileSync(path.join(TEMPLATE_DIR, n), "utf8");
const SCENES = 8;
const TEMPO = 120;

function buildTemplateSet(output) {
  const devicePath = path.join(TEMPLATE_DIR, "device-livemcp.xml");
  if (!fs.existsSync(devicePath)) throw new Error("templates/device-livemcp.xml がありません（Live が保存した LiveMCP 入りのセットから起こす）");

  let xml = tpl("live-set.xml");
  const scenes = Array.from({ length: SCENES }, (_, i) => tpl("scene.xml").replace(/__INDEX__/g, String(i)).replace(/__NAME__/g, "")).join("\n");
  xml = xml.replace("__SCENES__", scenes);
  xml = als.setTempo(xml, TEMPO);

  // ポインタ id は NextPointeeId から連番
  let next = als.nextPointeeId(xml);
  const pid = (block) => block.replace(/__PID(\d+)__/g, (m, n) => String(next + Number(n)));
  const count = (block) => new Set([...block.matchAll(/__PID(\d+)__/g)].map((m) => m[1])).size;

  let trackId = Math.max(...als.listTracks(xml).map((t) => t.id), 10) + 1;
  const empty = (i) => tpl("clip-slot-empty.xml").replace(/__INDEX__/g, String(i));
  const slots = Array.from({ length: SCENES }, (_, i) => empty(i)).join("\n");
  const fill = (file, name, color) => tpl(file)
    .replace(/__ID__/g, String(trackId++))
    .replace(/__NAME__/g, name)
    .replace(/__COLOR__/g, String(color))
    .replace("__SLOTS__", slots)
    .replace("__FREEZE_SLOTS__", slots);
  const take = (block) => { const n = count(block); const out = pid(block); next += n; return out; };

  // Live の既定セットと同じ MIDI 2 本 + Audio 2 本、その後ろに LiveMCP のトラック
  const blocks = [
    take(fill("midi-track.xml", "1-MIDI", 0)),
    take(fill("midi-track.xml", "2-MIDI", 0)),
    take(fill("audio-track.xml", "3-Audio", 0)),
    take(fill("audio-track.xml", "4-Audio", 0)),
  ];
  let track = fill("audio-track.xml", "LiveMCP", 13);
  if (!/<Devices \/>/.test(track)) throw new Error("audio-track.xml に <Devices /> が見つかりません");
  track = take(track);
  // デバイスチェーンの <Devices /> に LiveMCP を差し込む（実物では最後の DeviceChain 直下）
  const dev = take(tpl("device-livemcp.xml"));
  track = track.replace("<Devices />", `<Devices>\n${dev}\n\t\t\t\t\t\t</Devices>`);
  blocks.push(track);

  const firstReturn = als.listTracks(xml).find((t) => t.tag === "ReturnTrack");
  xml = xml.slice(0, firstReturn.start) + blocks.join("\n") + "\n" + xml.slice(firstReturn.start);
  xml = xml.replace(/<NextPointeeId Value="\d+" \/>/, `<NextPointeeId Value="${next}" />`);
  if (/__[A-Z_]+\d*__/.test(xml)) throw new Error("置換し残し: " + /__[A-Z_]+\d*__/.exec(xml)[0]);

  fs.mkdirSync(path.dirname(output), { recursive: true });
  als.writeAls(output, xml);
  return { output, tracks: blocks.length, nextPointeeId: next };
}

module.exports = { buildTemplateSet };

if (require.main === module) {
  const out = process.argv[2];
  if (!out) { console.error("使い方: node scripts/template-set.js <出力.als>"); process.exit(2); }
  console.log(buildTemplateSet(out));
}
