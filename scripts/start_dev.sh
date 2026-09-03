#!/usr/bin/env bash
# start pnpm dev (backend --watch + frontend vite) in background, logs to logs/dev.log
cd "$(dirname "$0")/.."
mkdir -p logs
echo "[DEV START] launching pnpm dev..."
if ! command -v pnpm >/dev/null 2>&1; then echo "[DEV START] ERROR: pnpm not found"; exit 1; fi
# kill previous if any
bash "$(dirname "$0")/stop_dev.sh" >/dev/null 2>&1 || true
nohup pnpm dev > logs/dev.log 2> logs/dev.err.log &
PID=$!
echo $PID > logs/dev.pid
echo "[DEV START] pid $PID logs: logs/dev.log / logs/dev.err.log / pid logs/dev.pid"
for i in {1..30}; do
  sleep 1
  if curl -sf -m 3 "http://127.0.0.1:5002/api/health" >/dev/null 2>&1 || curl -sf -m 3 "http://127.0.0.1:5001/api/health" >/dev/null 2>&1; then
    echo "[DEV START] healthy"
    exit 0
  fi
done
echo "[DEV START] launched - health not confirmed yet; check logs/dev.log and logs/dev.pid ($PID)"
