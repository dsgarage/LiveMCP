// テスト用の最小 .als フィクスチャ（als.test.js から共有化）。
"use strict";

// Live が書く .als の形（インデントはタブ、トラックは <Tracks> の直下）を最小限で再現する
function fixture() {
  const track = (tag, id, name, group = -1) => `\t\t\t<${tag} Id="${id}">
\t\t\t\t<Name>
\t\t\t\t\t<EffectiveName Value="${name}" />
\t\t\t\t\t<UserName Value="${name}" />
\t\t\t\t</Name>
\t\t\t\t<TrackGroupId Value="${group}" />
\t\t\t\t<AudioOutputRouting>
\t\t\t\t\t<Target Value="AudioOut/Main" />
\t\t\t\t\t<UpperDisplayString Value="Main" />
\t\t\t\t</AudioOutputRouting>
\t\t\t</${tag}>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="5" MinorVersion="12.0_12402" Creator="Ableton Live 12.4.5">
\t<LiveSet>
\t\t<NextPointeeId Value="5000" />
\t\t<Tracks>
${track("AudioTrack", 16, "LOOPS")}
${track("GroupTrack", 30, "ONE SHOTS")}
${track("MidiTrack", 23, "OS 808S", 30)}
${track("MidiTrack", 25, "OS BASSES")}
${track("ReturnTrack", 2, "A-Reverb")}
\t\t</Tracks>
\t\t<Scenes>
\t\t\t<Scene Id="0" />
\t\t\t<Scene Id="1" />
\t\t</Scenes>
\t</LiveSet>
</Ableton>`;
}

// グループ化の対象にできる、まだどこにも属していないトラックだけの構成
function ungrouped() {
  return fixture()
    .replace(/\n\t\t\t<GroupTrack[\s\S]*?<\/GroupTrack>/, "")
    .replace('<TrackGroupId Value="30" />', '<TrackGroupId Value="-1" />');
}

module.exports = { fixture, ungrouped };
