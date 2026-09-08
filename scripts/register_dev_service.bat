@echo off
REM ============================================================
REM  opencode-webui dev stack - Windows Service (sc.exe) register
REM ------------------------------------------------------------
REM  Usage (Admin cmd required):
REM    scripts\register_dev_service.bat install   - create + auto-start service
REM    scripts\register_dev_service.bat start     - sc start
REM    scripts\register_dev_service.bat stop      - sc stop
REM    scripts\register_dev_service.bat status    - sc query
REM    scripts\register_dev_service.bat uninstall - stop + delete
REM
REM  What it does:
REM    sc create opencode-webui-dev binPath= "cmd.exe /c ..." start= auto
REM    PROJECT_DIR에서 백그라운드로 "npm run dev" 실행 (logs\dev-service.log 기록)
REM    시작 유형 auto = 윈도우 부팅(시작)마다 자동 실행
REM
REM  NOTE:
REM    Windows 내장 sc.exe + cmd.exe만 사용 (외부 exe/NSSM/WinSW 불필요).
REM    start= auto 라 부팅(시작)마다 자동 실행.
REM    참고: cmd.exe는 서비스 프로토콜을 구현하지 않아 환경에 따라
REM    sc start 시 1053이 날 수 있음. 그 경우 status로 등록 상태 확인 후
REM    start 재시도 또는 로그(logs\dev-service.log) 확인.
REM ============================================================
setlocal

set SERVICE_NAME=opencode-webui-dev
set PROJECT_DIR=C:\Users\oh\Documents\Default Project\opencode-webui
set LOG_FILE=%PROJECT_DIR%\logs\dev-service.log
set CMD_EXE=%SystemRoot%\System32\cmd.exe

if "%~1"=="" goto :usage
if /i "%~1"=="install" goto :install
if /i "%~1"=="uninstall" goto :uninstall
if /i "%~1"=="start" goto :start
if /i "%~1"=="stop" goto :stop
if /i "%~1"=="status" goto :status
goto :usage

:check_admin
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo [SERVICE] ERROR: 관리자 권한 cmd에서 실행하세요. (우클릭 - 관리자 권한으로 실행^)
  exit /b 1
)
exit /b 0

:install
call :check_admin
if %errorlevel% neq 0 exit /b 1

if not exist "%PROJECT_DIR%\package.json" (
  echo [SERVICE] ERROR: PROJECT_DIR이 잘못됨: "%PROJECT_DIR%"
  exit /b 1
)
if not exist "%PROJECT_DIR%\logs" mkdir "%PROJECT_DIR%\logs"

echo [SERVICE] 기존 서비스 확인/정리: %SERVICE_NAME%
sc query "%SERVICE_NAME%" >nul 2>&1
if %errorlevel% equ 0 (
  echo [SERVICE] 기존 서비스 발견 - 중지 후 삭제합니다.
  sc stop "%SERVICE_NAME%" >nul 2>&1
  timeout /t 2 /nobreak >nul
  sc delete "%SERVICE_NAME%" >nul 2>&1
  timeout /t 2 /nobreak >nul
)

echo [SERVICE] 등록 중...
echo [SERVICE] PROJECT_DIR: %PROJECT_DIR%
echo [SERVICE] LOG_FILE   : %LOG_FILE%

REM binPath는 cmd.exe /c 로 백그라운드 실행. start= auto 로 부팅마다 자동시작.
REM sc 문법 주의: "binPath=" 와 "start=" 뒤에 공백 필수.
sc create "%SERVICE_NAME%" binPath= "%CMD_EXE% /c cd /d \"%PROJECT_DIR%\" ^& npm run dev ^>^> \"%LOG_FILE%\" 2^>^&1" DisplayName= "opencode-webui dev (npm run dev)" start= auto
if %errorlevel% neq 0 (
  echo [SERVICE] ERROR: sc create 실패 (code %errorlevel%^)
  exit /b 1
)

REM 실패 시 자동 재시작 (1분 간격 3회) + 설명
sc failure "%SERVICE_NAME%" reset= 86400 actions= restart/60000/restart/60000/restart/60000 >nul 2>&1
sc description "%SERVICE_NAME%" "opencode-webui dev stack (cmd.exe /c npm run dev). Logs: logs\dev-service.log." >nul 2>&1

echo [SERVICE] 등록 완료. 서비스를 시작합니다...
sc start "%SERVICE_NAME%"
if %errorlevel% neq 0 (
  echo.
  echo [SERVICE] WARN: sc start 실패 (code %errorlevel%^). 1053이면 cmd.exe 특성상 날 수 있음.
  echo [SERVICE] WARN: 상태 확인: sc query "%SERVICE_NAME%"
  echo [SERVICE] WARN: 로그 확인: "%LOG_FILE%"
  exit /b 2
)

echo [SERVICE] 시작됨. 로그: "%LOG_FILE%"
echo [SERVICE] 상태: sc query "%SERVICE_NAME%"
sc query "%SERVICE_NAME%"
exit /b 0

:start
call :check_admin
if %errorlevel% neq 0 exit /b 1
sc start "%SERVICE_NAME%"
exit /b %errorlevel%

:stop
call :check_admin
if %errorlevel% neq 0 exit /b 1
sc stop "%SERVICE_NAME%"
exit /b %errorlevel%

:status
sc query "%SERVICE_NAME%"
echo.
if exist "%LOG_FILE%" (
  echo [SERVICE] 로그: "%LOG_FILE%"
  type "%LOG_FILE%"
) else (
  echo [SERVICE] 로그 아직 없음: "%LOG_FILE%"
)
exit /b 0

:uninstall
call :check_admin
if %errorlevel% neq 0 exit /b 1
echo [SERVICE] 중지 후 삭제: %SERVICE_NAME%
sc stop "%SERVICE_NAME%" >nul 2>&1
timeout /t 2 /nobreak >nul
sc delete "%SERVICE_NAME%"
if %errorlevel% equ 0 (
  echo [SERVICE] 삭제 완료.
) else (
  echo [SERVICE] 삭제 실패 또는 서비스 없음 (code %errorlevel%^)
)
exit /b %errorlevel%

:usage
echo Usage (관리자 cmd^):
echo   scripts\register_dev_service.bat install   - 등록 + 자동시작(auto^) + 시작
echo   scripts\register_dev_service.bat status    - 상태 + 로그 tail
echo   scripts\register_dev_service.bat start     - 시작
echo   scripts\register_dev_service.bat stop      - 중지
echo   scripts\register_dev_service.bat uninstall - 중지 + 삭제
exit /b 1
