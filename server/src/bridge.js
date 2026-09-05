// v8 (LiveAPI ブリッジ) との JSON メッセージ往復を request/response として扱う。
// node.script からは Max のパッチケーブル経由でしか LiveAPI に触れないため、
// id 付きリクエストを送り、対応する id のレスポンスで Promise を解決する。
"use strict";

const DEFAULT_TIMEOUT_MS = 15000;

class LiveBridge {
  /**
   * @param {(json: string) => void} send v8 へ JSON 文字列を送る関数
   */
  constructor(send, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this._send = send;
    this._timeoutMs = timeoutMs;
    this._pending = new Map();
    this._nextId = 1;
  }

  /**
   * v8 側の op を呼び出し、結果を Promise で返す
   * @param {string} op
   * @param {object} args
   */
  call(op, args = {}) {
    const id = this._nextId++;
    const payload = JSON.stringify({ id, op, args });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`LiveAPI ブリッジ応答なし (op=${op}, ${this._timeoutMs}ms)。デバイスが Live にロードされているか確認してください`));
      }, this._timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._send(payload);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  /** v8 からのレスポンス JSON 文字列を処理する */
  handleResponse(json) {
    let msg;
    try {
      msg = typeof json === "string" ? JSON.parse(json) : json;
    } catch {
      return false;
    }
    const entry = this._pending.get(msg.id);
    if (!entry) return false;
    this._pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) {
      entry.resolve(msg.result);
    } else {
      entry.reject(new Error(msg.error || "LiveAPI ブリッジでエラーが発生しました"));
    }
    return true;
  }

  get pendingCount() {
    return this._pending.size;
  }
}

module.exports = { LiveBridge, DEFAULT_TIMEOUT_MS };
