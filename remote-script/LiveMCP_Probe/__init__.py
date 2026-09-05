# LiveMCP 検証用 Remote Script（Issue #12）
#
# 目的は移行の可否判断であって、製品実装ではない。確かめるのは次の 6 点。
#
#   1. ユーザーの Remote Scripts フォルダに置いた自作スクリプトがロードされるか
#   2. Song.group_tracks が呼べるか、引数は何か
#   3. Song.save が何をするか
#   4. Application.browser からデバイスを列挙・ロードできるか
#   5. Remote Script 内でソケットを開いて待ち受けられるか
#   6. begin_undo_step / end_undo_step で一括操作を 1 Undo にまとめられるか
#
# 破壊的な操作（group_tracks / save）はロード時には実行せず、ソケット経由で
# 明示的に叩いたときだけ動かす。
#
# ソケットはスレッドを立てず、Live のメインスレッドで回る update_display から
# 非ブロッキングで読む。LiveAPI を別スレッドから触らないための構成で、
# 本実装でもこの形を踏襲する想定。

from __future__ import absolute_import

import errno
import json
import os
import socket
import traceback

import Live
from _Framework.ControlSurface import ControlSurface

PORT = 3361  # 3360 は M4L 版の node.script が使っている
HERE = os.path.dirname(os.path.abspath(__file__))
REPORT = os.path.join(HERE, "probe-report.json")


def create_instance(c_instance):
    return LiveMCPProbe(c_instance)


class LiveMCPProbe(ControlSurface):
    def __init__(self, c_instance):
        super(LiveMCPProbe, self).__init__(c_instance)
        self._sock = None
        self._error = None
        with self.component_guard():
            self.log_message("LiveMCP Probe: ロードされました")
            self._write_report()
            self._open_socket()

    # ---- 1 / 4: API の実体を吐き出す（非破壊） ----

    def _write_report(self):
        try:
            app = Live.Application.get_application()
            song = self.song()
            report = {
                "live_version": "%d.%d.%d" % (
                    app.get_major_version(), app.get_minor_version(), app.get_bugfix_version()),
                "song_members": sorted(m for m in dir(song) if not m.startswith("_")),
                "application_members": sorted(m for m in dir(app) if not m.startswith("_")),
                "browser": self._browser_report(app),
                "checks": {
                    "has_group_tracks": hasattr(song, "group_tracks"),
                    "has_save": hasattr(song, "save"),
                    "has_can_be_saved": hasattr(song, "can_be_saved"),
                    "has_undo_step": hasattr(song, "begin_undo_step") and hasattr(song, "end_undo_step"),
                    "has_browser": hasattr(app, "browser"),
                },
                "doc": {
                    name: (getattr(type(song), name).__doc__ or "")[:400]
                    for name in ("group_tracks", "save", "begin_undo_step", "end_undo_step")
                    if hasattr(type(song), name)
                },
            }
        except Exception:
            report = {"error": traceback.format_exc()}

        try:
            with open(REPORT, "w") as f:
                json.dump(report, f, ensure_ascii=False, indent=1)
            self.log_message("LiveMCP Probe: レポートを書き出しました %s" % REPORT)
        except Exception as e:
            self.log_message("LiveMCP Probe: レポート書き出し失敗 %r" % (e,))

    def _browser_report(self, app):
        if not hasattr(app, "browser"):
            return {"available": False}
        b = app.browser
        out = {"available": True, "members": sorted(m for m in dir(b) if not m.startswith("_"))}
        try:
            # ルート直下のカテゴリ名だけ拾う（重い再帰はしない）
            out["roots"] = {
                name: [c.name for c in getattr(b, name).children[:8]]
                for name in ("instruments", "audio_effects", "drums", "sounds")
                if hasattr(b, name)
            }
        except Exception:
            out["roots_error"] = traceback.format_exc()
        return out

    # ---- 5: ソケット ----

    def _open_socket(self):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("127.0.0.1", PORT))
            s.listen(4)
            s.setblocking(False)
            self._sock = s
            self.log_message("LiveMCP Probe: 127.0.0.1:%d で待機中" % PORT)
        except Exception as e:
            self._error = repr(e)
            self.log_message("LiveMCP Probe: ソケットを開けませんでした %r" % (e,))

    def update_display(self):
        # Live のメインスレッドから ~100ms 間隔で呼ばれる。
        # ここで受け付けるので LiveAPI をワーカースレッドから触らずに済む。
        super(LiveMCPProbe, self).update_display()
        if self._sock is None:
            return
        try:
            conn, _ = self._sock.accept()
        except OSError as e:
            if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                return
            return
        try:
            conn.settimeout(0.5)
            data = conn.recv(65536).decode("utf-8").strip()
            result = self._handle(json.loads(data)) if data else {"error": "空のリクエスト"}
        except Exception:
            result = {"error": traceback.format_exc()}
        try:
            conn.sendall((json.dumps(result, ensure_ascii=False) + "\n").encode("utf-8"))
        except Exception:
            pass
        finally:
            conn.close()

    # ---- 2 / 3 / 6: 破壊的な操作は明示的に叩いたときだけ ----

    def _handle(self, req):
        op = req.get("op")
        song = self.song()

        if op == "ping":
            return {"ok": True, "port": PORT, "report": REPORT}

        if op == "api":
            return {
                "song_members": sorted(m for m in dir(song) if not m.startswith("_")),
                "can_be_saved": getattr(song, "can_be_saved", None),
                "file_path": getattr(song, "file_path", None),
            }

        if op == "tracks":
            return {"tracks": [
                {"index": i, "name": t.name, "is_grouped": t.is_grouped,
                 "is_foldable": t.is_foldable}
                for i, t in enumerate(song.tracks)
            ]}

        if op == "group":
            # 引数の形が分からないので、渡された通りに呼んで結果を見る
            args = req.get("args", [])
            return {"result": repr(song.group_tracks(*args))}

        if op == "save":
            return {"can_be_saved": getattr(song, "can_be_saved", None),
                    "result": repr(song.save())}

        if op == "undo":
            song.undo()
            return {"track_count": len(song.tracks), "can_undo": song.can_undo}

        if op == "message":
            # Live のステータスバーへ出す。Live 側にモーダルを出させる API は無い。
            # Application.show_message は Boost.Python の型（TText）が Python の str と
            # 合わず ArgumentError になる。ControlSurface.show_message 経由が正解で、
            # これが内部で c_instance の show_message を呼ぶ。
            self.show_message(req.get("text", ""))
            return {"shown": req.get("text", "")}

        if op == "state":
            return {"track_count": len(song.tracks), "can_undo": song.can_undo,
                    "can_redo": song.can_redo, "file_path": song.file_path}

        if op == "dir":
            # 任意のオブジェクトのメンバーを覗く（Track など Song 以外の確認用）
            target = {"song": song, "app": Live.Application.get_application(),
                      "track": song.tracks[req.get("index", 0)],
                      "view": song.view}.get(req.get("target", "song"))
            if target is None:
                return {"error": "unknown target"}
            return {"members": sorted(m for m in dir(target) if not m.startswith("_"))}

        if op == "undo_step":
            # 2 つの操作を 1 Undo にまとめられるか
            song.begin_undo_step()
            a = song.create_midi_track(-1)
            b = song.create_midi_track(-1)
            song.end_undo_step()
            return {"created": [repr(a), repr(b)], "track_count": len(song.tracks)}

        if op == "browser_load":
            app = Live.Application.get_application()
            item = self._find_browser_item(app.browser, req.get("name", ""))
            if item is None:
                return {"error": "見つかりません: %s" % req.get("name")}
            app.browser.load_item(item)
            return {"loaded": item.name}

        return {"error": "unknown op: %r" % op}

    def _find_browser_item(self, browser, name, depth=0):
        for root in ("instruments", "audio_effects", "drums"):
            node = getattr(browser, root, None)
            if node is None:
                continue
            found = self._walk(node, name, 0)
            if found is not None:
                return found
        return None

    def _walk(self, node, name, depth):
        if depth > 3:
            return None
        for child in node.children:
            if child.name == name:
                return child
            found = self._walk(child, name, depth + 1)
            if found is not None:
                return found
        return None

    def disconnect(self):
        if self._sock is not None:
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None
        self.log_message("LiveMCP Probe: 切断しました")
        super(LiveMCPProbe, self).disconnect()
