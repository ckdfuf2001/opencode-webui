@echo off
setlocal enabledelayedexpansion

set "WORKSPACE_PATH=.\workspace"
set "ENV_FILE=.env"

echo ==========================================
echo  OpenCode WebUI - Dev Environment Setup
echo ==========================================
echo.
echo [1/7] Checking prerequisites...

REM Python
where python >nul 2>nul
if %errorlevel%==0 (
  python -c "import sys;print^(sys.executable^)" > "%TEMP%\opencode-python-path.txt" 2>nul
  set /p PYTHON_REAL=<"%TEMP%\opencode-python-path.txt"
  echo "%PYTHON_REAL%" | findstr /i "WindowsApps" >nul
  if not errorlevel 1 (
    echo   [x] Python resolves to the Microsoft Store stub (WindowsApps^).
    echo       Install a real Python from https://www.python.org/downloads/
    echo       and check "Add python.exe to PATH", then re-run this script.
    exit /b 1
  )
  echo   [+] Python is installed: %PYTHON_REAL%
) else (
  echo   [x] Python is NOT installed.
  echo       Install it from: https://www.python.org/downloads/
  echo       and check "Add python.exe to PATH", then re-run this script.
  exit /b 1
)

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

REM Install the domain guide (AGENTS.md) into the workspace if missing
if not exist "%WORKSPACE_PATH%\AGENTS.md" goto :agent_guide_missing
echo   [+] workspace\AGENTS.md already present
goto :agent_guide_done
:agent_guide_missing
if not exist "docs\agent-domain-guide.md" goto :agent_guide_none
copy "docs\agent-domain-guide.md" "%WORKSPACE_PATH%\AGENTS.md" >nul
echo   [+] Installed domain guide as workspace\AGENTS.md
goto :agent_guide_done
:agent_guide_none
echo   [.] Domain guide not found (docs\agent-domain-guide.md) - continuing.
:agent_guide_done

REM Install the domain guide as a global rules file (applies to every session)
if not exist "%WORKSPACE_PATH%\.config\opencode\AGENTS.md" goto :global_agent_missing
echo   [+] workspace\.config\opencode\AGENTS.md already present
goto :global_agent_done
:global_agent_missing
if not exist "docs\agent-domain-guide.md" goto :global_agent_none
copy "docs\agent-domain-guide.md" "%WORKSPACE_PATH%\.config\opencode\AGENTS.md" >nul
echo   [+] Installed domain guide as global rules (workspace\.config\opencode\AGENTS.md)
goto :global_agent_done
:global_agent_none
echo   [.] Domain guide not found (docs\agent-domain-guide.md) - continuing.
:global_agent_done

echo.
echo [3/7] Installing dependencies (pnpm install)...
call pnpm install
if %errorlevel% neq 0 (
  echo   [x] pnpm install failed.
  exit /b 1
)

echo.
echo [4/7] Installing Python conversion dependencies...
python -m pip install -r backend\requirements.txt
if %errorlevel% neq 0 (
  echo   [x] pip install failed. Run it manually:
  echo       python -m pip install -r backend\requirements.txt
  exit /b 1
)

echo.
echo [5/7] Creating environment file if missing...
if not exist "%ENV_FILE%" (
  copy .env.example ".env" >nul
  echo   [+] Created .env from .env.example
) else (
  echo   [+] .env already exists
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
call node scripts\install-agent-browser.js
if %errorlevel% neq 0 (
  echo   [x] agent-browser setup failed. Continue? (or run: npm run agent-browser:install)
)
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