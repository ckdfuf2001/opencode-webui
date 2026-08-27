#!/usr/bin/env bash
# stop cy5-webui portable instance (this folder only)
cd "$(dirname "$0")"
CWD="$(pwd -W 2>/dev/null || pwd)"

echo "[STOP] stopping cy5-webui..."
pkill -f "cy5-webui.exe" 2>/dev/null || taskkill //IM cy5-webui.exe //T //F >/dev/null 2>&1

echo "[STOP] stopping children spawned by this folder..."
powershell.exe -NoProfile -Command "\$cwd = '$CWD' -replace '/', '\\\\'; Get-CimInstance Win32_Process | Where-Object { (\$_.Name -eq 'opencode.exe' -or \$_.Name -eq 'agent-browser.exe' -or \$_.Name -eq 'doc-converter.exe') -and \$_.ExecutablePath -like (\$cwd + '*') } | ForEach-Object { taskkill /PID \$_.ProcessId /T /F 2>\$null | Out-Null }"

echo "[STOP] done."
