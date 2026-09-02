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
powershell -NoProfile -Command "Start-Process -FilePath 'pnpm' -ArgumentList 'dev' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -RedirectStandardOutput 'logs\dev.log' -RedirectStandardError 'logs\dev.err.log'"

REM wait a bit and check health
for /L %%i in (1,1,15) do (
  timeout /t 1 /nobreak >nul
  curl -sf -m 2 "http://127.0.0.1:5002/api/health" >nul 2>&1
  if not errorlevel 1 (
    echo [DEV START] healthy - http://127.0.0.1:5002
    echo [DEV START] logs: logs\dev.log / logs\dev.err.log
    exit /b 0
  )
  curl -sf -m 2 "http://127.0.0.1:5001/api/health" >nul 2>&1
  if not errorlevel 1 (
    echo [DEV START] healthy - http://127.0.0.1:5001
    exit /b 0
  )
)
echo [DEV START] launched - health not confirmed yet; check logs\dev.log
endlocal
