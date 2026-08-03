@echo off
setlocal enabledelayedexpansion

set "WORKSPACE_PATH=.\workspace"
set "ENV_FILE=.env"

echo ==========================================
echo  OpenCode WebUI - Dev Environment Setup
echo ==========================================
echo.
echo [1/5] Checking prerequisites...

REM Bun
where bun >nul 2>nul
if %errorlevel%==0 (
  echo   [+] Bun is installed
) else (
  echo   [x] Bun is NOT installed.
  echo       Install it from: https://bun.sh
  exit /b 1
)

REM pnpm
where pnpm >nul 2>nul
if %errorlevel%==0 (
  echo   [+] pnpm is installed
) else (
  echo   [x] pnpm is NOT installed.
  echo       Install it with: npm install -g pnpm
  exit /b 1
)

REM OpenCode
where opencode >nul 2>nul
if %errorlevel%==0 (
  echo   [+] OpenCode is installed
) else (
  echo   [x] OpenCode TUI is NOT installed.
  echo       Install it with: curl -fsSL https://opencode.ai/install
  exit /b 1
)

REM Git
where git >nul 2>nul
if %errorlevel%==0 (
  echo   [+] Git is installed
) else (
  echo   [x] Git is NOT installed.
  echo       Install it from: https://git-scm.com
  exit /b 1
)

echo.
echo [2/5] Creating workspace directories...
if not exist "%WORKSPACE_PATH%\repos" mkdir "%WORKSPACE_PATH%\repos"
if not exist "%WORKSPACE_PATH%\.config\opencode" mkdir "%WORKSPACE_PATH%\.config\opencode"

echo.
echo [3/5] Installing dependencies (pnpm install)...
call pnpm install
if %errorlevel% neq 0 (
  echo   [x] pnpm install failed.
  exit /b 1
)

echo.
echo [4/5] Creating environment file if missing...
if not exist "%ENV_FILE%" (
  copy .env.example ".env" >nul
  echo   [+] Created .env from .env.example
) else (
  echo   [+] .env already exists
)

echo.
echo [5/5] Verifying runtime...
bun --version >nul 2>nul
if %errorlevel% neq 0 (
  echo   [x] bun --version failed.
  exit /b 1
)

echo.
echo ==========================================
echo   Dev environment ready!
echo ==========================================
echo.
echo Available commands:
echo   npm run dev              Start both backend and frontend
echo   npm run dev:backend      Start backend only
echo   npm run dev:frontend     Start frontend only
echo.
exit /b 0