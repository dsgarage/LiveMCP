// MCP ツール定義。McpServer インスタンスに登録する。
// ステートレス HTTP 運用のためリクエストごとに登録されても副作用がないよう、
// 状態は bridge / config 側に持たせる。
"use strict";

const { z } = require("zod");
const { searchSamples } = require("./sample-search");
const { createSetTools } = require("./set-tools");

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {import("./bridge").LiveBridge} bridge
 * @param {{ sampleFolders: string[] }} config
 */
function registerTools(server, bridge, config, diagnostics) {
  const ok = (result) => ({
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  });

  if (diagnostics) {
    server.registerTool(
      "live.debug.state",
      {
        description:
          "ブリッジの疎通状況を返す。node.script のインレットに届いたメッセージ履歴が見えるので、v8 が応答しないときの切り分けに使う",
        inputSchema: {},
      },
      async () =>
        ok({
          running_in_max: diagnostics.hasMaxApi(),
          pending_bridge_calls: diagnostics.pendingCount(),
          sample_folders: config.sampleFolders,
          inlet_log: diagnostics.inletLog(),
        })
    );
  }

  server.registerTool(
    "live.status",
    {
      description: "LiveMCP デバイスと Live 本体の接続状態を確認する",
      inputSchema: {},
    },
    async () => ok(await bridge.call("ping"))
  );

  server.registerTool(
    "live.api.info",
    {
      description:
        "LiveAPI パスの型・対応プロパティ・関数一覧を実機の Live から取得する。未対応の LOM を調べるときに使う（例: live_set tracks 0）",
      inputSchema: {
        path: z.string().describe("LiveAPI パス（例: live_app / live_set / live_set tracks 0 clip_slots 0）"),
      },
    },
    async (args) => ok(await bridge.call("info", args))
  );

  server.registerTool(
    "live.api.raw",
    {
      description:
        "任意の LiveAPI 呼び出しを実行する。ツール化されていない LOM を試すための低レベル手段",
      inputSchema: {
        path: z.string().describe("LiveAPI パス"),
        method: z.enum(["get", "getcount", "set", "call"]).describe("呼び出し種別"),
        property: z.string().describe("プロパティ名または関数名"),
        args: z.array(z.union([z.string(), z.number()])).optional().describe("set / call に渡す引数"),
      },
    },
    async (args) => ok(await bridge.call("raw", args))
  );

  server.registerTool(
    "live.set.read",
    {
      description:
        "Live セットの概要（テンポ・トラック・クリップ・デバイス構成）を読み取る。操作前の現状把握に使う",
      inputSchema: {
        includeClips: z.boolean().optional().describe("クリップスロットの詳細も含める（既定 true）"),
      },
    },
    async ({ includeClips }) => ok(await bridge.call("read_set", { includeClips: includeClips !== false }))
  );

  server.registerTool(
    "live.samples.search",
    {
      description:
        "登録済みサンプルフォルダからオーディオファイルを検索し絶対パスを返す。結果は live.clip.create_audio / live.device.replace_sample にそのまま渡せる",
      inputSchema: {
        query: z.string().optional().describe("検索語（空白区切り AND、省略時は全件）"),
        folder: z.string().optional().describe("検索対象フォルダの絶対パス（省略時は設定済みフォルダ）"),
        limit: z.number().int().min(1).max(100).optional().describe("最大件数（既定 25）"),
      },
    },
    async ({ query, folder, limit }) => {
      const folders = folder ? [folder] : config.sampleFolders;
      if (folders.length === 0) {
        throw new Error(
          "サンプルフォルダが未設定です。folder 引数で指定するか、デバイスに folders メッセージで設定してください"
        );
      }
      return ok({ folders, files: searchSamples(folders, query || "", limit || 25) });
    }
  );

  server.registerTool(
    "live.clip.create_audio",
    {
      description:
        "オーディオファイル（ループ等）をセッションビューのクリップスロットに配置する。対象はオーディオトラックのみ",
      inputSchema: {
        trackIndex: z.number().int().min(0).describe("トラック番号（0 始まり）"),
        sceneIndex: z.number().int().min(0).describe("シーン（クリップスロット）番号（0 始まり）"),
        filePath: z.string().describe("オーディオファイルの絶対パス"),
      },
    },
    async (args) => ok(await bridge.call("create_audio_clip", args))
  );

  // ブリッジ 1 往復あたりの処理件数。1 回の呼び出しが長引くと
  // bridge.js のタイムアウト（既定 15 秒）に掛かるため、分割して投げる。
  //
  // クリップ生成は 1 件あたり 20ms 程度だが、Drum Rack のパッドは
  // チェーン生成 → Simpler 挿入 → サンプル読込 と重く、サンプルを多く抱えた
  // セットでは 1 件 1 秒近くまで落ちる（実機で 300 パッド構築時に確認）。
  // そのため件数の上限を分けている。
  const CLIP_CHUNK = 16;
  const PAD_CHUNK = 6;
  const chunks = (items, size) => {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  };

  server.registerTool(
    "live.clip.create_audio_batch",
    {
      description:
        "複数のオーディオファイルを 1 トラックの連続するシーンへまとめてクリップとして配置する",
      inputSchema: {
        trackIndex: z.number().int().min(0).describe("トラック番号（0 始まり）"),
        startSceneIndex: z.number().int().min(0).describe("先頭のシーン番号（0 始まり）"),
        filePaths: z.array(z.string()).min(1).describe("オーディオファイルの絶対パス（この順に上から並ぶ）"),
      },
    },
    async (args) => {
      const clips = [];
      const errors = [];
      let offset = 0;
      for (const part of chunks(args.filePaths, CLIP_CHUNK)) {
        const r = await bridge.call("create_audio_clips", {
          trackIndex: args.trackIndex,
          startSceneIndex: args.startSceneIndex + offset,
          filePaths: part,
        });
        clips.push(...r.clips);
        errors.push(...r.errors);
        offset += part.length;
      }
      return ok({ created: clips.length, failed: errors.length, clips, errors });
    }
  );

  server.registerTool(
    "live.drumrack.build",
    {
      description:
        "MIDI トラックに Drum Rack を用意し、ワンショット群を startNote から半音ずつパッドへ割り当てる",
      inputSchema: {
        trackIndex: z.number().int().min(0).describe("MIDI トラック番号（0 始まり）"),
        filePaths: z.array(z.string()).min(1).describe("オーディオファイルの絶対パス（この順に音程が上がる）"),
        startNote: z
          .number()
          .int()
          .min(0)
          .max(127)
          .default(24)
          .describe("先頭パッドの MIDI ノート番号（既定 24 = Ableton 表記の C0）"),
        names: z.array(z.string()).optional().describe("各パッドの名前。省略時はファイル名から付ける"),
      },
    },
    async (args) => {
      const last = args.startNote + args.filePaths.length - 1;
      if (last > 127) {
        throw new Error(
          `パッドが足りません。${args.filePaths.length} 個を ${args.startNote} から並べると ${last} になり 127 を超えます`
        );
      }

      const samples = args.filePaths.map((filePath, i) => ({
        filePath,
        note: args.startNote + i,
        name: args.names ? args.names[i] : filePath.split("/").pop().replace(/\.[^.]+$/, ""),
      }));

      const pads = [];
      const errors = [];
      let deviceIndex = null;
      for (const part of chunks(samples, PAD_CHUNK)) {
        const r = await bridge.call("build_drum_rack", { trackIndex: args.trackIndex, samples: part });
        deviceIndex = r.device_index;
        pads.push(...r.pads);
        errors.push(...r.errors);
      }
      return ok({ device_index: deviceIndex, added: pads.length, failed: errors.length, pads, errors });
    }
  );

  // ---- .als ファイル系（動いているセットではなく、ファイルを書き換える） ----

  const setTools = createSetTools();

  server.registerTool(
    "live.set.group_tracks",
    {
      description:
        "セット(.als)の中で連続したトラックを Group トラックにまとめる。" +
        "LOM に無い操作のためファイル側で行う。対象セットが Live で開いたままの場合は" +
        "書かずに状況と選択肢を返すので、進め方はユーザーと確認すること",
      inputSchema: {
        groupName: z.string().describe("グループ名（例: ONE SHOTS）"),
        tracks: z
          .array(z.string())
          .min(1)
          .describe("対象トラック。名前の前方一致（例 \"OS \"）またはトラック Id の数字"),
        setPath: z
          .string()
          .optional()
          .describe(".als の絶対パス。省略時は Live が最後に開いたセット"),
        output: z
          .string()
          .optional()
          .describe("出力先の絶対パス。省略時は同じファイルを置き換える（直前の状態は Backup/ へ退避）"),
        open: z.boolean().default(false).describe("書き出し後に Live で開く"),
      },
    },
    async (args) => ok(await setTools.groupTracksInSet(args))
  );

  server.registerTool(
    "live.device.insert",
    {
      description:
        "ネイティブデバイス（Simpler / Drum Rack / EQ Eight 等）をトラックに追加する",
      inputSchema: {
        trackIndex: z.number().int().min(0).describe("トラック番号（0 始まり）"),
        deviceName: z.string().describe("デバイス名（例: Simpler, Drum Rack）"),
        position: z.number().int().min(0).optional().describe("挿入位置（省略時は末尾）"),
      },
    },
    async (args) => ok(await bridge.call("insert_device", args))
  );

  server.registerTool(
    "live.device.replace_sample",
    {
      description: "Simpler デバイスにワンショット等のサンプルを読み込む（Live 12.4+）",
      inputSchema: {
        trackIndex: z.number().int().min(0).describe("トラック番号（0 始まり）"),
        deviceIndex: z.number().int().min(0).describe("トラック内デバイス番号（0 始まり）"),
        filePath: z.string().describe("オーディオファイルの絶対パス"),
      },
    },
    async (args) => ok(await bridge.call("replace_sample", args))
  );

  server.registerTool(
    "live.device.params",
    {
      description:
        "デバイス（M4L デバイス含む）の公開パラメータ一覧を値・レンジ付きで取得する",
      inputSchema: {
        trackIndex: z.number().int().min(0).describe("トラック番号（0 始まり）"),
        deviceIndex: z.number().int().min(0).describe("トラック内デバイス番号（0 始まり）"),
      },
    },
    async (args) => ok(await bridge.call("list_device_params", args))
  );

  server.registerTool(
    "live.device.set_param",
    {
      description: "デバイス（M4L デバイス含む）のパラメータ値を設定する",
      inputSchema: {
        trackIndex: z.number().int().min(0).describe("トラック番号（0 始まり）"),
        deviceIndex: z.number().int().min(0).describe("トラック内デバイス番号（0 始まり）"),
        paramIndex: z.number().int().min(0).describe("パラメータ番号（live.device.params で確認）"),
        value: z.number().describe("設定値（パラメータの min/max 範囲内）"),
      },
    },
    async (args) => ok(await bridge.call("set_device_param", args))
  );
}

module.exports = { registerTools };
