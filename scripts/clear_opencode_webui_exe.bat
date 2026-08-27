@echo off
setlocal
cd /d "%~dp0"

call "%~dp0stop_opencode_webui_exe.bat"

if /i "%~1"=="all" (
  echo [CLEAR] removing workspace ENTIRELY - repos and unpushed work will be LOST!
  rmdir /s /q workspace
) else (
  echo [CLEAR] removing runtime state: logs, data, config cache...
  rmdir /s /q logs
  rmdir /s /q data
  rmdir /s /q workspace\.config
  echo [CLEAR] workspace\repos preserved. Use "clear all" to wipe repos too.
)
echo [CLEAR] done.
endlocal
