@echo off
REM Start the Kakao bridge as a detached background daemon and RETURN IMMEDIATELY.
REM ASCII only: non-ASCII comments break the cmd code page.
REM Usage: kakao-bridge-daemon.bat [chatId] [model]
REM   e.g. kakao-bridge-daemon.bat 129784894687551 a/deepseek-ai/deepseek-v4.1-flash
REM Logs: <repo>\logs\kakao-bridge.log  (errors: ...log.err)
setlocal

set "ROOT=%~dp0.."
set "LOG=%ROOT%\logs\kakao-bridge.log"
if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"

REM Stop any previous instance first (its log handle would block the redirect).
call "%~dp0kakao-bridge-stop.bat" >nul 2>&1

REM Build the argument list as a pipe-separated string; PowerShell splits it.
set "KAKAO_ARGS=-NoProfile|-File|%ROOT%\scripts\kakao-bridge.ps1|-PollSec|8"
if not "%~1"=="" set "KAKAO_ARGS=%KAKAO_ARGS%|-ChatId|%~1"
if not "%~2"=="" set "KAKAO_ARGS=%KAKAO_ARGS%|-Model|%~2"
set "KAKAO_LOG=%LOG%"

REM Start-Process fully detaches the child, so this script returns right away.
powershell -NoProfile -Command "$a = $env:KAKAO_ARGS -split '\|'; Start-Process -FilePath 'pwsh' -ArgumentList $a -WindowStyle Hidden -RedirectStandardOutput $env:KAKAO_LOG -RedirectStandardError ($env:KAKAO_LOG + '.err')"

echo [kakao-bridge] started (detached). log: %LOG%
endlocal
