// LiveMCP エントリポイント。Ableton Live 内の M4L デバイス上の node.script で動作する。
//   Claude Code ←(HTTP/MCP)→ このプロセス ←(パッチケーブル JSON)→ v8 (LiveAPI)
// 開発・テスト時は max-api が無い環境でも読み込めるようにしてある。
"use strict";

const http = require("node:http");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { LiveBridge } = require("./bridge");
const { registerTools } = require("./tools");
const { defaultSampleFolders } = require("./sample-search");

const SERVER_NAME = "livemcp";
const SERVER_VERSION = "1.0.0";
const DEFAULT_PORT = 3360;

// ---- Max 連携（max-api は Node for Max 実行時のみ存在する）----
let maxApi = null;
try {
  maxApi = require("max-api");
} catch {
  // 開発・テスト実行時（Max 外）
}

const envFolders = (process.env.LIVEMCP_SAMPLE_DIRS || "").split(":").filter(Boolean);
const config = {
  sampleFolders: envFolders.length > 0 ? envFolders : defaultSampleFolders(),
};

const bridge = new LiveBridge((json) => {
  if (!maxApi) throw new Error("Max 外で実行中のため LiveAPI ブリッジは使えません");
  // node.script のアウトレット → v8 のインレットへ。JSON はシングルシンボルとして送る
  maxApi.outlet("to_v8", json);
});

// node.script のインレットに届いたメッセージの直近履歴。
// v8 ブリッジが無応答のとき、そもそもメッセージが返ってきているのかを切り分けるために使う。
const inletLog = [];
function recordInlet(entry) {
  inletLog.push({ at: new Date().toISOString(), ...entry });
  if (inletLog.length > 50) inletLog.shift();
}

if (maxApi) {
  // 全インレットメッセージを記録する（個別ハンドラとは独立に呼ばれる）
  maxApi.addHandler(maxApi.MESSAGE_TYPES.ALL, (handled, selector, ...args) => {
    recordInlet({ selector: String(selector), handled: !!handled, args: args.map(String) });
  });

  // v8 からのレスポンス（from_v8 <json>）と設定メッセージを受ける
  maxApi.addHandler("from_v8", (json) => {
    bridge.handleResponse(json);
  });
  maxApi.addHandler("folders", (...folders) => {
    config.sampleFolders = folders.map(String);
    maxApi.post(`LiveMCP: サンプルフォルダ設定 ${config.sampleFolders.join(", ")}`);
  });
}

// ---- MCP over HTTP（ステートレス運用: リクエストごとに server + transport を生成）----
const diagnostics = {
  hasMaxApi: () => !!maxApi,
  inletLog: () => inletLog.slice(),
  pendingCount: () => bridge.pendingCount,
};

function buildMcpServer() {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, bridge, config, diagnostics);
  return server;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function createHttpServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end("LiveMCP: /mcp へ接続してください");
      return;
    }
    try {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const server = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err && err.message ? err.message : err) }));
      }
      if (maxApi) maxApi.post(`LiveMCP error: ${err}`);
    }
  });
}

// デバイスを差し替えると、古いデバイスがポートを手放す前に新しい方が起動して
// EADDRINUSE で待機に失敗することがある。その場合は諦めず数回やり直す。
const BIND_RETRY_MS = 2000;
const BIND_RETRY_MAX = 15;

function start(port = Number(process.env.LIVEMCP_PORT) || DEFAULT_PORT) {
  const httpServer = createHttpServer();
  let retries = 0;

  const report = (msg) => {
    if (maxApi) maxApi.post(msg);
    else console.error(msg);
  };

  httpServer.listen(port, "127.0.0.1", () => {
    report(`LiveMCP: http://localhost:${port}/mcp で待機中`);
  });

  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE" && retries < BIND_RETRY_MAX) {
      retries++;
      report(`LiveMCP: ポート ${port} が使用中。${BIND_RETRY_MS}ms 後に再試行 (${retries}/${BIND_RETRY_MAX})`);
      setTimeout(() => httpServer.listen(port, "127.0.0.1"), BIND_RETRY_MS).unref();
      return;
    }
    report(`LiveMCP: HTTP サーバー起動失敗 (${err.code || err.message})。ポート ${port} が使用中の可能性`);
  });

  return httpServer;
}

if (require.main === module || maxApi) {
  start();
}

module.exports = { start, createHttpServer, buildMcpServer, bridge, config };
