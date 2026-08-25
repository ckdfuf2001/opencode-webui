@echo off
setlocal
cd /d "%~dp0"
set NODE_ENV=production
if "%PORT%"=="" set PORT=5002
if not exist "logs" mkdir logs

echo [START] checking prerequisites...
if not exist "opencode-webui.exe" echo [START] ERROR: opencode-webui.exe not found & exit /b 1
if exist "bin\opencode.exe" (echo [START] ok: opencode binary) else echo [START] WARN: bin\opencode.exe missing - AI sessions unavailable
if exist "bin\agent-browser" (echo [START] ok: agent-browser) else echo [START] WARN: bin\agent-browser missing - browser automation disabled
if exist "scripts\doc-reader.exe" (echo [START] ok: doc-reader.exe) else echo [START] WARN: doc-reader.exe missing - python fallback required
where git >nul 2>&1
if %errorlevel%==0 (echo [START] ok: git) else echo [START] WARN: git not found - clone/pull features unavailable

curl -sf -m 2 "http://127.0.0.1:%PORT%/api/health" >nul 2>&1
if %errorlevel%==0 (
  echo [START] already running on port %PORT% - nothing to do
  exit /b 0
)

echo [START] launching opencode-webui.exe on port %PORT% (log: logs\webui.log)
powershell -NoProfile -Command "Start-Process -FilePath '.\opencode-webui.exe' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -RedirectStandardOutput 'logs\webui.log' -RedirectStandardError 'logs\webui.err.log'"

for /L %%i in (1,1,30) do (
  timeout /t 1 /nobreak >nul
  curl -sf -m 2 "http://127.0.0.1:%PORT%/api/health" >nul 2>&1
  if not errorlevel 1 (
    echo [START] healthy - http://127.0.0.1:%PORT%
    exit /b 0
  )
)
echo [START] launched - health not confirmed yet; check logs\webui.log
endlocal
