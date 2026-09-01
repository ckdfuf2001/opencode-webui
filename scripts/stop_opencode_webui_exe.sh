#!/usr/bin/env bash
# stop opencode-webui portable instance (this folder + global agent-browser daemon)
cd "$(dirname "$0")"
CWD="$(pwd -W 2>/dev/null || pwd)"

echo "[STOP] stopping opencode-webui..."
pkill -f "opencode-webui.exe" 2>/dev/null || taskkill //IM opencode-webui.exe //T //F >/dev/null 2>&1
taskkill //IM cy5-webui.exe //T //F >/dev/null 2>&1

echo "[STOP] stopping OpenCode server spawned by this folder..."
powershell.exe -NoProfile -Command "\$cwd = '$CWD' -replace '/', '\\\\'; Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'opencode.exe' -and \$_.ExecutablePath -like (\$cwd + '*') } | ForEach-Object { taskkill /PID \$_.ProcessId /T /F 2>\$null | Out-Null }"

echo "[STOP] stopping agent-browser and chrome..."
powershell.exe -NoProfile -Command "\$cwd = '$CWD' -replace '/', '\\\\'; Get-CimInstance Win32_Process | Where-Object { (\$_.Name -eq 'agent-browser.exe' -or \$_.Name -eq 'doc-converter.exe' -or \$_.Name -eq 'doc-reader.exe') -and \$_.ExecutablePath -like (\$cwd + '*') } | ForEach-Object { taskkill /PID \$_.ProcessId /T /F 2>\$null | Out-Null }"
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'agent-browser.exe' } | ForEach-Object { taskkill /PID \$_.ProcessId /T /F 2>\$null | Out-Null }"
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'chrome.exe' -and \$_.CommandLine -like '*agent-browser*' } | ForEach-Object { taskkill /PID \$_.ProcessId /T /F 2>\$null | Out-Null }"
powershell.exe -NoProfile -Command "Get-Process soffice.bin,soffice,libreoffice,ffmpeg -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"

echo "[STOP] done."
