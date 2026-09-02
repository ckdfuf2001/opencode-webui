#!/usr/bin/env bash
# stop pnpm dev and related processes spawned from this folder (cwd filter, no global kill)
cd "$(dirname "$0")/.."
CWD="$(pwd -W 2>/dev/null || pwd)"
echo "[DEV STOP] stopping pnpm dev..."
# kill concurrently/vite/bun with this folder in args
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
