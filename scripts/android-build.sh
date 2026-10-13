/**
 * Android 构建入口。
 *
 * 存在的唯一理由是 JAVA_HOME：Gradle 找不到 JDK 时报的错是
 *   "ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH."
 * 而 Android Studio 自带的 JBR 通常已经装在机器上了，只是没配环境变量。
 * 每次构建前手敲 export 很容易忘，所以在这里自动探测一次。
 *
 * 用法：
 *   bash scripts/android-build.sh            # debug APK
 *   bash scripts/android-build.sh release    # release APK（未配签名时回落 debug 密钥）
 *   SKIP_WEB_BUILD=1 bash scripts/android-build.sh   # 跳过前端构建（只改了 Java 时）
 */
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VARIANT="${1:-debug}"

# ── JDK 探测 ──
if [[ -z "${JAVA_HOME:-}" || ! -x "${JAVA_HOME}/bin/java" ]]; then
  for candidate in \
    "/c/Program Files/Android/Android Studio/jbr" \
    "/c/Program Files/Java"/* \
    "/c/Program Files/Eclipse Adoptium"/* \
    "$HOME/.jdks"/*; do
    if [[ -x "${candidate}/bin/java" || -x "${candidate}/bin/java.exe" ]]; then
      export JAVA_HOME="$candidate"
      break
    fi
  done
fi
if [[ -z "${JAVA_HOME:-}" ]]; then
  echo "找不到 JDK。请安装 Android Studio（自带 JBR）或设置 JAVA_HOME。" >&2
  exit 1
fi
echo "[android] JAVA_HOME=$JAVA_HOME"

# ── 前端产物 ──
# 改了 TS/Vue/CSS 就必须重新同步 assets，否则 APK 里还是上一次的页面。
if [[ -z "${SKIP_WEB_BUILD:-}" ]]; then
  echo "[android] 构建前端产物…"
  (cd "$ROOT" && node scripts/build-kugou-api.mjs && npx vite build && node scripts/check-css-compat.mjs)
  (cd "$ROOT" && npx cap sync android)
else
  echo "[android] SKIP_WEB_BUILD 已设置，跳过前端构建（请自行确认 assets 是最新的）"
fi

# ── Gradle ──
TASK="assembleDebug"
[[ "$VARIANT" == "release" ]] && TASK="assembleRelease"

cd "$ROOT/android"
./gradlew "$TASK" --console=plain

echo
echo "[android] 产物："
find "$ROOT/android/app/build/outputs/apk" -name "*.apk" -newermt "-10 minutes" -print 2>/dev/null ||
  find "$ROOT/android/app/build/outputs/apk" -name "*.apk" -print
