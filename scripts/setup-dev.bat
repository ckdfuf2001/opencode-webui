@echo off
setlocal enabledelayedexpansion

set "WORKSPACE_PATH=.\workspace"
set "ENV_FILE=.env"

echo ==========================================
echo  OpenCode WebUI - Dev Environment Setup
echo ==========================================
echo.
echo [1/7] Checking prerequisites...

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

REM OpenCode (optional)
if defined OPENCODE_BIN (
  if exist "%OPENCODE_BIN%" (
    echo   [+] OpenCode executable found via OPENCODE_BIN: %OPENCODE_BIN%
    goto :opencode_ok
  )
)
where opencode >nul 2>nul
if %errorlevel%==0 (
  echo   [+] OpenCode is installed
  goto :opencode_ok
)
if exist "bin\opencode.exe" (
  echo   [+] OpenCode executable found at .\bin\opencode.exe
  goto :opencode_ok
)
echo   [.] OpenCode executable not found - starting without an OpenCode connection.
echo       Set the binary path later under Settings (OpenCode tab), then restart the server.
:opencode_ok

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
echo [2/7] Creating workspace directories...
if not exist "%WORKSPACE_PATH%\repos" mkdir "%WORKSPACE_PATH%\repos"
if not exist "%WORKSPACE_PATH%\.config\opencode" mkdir "%WORKSPACE_PATH%\.config\opencode"

echo.
echo [3/7] Installing dependencies (pnpm install)...
call pnpm install
if %errorlevel% neq 0 (
  echo   [x] pnpm install failed.
  exit /b 1
)

echo.
echo [4/7] Creating environment file if missing...
if not exist "%ENV_FILE%" (
  copy .env.example ".env" >nul
  echo   [+] Created .env from .env.example
) else (
  echo   [+] .env already exists
)

echo.
echo [5/7] Installing agent-browser (optional)...
where npm >nul 2>nul
if !errorlevel!==0 (
  if not defined AGENT_BROWSER_SKIP_INSTALL (
    echo   Installing/upgrading agent-browser to latest...
    call npm install -g agent-browser@latest
    if !errorlevel! neq 0 (
      echo   [x] Failed to install agent-browser. Install with: npm install -g agent-browser
    ) else (
      echo   Downloading Chrome for Testing...
      call agent-browser install
      if !errorlevel! neq 0 (
        echo   [.] agent-browser install failed - run "agent-browser install" manually
      )
    )
  ) else (
    echo   [.] Skipping agent-browser install (AGENT_BROWSER_SKIP_INSTALL is set)
  )
) else (
  echo   [.] npm is NOT installed - skipping agent-browser. Install with: npm install -g agent-browser
)

echo.
echo [6/7] Verifying runtime...
bun --version >nul 2>nul
if %errorlevel% neq 0 (
  echo   [x] bun --version failed.
  exit /b 1
)

echo.
echo [7/7] Registering default MCP servers...
call node scripts\register-default-mcp.js

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