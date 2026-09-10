@echo off
REM ============================================================
REM  opencode-webui dev stack - 진짜 Windows 서비스(SCM) 등록
REM ------------------------------------------------------------
REM  Usage:
REM    install / uninstall / start / stop 은 관리자 cmd에서 실행.
REM    status 는 일반 cmd에서도 된다.
REM    scripts\register_dev_service.bat install-auto  (= install + start=auto enforce)
REM    scripts\register_dev_service.bat install [프로젝트경로]
REM    scripts\register_dev_service.bat status [프로젝트경로]
REM    scripts\register_dev_service.bat start [프로젝트경로]
REM    scripts\register_dev_service.bat stop [프로젝트경로]
REM    scripts\register_dev_service.bat uninstall [프로젝트경로]
REM
REM  프로젝트경로 생략 시 이 bat 파일 기준 상위 폴더를 사용한다.
REM  예: scripts\register_dev_service.bat install "D:\my project\webui"
REM
REM  방식: scripts\dev_service.py 를 pywin32 ServiceFramework 기반의
REM  정식 SCM 서비스로 등록한다. 외부 exe, NSSM, Task Scheduler 불필요.
REM  예전 sc.exe + cmd.exe 방식은 ServiceMain이 없어 1053으로 시작 불가.
REM  서비스는 pnpm dev 를 직접 띄우고 헬스 워치독으로 감시한다.
REM  구방식 시작프로그램 VBS가 있으면 install/uninstall 때 함께 정리한다.
REM  로그: logs\dev.log, logs\dev.err.log, logs\dev-service.log
REM
REM  주의: 이 파일은 CP949 + CRLF 로 저장해야 한다.
REM  UTF-8 BOM, LF 줄바꿈, 괄호 블록 안 echo문의 괄호는 cmd 파서를 깨뜨린다.
REM ============================================================
setlocal
if "%~2"=="" (
  for %%I in ("%~dp0..") do set "PROJECT_DIR=%%~fI"
) else (
  for %%I in ("%~2") do set "PROJECT_DIR=%%~fI"
)
for %%I in ("%PROJECT_DIR%") do set "PROJ_NAME=%%~nI"
set "SERVICE_NAME=opencode-webui-dev"
set "SVC_PY=%PROJECT_DIR%\scripts\dev_service.py"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_FILE=%STARTUP_DIR%\%PROJ_NAME%-dev.vbs"

if "%~1"=="" goto :usage
if /i "%~1"=="install" goto :install
if /i "%~1"=="install-auto" goto :install_auto
if /i "%~1"=="uninstall" goto :uninstall
if /i "%~1"=="start" goto :start
if /i "%~1"=="stop" goto :stop
if /i "%~1"=="status" goto :status
goto :usage

:check_admin
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo [SERVICE] ERROR: 관리자 권한 cmd에서 실행하세요.
  exit /b 1
)
exit /b 0

:check_project
if not exist "%PROJECT_DIR%\package.json" (
  echo [SERVICE] ERROR: 프로젝트 경로가 잘못됨: "%PROJECT_DIR%"
  exit /b 1
)
if not exist "%SVC_PY%" (
  echo [SERVICE] ERROR: dev_service.py 없음: "%SVC_PY%"
  exit /b 1
)
exit /b 0

:check_python
where python >nul 2>&1
if errorlevel 1 (
  echo [SERVICE] ERROR: python을 찾을 수 없음. Python 3.12 + pywin32 필요.
  exit /b 1
)
python -c "import win32service, win32serviceutil" >nul 2>&1
if errorlevel 1 (
  echo [SERVICE] ERROR: pywin32이 없음. pip install pywin32 후 재시도.
  exit /b 1
)
exit /b 0

:install_auto
call :install
if %errorlevel% neq 0 exit /b 1
sc.exe config "%SERVICE_NAME%" start= auto >nul 2>&1
echo [SERVICE] start mode enforced: auto (service will start on boot)
sc.exe qc "%SERVICE_NAME%" | findstr /i "START_TYPE" 
exit /b 0

:install
call :check_admin
if %errorlevel% neq 0 exit /b 1
call :check_project
if %errorlevel% neq 0 exit /b 1
call :check_python
if %errorlevel% neq 0 exit /b 1
echo [SERVICE] 프로젝트: "%PROJECT_DIR%"
echo [SERVICE] 서비스 등록 중...
python "%SVC_PY%" install
sc.exe query "%SERVICE_NAME%" >nul 2>&1
if errorlevel 1 (
  echo [SERVICE] ERROR: 서비스 등록 실패. 위 메시지를 확인하세요.
  exit /b 1
)
sc.exe failure "%SERVICE_NAME%" reset= 86400 actions= restart/60000/restart/60000/restart/60000 >nul 2>&1
if exist "%VBS_FILE%" del /f /q "%VBS_FILE%" >nul 2>&1
echo [SERVICE] 등록 완료. 서비스를 시작합니다...
sc.exe start "%SERVICE_NAME%" >nul 2>&1
call :wait_healthy
exit /b %errorlevel%

:start
call :check_admin
if %errorlevel% neq 0 exit /b 1
sc.exe start "%SERVICE_NAME%" >nul 2>&1
call :wait_healthy
exit /b %errorlevel%

:stop
call :check_admin
if %errorlevel% neq 0 exit /b 1
echo [SERVICE] 서비스 중지 중...
sc.exe stop "%SERVICE_NAME%" >nul 2>&1
timeout /t 5 /nobreak >nul
sc.exe query "%SERVICE_NAME%"
exit /b %errorlevel%

:status
sc.exe query "%SERVICE_NAME%"
echo.
echo [SERVICE] 헬스 체크: 5001 /api/health
curl -sf -m 3 "http://127.0.0.1:5001/api/health" >nul 2>&1
if not errorlevel 1 (
  echo [SERVICE] RUNNING - backend 5001 응답
  exit /b 0
)
curl -sf -m 3 "http://127.0.0.1:5173/" >nul 2>&1
if not errorlevel 1 (
  echo [SERVICE] PARTIAL - vite 5173만 응답, backend 5001 무응답
  exit /b 1
)
echo [SERVICE] NOT RUNNING - 헬스 무응답
exit /b 1

:uninstall
call :check_admin
if %errorlevel% neq 0 exit /b 1
echo [SERVICE] 서비스 중지 및 삭제: %SERVICE_NAME%
sc.exe stop "%SERVICE_NAME%" >nul 2>&1
timeout /t 5 /nobreak >nul
sc.exe delete "%SERVICE_NAME%"
if exist "%VBS_FILE%" del /f /q "%VBS_FILE%" >nul 2>&1
echo [SERVICE] 해제 완료.
exit /b 0

:wait_healthy
set /a TRIES=0
:wait_loop
curl -sf -m 3 "http://127.0.0.1:5001/api/health" >nul 2>&1
if not errorlevel 1 (
  echo [SERVICE] RUNNING - backend 5001 응답
  exit /b 0
)
set /a TRIES+=1
if %TRIES% GEQ 40 (
  echo [SERVICE] WARN: 120초 내 backend 무응답. logs\dev-service.log 를 확인하세요.
  exit /b 2
)
timeout /t 3 /nobreak >nul
goto :wait_loop

:usage
echo Usage:
echo   관리자 cmd: install / uninstall / start / stop, 일반 cmd: status
echo   scripts\register_dev_service.bat install-auto  (auto-start enforced)
echo   scripts\register_dev_service.bat install ["D:\path\to\project"]
echo   scripts\register_dev_service.bat status ["D:\path\to\project"]
echo   scripts\register_dev_service.bat start ["D:\path\to\project"]
echo   scripts\register_dev_service.bat stop ["D:\path\to\project"]
echo   scripts\register_dev_service.bat uninstall ["D:\path\to\project"]
exit /b 1
