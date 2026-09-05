#!/bin/sh
# LiveMCP の導入スクリプト。zip を展開したフォルダで実行する（curl 経由でも同じ）。
#
#   sh install.sh                 既定の場所へ配置
#   LIVE_USER_LIBRARY=... sh install.sh   User Library の場所を指定（既定 ~/Music/Ableton/User Library）
#
# 配置先:
#   <User Library>/Presets/Audio Effects/Max Audio Effect/LiveMCP/   LiveMCP.amxd / livemcp-server.js / livemcp-bridge.js
#   ~/Documents/Max 9/Library/                                        livemcp-server.js / livemcp-bridge.js
#   <User Library>/Templates/LiveMCP.als                              LiveMCP を載せたテンプレートセット
#
# Live 上のデバイスは .amxd と同じフォルダを Max の検索パスに入れないため、2 つの .js は
# Max の標準ユーザーライブラリにも置く。Max 8 しか無い環境では "Max 8" を使う。
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
USER_LIBRARY=${LIVE_USER_LIBRARY:-"$HOME/Music/Ableton/User Library"}
PRESET_DIR="$USER_LIBRARY/Presets/Audio Effects/Max Audio Effect/LiveMCP"
TEMPLATE_DIR="$USER_LIBRARY/Templates"
MAX_LIBRARY=${MAX_LIBRARY:-}
if [ -z "$MAX_LIBRARY" ]; then
  for v in "Max 9" "Max 8"; do
    if [ -d "$HOME/Documents/$v" ]; then MAX_LIBRARY="$HOME/Documents/$v/Library"; break; fi
  done
fi

for f in LiveMCP.amxd livemcp-server.js livemcp-bridge.js LiveMCP.als; do
  [ -f "$HERE/$f" ] || { echo "エラー: $f が見つかりません（zip を展開したフォルダで実行してください）" >&2; exit 1; }
done
[ -d "$USER_LIBRARY" ] || { echo "エラー: User Library が見つかりません: $USER_LIBRARY（LIVE_USER_LIBRARY で指定できます）" >&2; exit 1; }

echo "LiveMCP を導入します"
mkdir -p "$PRESET_DIR" "$TEMPLATE_DIR"
for f in LiveMCP.amxd livemcp-server.js livemcp-bridge.js; do
  cp "$HERE/$f" "$PRESET_DIR/$f"; echo "  配置 $PRESET_DIR/$f"
done
if [ -n "$MAX_LIBRARY" ]; then
  mkdir -p "$MAX_LIBRARY"
  for f in livemcp-server.js livemcp-bridge.js; do
    cp "$HERE/$f" "$MAX_LIBRARY/$f"; echo "  配置 $MAX_LIBRARY/$f"
  done
else
  echo "  注意: ~/Documents/Max 9 (または Max 8) が見つかりません。Max for Live を一度起動してから再実行してください" >&2
fi
# テンプレートの中の .amxd 参照は User Library 基準の相対パスで解決されるが、絶対パスの方も実際の場所に直しておく
ESCAPED=$(printf '%s' "$USER_LIBRARY" | sed 's/[&|]/\\&/g')
if gunzip -c "$HERE/LiveMCP.als" | sed "s|/LIVEMCP_USER_LIBRARY|$ESCAPED|g" | gzip -9 > "$TEMPLATE_DIR/LiveMCP.als"; then
  echo "  配置 $TEMPLATE_DIR/LiveMCP.als"
else
  cp "$HERE/LiveMCP.als" "$TEMPLATE_DIR/LiveMCP.als"; echo "  配置 $TEMPLATE_DIR/LiveMCP.als（パスの書き換えは省略）"
fi

# Claude Code への登録（あれば）
if command -v claude >/dev/null 2>&1; then
  if claude mcp get live-mcp >/dev/null 2>&1; then
    echo "  Claude Code: live-mcp は登録済み"
  else
    claude mcp add --transport http live-mcp http://localhost:3360/mcp >/dev/null && echo "  Claude Code: live-mcp を登録しました（http://localhost:3360/mcp）"
  fi
else
  echo "  Claude Code が見つかりません。後で次を実行してください:"
  echo "    claude mcp add --transport http live-mcp http://localhost:3360/mcp"
fi

cat <<'MSG'

完了。次の 3 手順で使えます。
  1. Live を再起動する（起動中なら。Max はファイルをパス単位でキャッシュするため）
  2. Live のブラウザ → User Library → Templates → LiveMCP をダブルクリックして新規セットを作る
     （既存のセットで使うときは Presets → Audio Effects → Max Audio Effect → LiveMCP をトラックへ）
  3. Claude Code で「live.status を実行して」— Live のバージョンが返れば接続完了
MSG
