#!/usr/bin/env bash
# stop pnpm dev and related processes spawned from this folder (cwd filter, no global kill)
cd "$(dirname "$0")/.."
CWD="$(pwd -W 2>/dev/null || pwd)"
echo "[DEV STOP] stopping pnpm dev..."
# 1) PID file first
if [ -f "logs/dev.pid" ]; then
  PID=$(cat logs/dev.pid 2>/dev/null | tr -d ' \r\n')
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "[DEV STOP] killing pid $PID from logs/dev.pid"
    kill -9 "$PID" 2>/dev/null || true
    # also kill children via pkill by parent
    pkill -P "$PID" 2>/dev/null || true
  fi
  rm -f logs/dev.pid
fi
# 2) Kill by port (5002 backend, 5173 vite)
for PORT in 5002 5001 5173 3000; do
  if command -v lsof >/dev/null 2>&1; then
    PID=$(lsof -ti tcp:$PORT 2>/dev/null | head -1)
    if [ -n "$PID" ]; then echo "[DEV STOP] killing port $PORT PID $PID"; kill -9 "$PID" 2>/dev/null || true; fi
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ano 2>/dev/null | grep -E ":$PORT " | awk '{print $5}' | head -1 | xargs -r kill -9 2>/dev/null || true
  fi
done
# 3) kill concurrently/vite/bun with this folder in args
pkill -f "concurrently.*${CWD}" 2>/dev/null || true
pkill -f "vite.*${CWD}" 2>/dev/null || true
pkill -f "bun.*backend/src/index.ts" 2>/dev/null || true
# fallback: pkill by cwd
if command -v powershell.exe >/dev/null 2>&1; then
  powershell.exe -NoProfile -Command "\$cwd = '$CWD' -replace '/', '\\\\'; Get-CimInstance Win32_Process | Where-Object { (\$_.Name -eq 'node.exe' -or \$_.Name -eq 'bun.exe') -and \$_.CommandLine -like ('*' + \$cwd + '*') } | ForEach-Object { taskkill /PID \$_.ProcessId /T /F 2>\$null | Out-Null }"
  powershell.exe -NoProfile -Command "\$cwd = '$CWD' -replace '/', '\\\\'; Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'opencode.exe' -and \$_.ExecutablePath -like (\$cwd + '*') } | ForEach-Object { taskkill /PID \$_.ProcessId /T /F 2>\$null | Out-Null }"
  powershell.exe -NoProfile -Command "\$cwd = '$CWD' -replace '/', '\\\\'; Get-CimInstance Win32_Process | Where-Object { (\$_.Name -eq 'agent-browser.exe' -or \$_.Name -eq 'doc-converter.exe') -and \$_.ExecutablePath -like (\$cwd + '*') } | ForEach-Object { taskkill /PID \$_.ProcessId /T /F 2>\$null | Out-Null }"
fi
# also try generic pkill for opencode/agent-browser in this tree
pkill -f "opencode.*${CWD}" 2>/dev/null || true
pkill -f "agent-browser.*${CWD}" 2>/dev/null || true
echo "[DEV STOP] done."
