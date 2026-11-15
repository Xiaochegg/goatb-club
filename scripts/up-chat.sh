#!/bin/bash
# ============================================================
# GOATB 聊天服务一键启动与健康检查（幂等）
# 用法：bash scripts/up-chat.sh
# 行为：
#   - 已在运行（:3003 /health 可达）→ 仅打印健康状态，退出 0
#   - 未运行 → 后台拉起 mini-services/chat-service（bun run dev）
#     并轮询 /health（最多 15 秒）
#   - 失败 → 非零退出并提示日志位置
# 说明：本脚本不改动任何业务文件；重复执行安全（幂等）。
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/chat-service.log"
PORT=3003

if curl -sf --max-time 2 "http://localhost:$PORT/health" >/dev/null 2>&1; then
  echo "[up-chat] 聊天服务已在运行：$(curl -sf "http://localhost:$PORT/health")"
  exit 0
fi

echo "[up-chat] 未检测到聊天服务，后台拉起 mini-services/chat-service …"
(cd "$ROOT/mini-services/chat-service" && nohup bun run dev > "$LOG" 2>&1 &)

for _ in $(seq 1 15); do
  if curl -sf --max-time 2 "http://localhost:$PORT/health" >/dev/null 2>&1; then
    echo "[up-chat] 启动成功：$(curl -sf "http://localhost:$PORT/health")"
    exit 0
  fi
  sleep 1
done

echo "[up-chat] 启动失败（15 秒内 /health 不可达），请查看 $LOG" >&2
exit 1
