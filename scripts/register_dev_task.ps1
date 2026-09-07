#Requires -Version 5.1
<#
.SYNOPSIS
  Registers the opencode-webui dev stack as a Windows Scheduled Task (logon auto-start).

.DESCRIPTION
  Why a scheduled task and not a Windows service (sc.exe)?
  The Service Control Manager requires the started process to implement the
  service protocol (answer start/stop control codes). A .bat/.ps1 script
  cannot do that, so `sc start` always fails with error 1053
  ("service did not respond in a timely fashion"). Task Scheduler is the
  supported native way to auto-start dev servers.

  Defaults: current user, at logon ("run only when logged on", no password
  needed), hidden window, auto-restart on crash (3 times, 1 minute apart),
  effectively no time limit (365 days). Runs with the user's own PATH/env,
  so pnpm/bun/node resolve exactly like in an interactive terminal.

.EXAMPLE
  # register (run as the dev user; admin not required)
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register_dev_task.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register_dev_task.ps1 -Status
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register_dev_task.ps1 -RunNow
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register_dev_task.ps1 -Unregister
#>
[CmdletBinding(DefaultParameterSetName = 'Register')]
param(
  [Parameter(ParameterSetName = 'Unregister', Mandatory = $true)]
  [switch]$Unregister,
  [Parameter(ParameterSetName = 'Status', Mandatory = $true)]
  [switch]$Status,
  [Parameter(ParameterSetName = 'RunNow', Mandatory = $true)]
  [switch]$RunNow,
  [string]$TaskName = 'opencode-webui-dev',
  [string]$UserId = ("$env:USERDOMAIN\$env:USERNAME")
)

$ErrorActionPreference = 'Stop'
Import-Module ScheduledTasks -ErrorAction Stop
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runner = Join-Path $PSScriptRoot 'dev_task_run.ps1'
if (-not (Test-Path -LiteralPath $runner)) { throw "Runner not found: $runner" }

function Get-DevTask {
  try { return Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
  catch { return $null }
}

if ($Unregister) {
  $t = Get-DevTask
  if ($t) {
    try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "[DEV TASK] unregistered '$TaskName'."
  } else {
    Write-Host "[DEV TASK] no task named '$TaskName'."
  }
  Write-Host '[DEV TASK] stopping leftover dev processes (stop_dev.bat)...'
  & (Join-Path $PSScriptRoot 'stop_dev.bat')
  return
}

if ($Status) {
  $t = Get-DevTask
  if (-not $t) { Write-Host "[DEV TASK] no task named '$TaskName'."; return }
  $t | Format-List TaskName, State, Author, Description | Out-String | Write-Host
  Get-ScheduledTaskInfo -TaskName $TaskName | Format-List LastRunTime, LastTaskResult, NextRunTime, NumberOfMissedRuns | Out-String | Write-Host
  return
}

if ($RunNow) {
  $t = Get-DevTask
  if (-not $t) { throw "Task '$TaskName' is not registered. Register first (run without switches)." }
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "[DEV TASK] started '$TaskName'. Logs: $root\logs\dev-task.log"
  return
}

# ---- Register ----
if (Get-DevTask) { throw "Task '$TaskName' already exists. Use -Status / -Unregister first (will not overwrite)." }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$runLevel = if ($isAdmin) { 'Highest' } else { 'Limited' }
Write-Host "[DEV TASK] registering '$TaskName' as $UserId (run level: $runLevel, trigger: logon)..."

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File `"$runner`"" `
  -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel $runLevel
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 365) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description 'opencode-webui dev stack (pnpm dev: backend 5001 + vite 5173). Logs: <root>\logs\dev-task.log' `
  -Force | Out-Null
Write-Host "[DEV TASK] registered. Test now: scripts\register_dev_task.ps1 -RunNow"
Write-Host '[DEV TASK] Health: http://127.0.0.1:5001/api/health and http://127.0.0.1:5173/'
Write-Host '[DEV TASK] NOTE: a .bat cannot be a Windows service (error 1053) — Task Scheduler is the supported path.'
