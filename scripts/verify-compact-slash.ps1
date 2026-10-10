# verify-compact-slash.ps1 - webui chat /compact|/summarize -> opencode /summarize routing probe (dev 5001)
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/verify-compact-slash.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/verify-compact-slash.ps1 -BaseUrl http://localhost:5001 -ModelID "openai/gpt-oss-20b"
param(
  [string]$BaseUrl = "http://localhost:5001",
  [string]$ProviderID = "a",
  [string]$ModelID = "openai/gpt-oss-20b",
  [string]$TestRepoLocalPath = "test"
)
$ErrorActionPreference = "Continue"
$script:passed = 0
$script:failed = 0
$script:skipped = 0
function ok($m){ Write-Host "  [PASS] $m" -ForegroundColor Green; $script:passed++ }
function ng($m){ Write-Host "  [FAIL] $m" -ForegroundColor Red; $script:failed++ }
function sk($m){ Write-Host "  [SKIP] $m" -ForegroundColor Yellow; $script:skipped++ }
function step($m){ Write-Host "`n== $m ==" -ForegroundColor Cyan }
function Invoke-Api($M,$P,$B){
  $u="$BaseUrl$P"
  try{
    if($B -ne $null){
      $j=$B | ConvertTo-Json -Depth 8 -Compress
      return Invoke-RestMethod -Uri $u -Method $M -Body $j -ContentType "application/json" -TimeoutSec 30
    } else {
      return Invoke-RestMethod -Uri $u -Method $M -TimeoutSec 30
    }
  } catch {
    $body=""
    try{ $body=(New-Object IO.StreamReader $_.Exception.Response.GetResponseStream()).ReadToEnd() }catch{}
    throw "HTTP $M $P failed: $($_.Exception.Message) body=$body"
  }
}
function Wait-QueueEmpty($sid, $timeoutSec, $label){
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while((Get-Date) -lt $deadline){
    Start-Sleep -Seconds 5
    try{ $q = Invoke-Api GET "/api/chat-queue/$sid" } catch { return "queue-read-failed: $_" }
    $items = @($q)
    if($items.Count -eq 0){ return $null }
    $st = ($items | ForEach-Object { "$($_.kind):$($_.status)" }) -join ','
    Write-Host "    ... $label queue: $st"
    if($items | Where-Object { $_.status -eq 'failed' }){
      $bad = $items | Where-Object { $_.status -eq 'failed' } | Select-Object -First 1
      return "item failed: $($bad | ConvertTo-Json -Compress)"
    }
  }
  return "timeout after ${timeoutSec}s"
}
function Get-MessageCount($sid, $enc){
  try{
    $m = Invoke-Api GET "/api/opencode/session/$sid/message?directory=$enc"
    if($m.messages){ return $m.messages.Count }
    if($m -is [Array]){ return $m.Count }
  } catch {}
  return -1
}

step "0) Health"
try{
  $h=Invoke-Api GET "/api/health"
  if($h.status -eq "healthy"){ ok "backend healthy opencode=$($h.opencode)" } else { ng "health not healthy"; exit 1 }
} catch { ng "health failed: $_"; exit 1 }

step "1) Scratch session in repo '$TestRepoLocalPath'"
$repo=$null
try{ $repos=Invoke-Api GET "/api/repos"; $repo=$repos | Where-Object { $_.localPath -eq $TestRepoLocalPath } | Select-Object -First 1 } catch { ng "GET /api/repos failed: $_"; exit 1 }
if(-not $repo){ ng "repo '$TestRepoLocalPath' not found"; exit 1 }
$dir=$repo.fullPath
$enc=[Uri]::EscapeDataString($dir)
$sid=$null
try{
  $sess=Invoke-Api POST "/api/opencode/session?directory=$enc" @{ title="verify-compact-slash" }
  $sid=$sess.id
  if($sid){ ok "session created: $sid" } else { ng "session create no id"; exit 1 }
} catch { ng "session create failed: $_"; exit 1 }

$model=@{ providerID=$ProviderID; modelID=$ModelID }
try{
  step "2) Seed turn via queue (chat)"
  Invoke-Api POST "/api/chat-queue/$sid" @{ text="probe ping: reply with exactly the word pong"; model=$model } | Out-Null
  ok "ping enqueued"
  $err=Wait-QueueEmpty $sid 300 "ping"
  if($err){ ng "ping turn: $err"; throw "abort" }
  ok "ping turn done"
  $before=Get-MessageCount $sid $enc
  ok "messages before compact: $before"

  step "3) /compact via queue (chat text)"
  Invoke-Api POST "/api/chat-queue/$sid" @{ text="/compact"; model=$model } | Out-Null
  ok "/compact enqueued as chat text"
  $err=Wait-QueueEmpty $sid 600 "compact"
  if($err){ ng "/compact dispatch: $err"; throw "abort" }
  ok "/compact queue drained (no UnknownError, no stuck item)"

  step "4) Run history shows completed compact"
  $runs=Invoke-Api GET "/api/command-runs?sessionId=$sid"
  $list=@($runs)
  if($runs.items){ $list=@($runs.items) }
  $hit=$list | Where-Object { $_.commandName -eq 'compact' -and $_.status -eq 'completed' } | Select-Object -First 1
  if($hit){ ok "command_runs compact completed (id=$($hit.id))" } else { ng "no completed compact run: $($list | ConvertTo-Json -Depth 3 -Compress)" }

  $after=Get-MessageCount $sid $enc
  ok "messages after compact: $after (before=$before)"
} catch {
  if($_ -ne "abort"){ ng "probe flow failed: $_" }
} finally {
  try{ Invoke-Api DELETE "/api/opencode/session/$sid`?directory=$enc" | Out-Null; ok "scratch session deleted" } catch { sk "scratch cleanup failed: $_" }
}

Write-Host "`n================================" -ForegroundColor White
Write-Host "Result: PASS=$passed FAIL=$failed SKIP=$skipped" -ForegroundColor $(if($failed -gt 0){ "Red" } else { "Green" })
if($failed -gt 0){ exit 1 } else { exit 0 }
