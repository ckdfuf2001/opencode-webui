@echo off
setlocal
cd /d "%~dp0\.."

echo [DEV STOP] stopping pnpm dev and related processes...

REM kill concurrently/node that was started from this folder (most reliable: kill by cwd in CommandLine)
powershell -NoProfile -Command "$cwd = (Get-Location).Path; $esc = $cwd -replace '\','\\'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*concurrently*' -and $_.CommandLine -like ('*' + $cwd + '*') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null; Write-Host ('[DEV STOP] killed concurrently PID ' + $_.ProcessId) }"
powershell -NoProfile -Command "$cwd = (Get-Location).Path; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*vite*' -and $_.CommandLine -like ('*' + $cwd + '*') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null; Write-Host ('[DEV STOP] killed vite PID ' + $_.ProcessId) }"
powershell -NoProfile -Command "$cwd = (Get-Location).Path; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'bun.exe' -and ($_.CommandLine -like '*backend/src/index.ts*' -or $_.ExecutablePath -like ($cwd + '*')) } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null; Write-Host ('[DEV STOP] killed bun PID ' + $_.ProcessId) }"

REM fallback: kill any remaining node/bun with this folder in CommandLine (covers pnpm dev)
powershell -NoProfile -Command "$cwd = (Get-Location).Path; Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -or $_.Name -eq 'bun.exe') -and $_.CommandLine -like ('*' + $cwd + '*') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }"

REM kill opencode and agent-browser spawned by this folder (same logic as stop_opencode_webui_exe but without global kill)
powershell -NoProfile -Command "$cwd = (Get-Location).Path; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'opencode.exe' -and $_.ExecutablePath -like ($cwd + '*') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null; Write-Host ('[DEV STOP] killed opencode PID ' + $_.ProcessId) }"
powershell -NoProfile -Command "$cwd = (Get-Location).Path; Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'agent-browser.exe' -or $_.Name -eq 'doc-converter.exe' -or $_.Name -eq 'doc-reader.exe') -and $_.ExecutablePath -like ($cwd + '*') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }"

REM kill vite's esbuild child if any
taskkill /IM esbuild.exe /T /F >nul 2>&1

REM also kill any lingering npm/pnpm that still holds the dev cwd
powershell -NoProfile -Command "$cwd = (Get-Location).Path; Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'npm.exe' -or $_.Name -eq 'pnpm.exe') -and $_.CommandLine -like ('*' + $cwd + '*') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }"

echo [DEV STOP] done. Check logs\dev.log if needed.
endlocal
