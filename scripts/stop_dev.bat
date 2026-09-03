@echo off
setlocal
cd /d "%~dp0\.."

echo [DEV STOP] stopping pnpm dev and related processes...

REM 1) Try PID file first (most reliable for pnpm dev's concurrently root)
if exist "logs\dev.pid" (
  for /f "usebackq delims=" %%p in ("logs\dev.pid") do (
    echo [DEV STOP] killing pid from logs\dev.pid: %%p
    taskkill /PID %%p /T /F >nul 2>&1
    if not errorlevel 1 echo [DEV STOP] killed pid %%p
  )
  del /f /q "logs\dev.pid" >nul 2>&1
)

REM 2) Kill by port (5002 backend, 5173 vite) — most reliable for orphaned servers
for %%P in (5002 5001 5173 3000) do (
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%P " ^| findstr "LISTENING"') do (
    echo [DEV STOP] killing port %%P PID %%a
    taskkill /PID %%a /T /F >nul 2>&1
  )
)

REM 3) Kill concurrently/node that was started from this folder (cwd in CommandLine)
powershell -NoProfile -Command "$cwd = (Get-Location).Path; $esc = $cwd -replace '\','\\'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*concurrently*' -and $_.CommandLine -like ('*' + $cwd + '*') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null; Write-Host ('[DEV STOP] killed concurrently PID ' + $_.ProcessId) }"
powershell -NoProfile -Command "$cwd = (Get-Location).Path; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*vite*' -and $_.CommandLine -like ('*' + $cwd + '*') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null; Write-Host ('[DEV STOP] killed vite PID ' + $_.ProcessId) }"
powershell -NoProfile -Command "$cwd = (Get-Location).Path; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'bun.exe' -and ($_.CommandLine -like '*backend/src/index.ts*' -or $_.ExecutablePath -like ($cwd + '*')) } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null; Write-Host ('[DEV STOP] killed bun PID ' + $_.ProcessId) }"

REM 4) Fallback: any remaining node/bun with this folder in CommandLine (covers pnpm dev)
powershell -NoProfile -Command "$cwd = (Get-Location).Path; Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -or $_.Name -eq 'bun.exe') -and $_.CommandLine -like ('*' + $cwd + '*') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }"

REM 5) Kill opencode and agent-browser spawned by this folder
powershell -NoProfile -Command "$cwd = (Get-Location).Path; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'opencode.exe' -and $_.ExecutablePath -like ($cwd + '*') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null; Write-Host ('[DEV STOP] killed opencode PID ' + $_.ProcessId) }"
powershell -NoProfile -Command "$cwd = (Get-Location).Path; Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'agent-browser.exe' -or $_.Name -eq 'doc-converter.exe' -or $_.Name -eq 'doc-reader.exe') -and $_.ExecutablePath -like ($cwd + '*') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }"

REM 6) Kill vite's esbuild child if any
taskkill /IM esbuild.exe /T /F >nul 2>&1

REM 7) Also kill any lingering npm/pnpm that still holds the dev cwd
powershell -NoProfile -Command "$cwd = (Get-Location).Path; Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'npm.exe' -or $_.Name -eq 'pnpm.exe') -and $_.CommandLine -like ('*' + $cwd + '*') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }"

echo [DEV STOP] done. Check logs\dev.log if needed.
endlocal
