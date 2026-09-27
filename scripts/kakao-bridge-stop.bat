@echo off
REM Stops the Kakao bridge daemon (kills pwsh running kakao-bridge.ps1).
REM ASCII only: non-ASCII comments break the cmd code page.
setlocal
echo [kakao-bridge] stopping...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'kakao-bridge\.ps1' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null; Write-Host ('killed PID ' + $_.ProcessId) }"
echo [kakao-bridge] done.
endlocal
