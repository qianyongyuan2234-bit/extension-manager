#!/bin/bash
# 启动 Chrome CDP 调试模式（硬链接 profile 绕过默认 profile 限制）
# Usage: ./cdp-start.sh [port]

PORT="${1:-9223}"
REAL_PROFILE="$HOME/Library/Application Support/Google/Chrome"
TMP_PROFILE="/tmp/chrome-profile"

echo "🔧 Chrome CDP 启动器"
echo "   端口: $PORT"

# 检查是否已在运行
if curl -s "http://localhost:$PORT/json/version" > /dev/null 2>&1; then
  echo "✅ Chrome CDP 已在端口 $PORT 运行"
  exit 0
fi

# 创建/刷新硬链接 profile（不占额外磁盘空间）
if [ ! -d "$TMP_PROFILE" ]; then
  echo "📁 创建硬链接 profile (首次需几秒)..."
  cp -alR "$REAL_PROFILE" "$TMP_PROFILE"
else
  echo "📁 刷新硬链接 profile..."
  rm -rf "$TMP_PROFILE"
  cp -alR "$REAL_PROFILE" "$TMP_PROFILE"
fi

echo "🚀 启动 Chrome..."
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$TMP_PROFILE" \
  --no-first-run \
  > /dev/null 2>&1 &

# 等待启动
for i in $(seq 1 15); do
  sleep 1
  if curl -s "http://localhost:$PORT/json/version" > /dev/null 2>&1; then
    echo "✅ Chrome CDP 已就绪: http://localhost:$PORT"
    exit 0
  fi
  echo -n "."
done
echo ""
echo "❌ 启动超时，请手动检查"
exit 1
