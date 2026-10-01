@echo off
REM Kakao bridge TUI (interactive console, runs in this window).
REM ASCII only: non-ASCII comments break the cmd code page.
REM Usage: kakao-tui.bat [backend] [repoId]
REM   e.g. kakao-tui.bat http://127.0.0.1:5001 1
setlocal

set "PSARGS=-NoProfile -File \"%~dp0kakao-tui.ps1\""
if not "%~1"=="" set "PSARGS=%PSARGS% -Backend %~1"
if not "%~2"=="" set "PSARGS=%PSARGS% -RepoId %~2"

powershell %PSARGS%
endlocal
