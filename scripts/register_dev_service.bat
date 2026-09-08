@echo off
REM ============================================================
REM  opencode-webui dev stack - Windows 자동시작 등록
REM ------------------------------------------------------------
REM  Usage (관리자 권한 불필요, 일반 cmd에서 실행):
REM    scripts\register_dev_service.bat install [프로젝트경로]   - 시작프로그램 등록 + 지금 시작
REM    scripts\register_dev_service.bat start [프로젝트경로]     - 지금 시작 (start_dev.bat)
REM    scripts\register_dev_service.bat stop [프로젝트경로]      - 중지 (stop_dev.bat)
REM    scripts\register_dev_service.bat status [프로젝트경로]    - 등록 상태 + 헬스 + 로그 tail
REM    scripts\register_dev_service.bat uninstall [프로젝트경로] - 시작프로그램 해제 + 중지
REM
REM  프로젝트경로 생략 시 이 bat 파일 기준 상위 폴더(=프로젝트 루트) 사용.
REM  예: scripts\register_dev_service.bat install "D:\my project\webui"
REM
REM  방식: 사용자 시작프로그램 폴더에 hidden VBS 등록 (로그온 시 자동실행).
REM  VBS 파일명: 프로젝트폴더명-dev.vbs (프로젝트마다 따로 등록 가능).
REM  이유: sc.exe + cmd.exe 조합은 서비스 프로토콜이 없어 1053 오류로
REM  시작할 수 없다. 외부 exe 없이 내장 기능만으로 동작하는 방식이
REM  시작프로그램 등록이다. Task Scheduler는 사용하지 않음.
REM  실제 구동은 scripts\start_dev.bat (hidden pnpm dev + 헬스체크)를 재사용.
REM  로그: logs\dev.log / logs\dev.err.log, pid: logs\dev.pid
REM
REM  주의: 이 파일은 CP949 + CRLF 로 저장해야 한다. UTF-8 BOM/LF 로
REM  저장하면 cmd.exe 파서가 깨져 오동작한다.
REM ============================================================
setlocal
if "%~2"=="" (
  for %%I in ("%~dp0..") do set "PROJECT_DIR=%%~fI"
) else (
  for %%I in ("%~2") do set "PROJECT_DIR=%%~fI"
)
for %%I in ("%PROJECT_DIR%") do set "PROJ_NAME=%%~nI"
set "SERVICE_NAME=%PROJ_NAME%-dev"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_FILE=%STARTUP_DIR%\%SERVICE_NAME%.vbs"

if "%~1"=="" goto :usage
if /i "%~1"=="install" goto :install
if /i "%~1"=="uninstall" goto :uninstall
if /i "%~1"=="start" goto :start
if /i "%~1"=="stop" goto :stop
if /i "%~1"=="status" goto :status
goto :usage

:check_project
if not exist "%PROJECT_DIR%\package.json" (
  echo [SERVICE] ERROR: 프로젝트 경로가 잘못됨: "%PROJECT_DIR%"
  echo [SERVICE] HINT: package.json이 있는 폴더를 지정하세요.
  exit /b 1
)
if not exist "%PROJECT_DIR%\scripts\start_dev.bat" (
  echo [SERVICE] ERROR: start_dev.bat 없음: "%PROJECT_DIR%\scripts\start_dev.bat"
  exit /b 1
)
exit /b 0

:install
call :check_project
if %errorlevel% neq 0 exit /b 1
if not exist "%PROJECT_DIR%\logs" mkdir "%PROJECT_DIR%\logs" >nul 2>&1

REM 구방식(sc 서비스) 잔재 정리 - 관리자 아닐 수 있으니 실패해도 계속
sc query "%SERVICE_NAME%" >nul 2>&1
if %errorlevel% equ 0 (
  echo [SERVICE] 구방식 sc 서비스 발견 - 삭제 시도합니다.
  sc stop "%SERVICE_NAME%" >nul 2>&1
  timeout /t 2 /nobreak >nul
  sc delete "%SERVICE_NAME%" >nul 2>&1
  if errorlevel 1 (
    echo [SERVICE] WARN: sc 삭제 실패 - 관리자 권한 필요. 시작프로그램 등록은 계속합니다.
  ) else (
    echo [SERVICE] 구방식 sc 서비스 삭제 완료.
  )
)

if not exist "%STARTUP_DIR%" mkdir "%STARTUP_DIR%" >nul 2>&1
echo [SERVICE] 프로젝트: "%PROJECT_DIR%"
echo [SERVICE] 시작프로그램 등록: "%VBS_FILE%"
REM 주의: 괄호 블록 안의 echo 문장에 있는 괄호는 꼭 ^ 로 이스케이프
(
echo Set sh = CreateObject^("WScript.Shell"^)
echo sh.Run^ "cmd /c ""%PROJECT_DIR%\scripts\start_dev.bat"""^, 0, False
) > "%VBS_FILE%"
if not exist "%VBS_FILE%" (
  echo [SERVICE] ERROR: VBS 생성 실패
  exit /b 1
)
echo [SERVICE] 등록 완료 - Windows 로그온 시 자동실행, 창 숨김.
echo [SERVICE] 지금 시작합니다...
call :start_now
exit /b %errorlevel%

:start
call :check_project
if %errorlevel% neq 0 exit /b 1
call :start_now
exit /b %errorlevel%

:start_now
call "%PROJECT_DIR%\scripts\start_dev.bat"
exit /b %errorlevel%

:stop
call :check_project
if %errorlevel% neq 0 exit /b 1
call "%PROJECT_DIR%\scripts\stop_dev.bat"
exit /b %errorlevel%

:status
call :check_project
if %errorlevel% neq 0 exit /b 1
if exist "%VBS_FILE%" (
  echo [SERVICE] 시작프로그램 등록됨: "%VBS_FILE%"
) else (
  echo [SERVICE] 시작프로그램 미등록 - install 필요
)
echo.
echo [SERVICE] 헬스 체크: 5002 / 5001 /api/health
curl -sf -m 3 "http://127.0.0.1:5002/api/health" >nul 2>&1
if not errorlevel 1 (
  echo [SERVICE] RUNNING - backend 5002 응답
) else (
  curl -sf -m 3 "http://127.0.0.1:5001/api/health" >nul 2>&1
  if not errorlevel 1 (
    echo [SERVICE] RUNNING - backend 5001 응답
  ) else (
    echo [SERVICE] NOT RUNNING - 헬스 무응답
  )
)
echo.
if exist "%PROJECT_DIR%\logs\dev.log" (
  echo [SERVICE] 로그 tail - logs\dev.log 마지막 30줄:
  powershell -NoProfile -Command "Get-Content -LiteralPath '%PROJECT_DIR%\logs\dev.log' -Tail 30"
) else (
  echo [SERVICE] 로그 아직 없음: "%PROJECT_DIR%\logs\dev.log"
)
exit /b 0

:uninstall
call :check_project
if %errorlevel% neq 0 exit /b 1
echo [SERVICE] 시작프로그램 해제: "%VBS_FILE%"
if exist "%VBS_FILE%" del /f /q "%VBS_FILE%" >nul 2>&1
echo [SERVICE] dev 프로세스 중지...
call "%PROJECT_DIR%\scripts\stop_dev.bat" >nul 2>&1
sc query "%SERVICE_NAME%" >nul 2>&1
if %errorlevel% equ 0 (
  echo [SERVICE] 구방식 sc 서비스 잔재 삭제 시도...
  sc stop "%SERVICE_NAME%" >nul 2>&1
  timeout /t 2 /nobreak >nul
  sc delete "%SERVICE_NAME%" >nul 2>&1
)
echo [SERVICE] 해제 완료.
exit /b 0

:usage
echo Usage - 일반 cmd, 프로젝트경로 생략 시 bat 기준 상위 폴더:
echo   scripts\register_dev_service.bat install ["D:\path\to\project"]   - 시작프로그램 등록 + 지금 시작
echo   scripts\register_dev_service.bat status ["D:\path\to\project"]    - 등록 상태 + 헬스 + 로그 tail
echo   scripts\register_dev_service.bat start ["D:\path\to\project"]     - 지금 시작
echo   scripts\register_dev_service.bat stop ["D:\path\to\project"]      - 중지
echo   scripts\register_dev_service.bat uninstall ["D:\path\to\project"] - 시작프로그램 해제 + 중지
exit /b 1
