@echo off
setlocal
cd /d "%~dp0"

echo [STOP] stopping opencode-webui.exe...
taskkill /IM opencode-webui.exe /T /F >nul 2>&1
taskkill /IM cy5-webui.exe /T /F >nul 2>&1

echo [STOP] stopping OpenCode server spawned by this folder...
powershell -NoProfile -Command "$cwd = (Get-Location).Path; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'opencode.exe' -and $_.ExecutablePath -like ($cwd + '*') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }"

echo [STOP] stopping agent-browser (per-folder + global daemon) and chrome...
powershell -NoProfile -Command "$cwd = (Get-Location).Path; Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'agent-browser.exe' -or $_.Name -eq 'doc-converter.exe' -or $_.Name -eq 'doc-reader.exe') -and $_.ExecutablePath -like ($cwd + '*') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'agent-browser.exe' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*agent-browser*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }"
powershell -NoProfile -Command "Get-Process soffice.bin,soffice,libreoffice,ffmpeg -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"

echo [STOP] done.
endlocal
