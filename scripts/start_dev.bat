@echo off
setlocal
cd /d "%~dp0\.."

if not exist "logs" mkdir logs

echo [DEV START] launching pnpm dev (backend + frontend)...
where pnpm >nul 2>&1
if %errorlevel% neq 0 (
  echo [DEV START] ERROR: pnpm not found in PATH
  exit /b 1
)
where bun >nul 2>&1
if %errorlevel% neq 0 (
  echo [DEV START] WARN: bun not found - backend may not start
)

REM kill any previous dev instance first to avoid port conflicts
call "%~dp0stop_dev.bat" >nul 2>&1

echo [DEV START] starting pnpm dev ^> logs\dev.log ^(also logs\dev.err.log^)
REM Use cmd /c with proper redirection so concurrently/bun/vite output is fully captured to logs
powershell -NoProfile -Command "$cmd = 'pnpm dev 1^> logs\dev.log 2^> logs\dev.err.log'; $p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $cmd) -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -PassThru; $p.Id | Out-File -Encoding ascii logs\dev.pid; Write-Host ('[DEV START] pid ' + $p.Id + ' (cmd /c pnpm dev)')"
REM Also ensure logs are flushed and contain output
powershell -NoProfile -Command "Start-Sleep -Milliseconds 500; if (Test-Path 'logs\dev.log') { Write-Host ('[DEV START] log size ' + (Get-Item 'logs\dev.log').Length + ' bytes') }"

REM wait a bit and check health (extend to 30s, check both ports and longer timeout)
for /L %%i in (1,1,30) do (
  timeout /t 1 /nobreak >nul
  curl -sf -m 3 "http://127.0.0.1:5002/api/health" >nul 2>&1
  if not errorlevel 1 (
    echo [DEV START] healthy - http://127.0.0.1:5002
    echo [DEV START] logs: logs\dev.log / logs\dev.err.log / pid logs\dev.pid
    exit /b 0
  )
  curl -sf -m 3 "http://127.0.0.1:5001/api/health" >nul 2>&1
  if not errorlevel 1 (
    echo [DEV START] healthy - http://127.0.0.1:5001
    echo [DEV START] logs: logs\dev.log / logs\dev.err.log / pid logs\dev.pid
    exit /b 0
  )
)
echo [DEV START] launched - health not confirmed yet; check logs\dev.log and logs\dev.pid
if exist "logs\dev.pid" type "logs\dev.pid"
endlocal
