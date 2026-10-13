#!/usr/bin/env bash
#
# 把设备的 WebView 调试端口转发到本机，供 device-eval.mjs 使用。
#
# 为什么要脚本化：`localabstract:` 的名字里带 pid，应用重启后 pid 会变，
# 每次都手敲一遍 adb pidof + forward 很容易敲错（敲错的症状是 CDP 连上一个
# 已经被销毁的 target，或直接连不上）。
#
# 用法：bash scripts/device-forward.sh
#
set -euo pipefail

# ── 找 adb ──
# 优先 PATH，其次 Android SDK 的默认位置。
#
# 注意两点（都踩过）：
#  · Git Bash 下 $LOCALAPPDATA / $USERPROFILE 是 Windows 形式（C:\Users\...），
#    不能直接拼成 /c/Users/... 的路径；有 cygpath 就交给它，没有就通配。
#  · 这里的 $USER 是空的、whoami 也可能是域账号，都不能拿来拼 HOME 下的路径。
find_adb() {
  if command -v adb >/dev/null 2>&1; then
    command -v adb
    return
  fi

  local localappdata="${LOCALAPPDATA:-}"
  if [[ -n "$localappdata" ]] && command -v cygpath >/dev/null 2>&1; then
    localappdata="$(cygpath -u "$localappdata")"
  fi

  local candidates=(
    "${ANDROID_HOME:-}/platform-tools/adb.exe"
    "${ANDROID_SDK_ROOT:-}/platform-tools/adb.exe"
    "$localappdata/Android/Sdk/platform-tools/adb.exe"
  )
  # 通配兜底：SDK 装在别的用户名下（或不是当前登录用户）时也能找到
  candidates+=(/c/Users/*/AppData/Local/Android/Sdk/platform-tools/adb.exe)

  for candidate in "${candidates[@]}"; do
    [[ -n "$candidate" && -x "$candidate" ]] && { echo "$candidate"; return; }
  done
  return 1
}

ADB="$(find_adb)" || {
  echo "找不到 adb。请设置 ANDROID_HOME，或把 platform-tools 加进 PATH。" >&2
  exit 1
}

APP_ID="${APP_ID:-com.hppmusic.app}"
PORT="${PORT:-9222}"

PID="$("$ADB" shell pidof "$APP_ID" | tr -d '\r')"
if [[ -z "$PID" ]]; then
  echo "没找到正在运行的 $APP_ID，先启动应用再跑本脚本" >&2
  exit 1
fi

"$ADB" forward "tcp:$PORT" "localabstract:webview_devtools_remote_$PID"
echo "已转发 tcp:$PORT -> webview_devtools_remote_$PID（pid=$PID）"
echo "试试：node scripts/device-eval.mjs \"document.title\""
