#Requires -Version 5.1
<#
.SYNOPSIS
  Foreground runner for `pnpm dev` (backend + frontend), meant for Task Scheduler.

.DESCRIPTION
  Unlike scripts\start_dev.bat (which spawns a detached process and exits),
  this script stays alive as long as the dev stack runs, so Task Scheduler
  (or any supervisor) can track it, restart it on failure, and stop it.

  - Cleans stale processes/ports first (reuses stop_dev.bat).
  - Starts `pnpm dev` as a child, waits for it, exits with its exit code.
  - Child stdout/stderr go to logs\dev-task.log / logs\dev-task.err.log.
  - Runner milestones go to logs\dev-task.status (and console, for manual runs).

  Manual test:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev_task_run.ps1
  Stop a manual run with Ctrl+C, then run scripts\stop_dev.bat to clean children.

.NOTES
  Why not a Windows service (sc.exe)? The Service Control Manager requires
  the started process to implement the service protocol (answer start/stop
  control codes). A .bat/.ps1 script cannot do that, so `sc start` always
  fails with error 1053. Task Scheduler is the supported native path.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $root

$logsDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
$outLog = Join-Path $logsDir 'dev-task.log'
$errLog = Join-Path $logsDir 'dev-task.err.log'
$statusFile = Join-Path $logsDir 'dev-task.status'

function Write-Status([string]$message) {
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $message"
  Write-Host $line
  try { Add-Content -LiteralPath $statusFile -Value $line -Encoding UTF8 } catch {}
}

try { Remove-Item -LiteralPath $statusFile -Force -ErrorAction SilentlyContinue } catch {}
Write-Status "[DEV TASK] root: $root"
Write-Status "[DEV TASK] user: $env:USERDOMAIN\$env:USERNAME"

foreach ($tool in @('pnpm', 'bun', 'node')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Write-Status "[DEV TASK] ERROR: '$tool' not found in PATH for this user. Aborting (exit 1)."
    exit 1
  }
}

Write-Status '[DEV TASK] cleaning stale dev processes/ports (stop_dev.bat)...'
& (Join-Path $PSScriptRoot 'stop_dev.bat') > $null 2>&1

Write-Status "[DEV TASK] starting child: cmd /c pnpm dev (log: $outLog)"
$child = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', 'pnpm dev') `
  -WorkingDirectory $root -NoNewWindow `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
Write-Status "[DEV TASK] child pid: $($child.Id)"

# Startup health gate — informational only. Never exit here: the stack may
# still be booting (vite first compile), and crash-restart is the scheduler's job.
$healthyPort = $null
for ($i = 0; $i -lt 60 -and -not $child.HasExited; $i++) {
  Start-Sleep -Seconds 2
  foreach ($port in @(5001, 5002)) {
    try {
      $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 3 -UseBasicParsing
      if ($resp.StatusCode -eq 200) { $healthyPort = $port; break }
    } catch {}
  }
  if ($healthyPort) { break }
}
if ($healthyPort) {
  Write-Status "[DEV TASK] healthy on port $healthyPort"
} elseif ($child.HasExited) {
  Write-Status "[DEV TASK] child already exited during boot (code $($child.ExitCode))"
} else {
  Write-Status '[DEV TASK] WARN: health not confirmed within ~120s; still supervising child.'
}

$child.WaitForExit()
Write-Status "[DEV TASK] child exited with code $($child.ExitCode). Scheduler restart policy applies on non-zero."
exit $child.ExitCode
