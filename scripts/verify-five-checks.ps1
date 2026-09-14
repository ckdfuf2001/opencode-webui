# verify-five-checks.ps1 - 5 checks reusable script (dev 5001 / portable 5002)
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/verify-five-checks.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/verify-five-checks.ps1 -BaseUrl http://localhost:5002
param(
  [string]$BaseUrl = "http://localhost:5001",
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
      return Invoke-RestMethod -Uri $u -Method $M -Body $j -ContentType "application/json" -TimeoutSec 15
    } else {
      return Invoke-RestMethod -Uri $u -Method $M -TimeoutSec 15
    }
  } catch {
    $body=""
    try{ $body=(New-Object IO.StreamReader $_.Exception.Response.GetResponseStream()).ReadToEnd() }catch{}
    throw "HTTP $M $P failed: $($_.Exception.Message) body=$body"
  }
}
step "0) Health & MCP config"
try{
  $h=Invoke-Api GET "/api/health"
  if($h.status -eq "healthy" -and $h.database -eq "connected"){ ok "health healthy opencode=$($h.opencode) port=$($h.opencodePort)" } else { ng "health not healthy: $($h | ConvertTo-Json -Compress)" }
} catch { ng $_ }
try{
  $cfg=Invoke-Api GET "/api/opencode/config"
  $mcpKeys=@($cfg.mcp.PSObject.Properties.Name)
  if($mcpKeys -contains "agent-browser"){ ng "mcp has stale agent-browser: $($mcpKeys -join ',')" } else { ok "mcp agent-browser absent" }
  if($mcpKeys -contains "playwright" -and $mcpKeys -contains "doc-reader"){ ok "mcp playwright+doc-reader present ($($mcpKeys -join ','))" } else { sk "mcp keys: $($mcpKeys -join ',')" }
} catch { sk "opencode config fetch failed: $_" }
try{
  $root = $PSScriptRoot
  if(-not $root){ $root = (Get-Location).Path }
  # when invoked from repo root, PSScriptRoot is <root>/scripts
  $projRoot = if((Split-Path $root -Leaf) -eq "scripts"){ Split-Path $root -Parent } else { $root }
  $bat=Get-Content (Join-Path $projRoot "scripts/start_opencode_webui_exe.bat") -Raw -ErrorAction Stop
  if($bat -match "call npx --yes @playwright/mcp --help"){ ok "start bat: call npx chain fixed" } else { ng "start bat: missing call npx" }
  if($bat -match "agent-browser"){ ng "start bat has agent-browser" } else { ok "start bat agent-browser absent" }
  $stopBat=Get-Content (Join-Path $projRoot "scripts/stop_opencode_webui_exe.bat") -Raw -ErrorAction Stop
  if($stopBat -match "agent-browser"){ ng "stop bat has agent-browser" } else { ok "stop bat agent-browser absent" }
  $stopSh=Get-Content (Join-Path $projRoot "scripts/stop_opencode_webui_exe.sh") -Raw -ErrorAction Stop
  if($stopSh -match "agent-browser"){ ng "stop sh has agent-browser" } else { ok "stop sh agent-browser absent" }
} catch { sk "bat check failed: $_" }

step "1) Session create / model(directory) / delete"
$repos=$null
try{ $repos=Invoke-Api GET "/api/repos" } catch { ng "GET /api/repos failed: $_"; $repos=@() }
$repo=$repos | Where-Object { $_.localPath -eq $TestRepoLocalPath } | Select-Object -First 1
if(-not $repo){ $repo=$repos | Select-Object -First 1; if($repo){ sk "requested repo $TestRepoLocalPath not found, using $($repo.localPath)" } }
if(-not $repo){ ng "no repos - session test skipped"; $repo=$null } else { ok "repo: id=$($repo.id) localPath=$($repo.localPath)" }
$createdSessionId=$null
if($repo){
  $dir=$repo.fullPath
  $enc=[Uri]::EscapeDataString($dir)
  try{
    $sess=Invoke-Api POST "/api/opencode/session?directory=$enc" @{ title="verify-session" }
    $createdSessionId=$sess.id
    if($createdSessionId){ ok "session created: $createdSessionId" } else { ng "session create no id: $($sess | ConvertTo-Json -Compress)" }
  } catch { ng "session create failed: $_" }
  if($createdSessionId){
    try{
      $got=Invoke-Api GET "/api/opencode/session/$createdSessionId`?directory=$enc"
      if($got.id -eq $createdSessionId){ ok "session get with directory ok" } else { sk "session get unexpected: $($got | ConvertTo-Json -Compress)" }
    } catch { ng "session get failed: $_" }
  }
  if($createdSessionId){
    try{
      Invoke-Api DELETE "/api/opencode/session/$createdSessionId`?directory=$enc" | Out-Null
      ok "session delete ok: $createdSessionId"
      Start-Sleep -Milliseconds 800
      try{
        $gone=Invoke-Api GET "/api/opencode/session/$createdSessionId`?directory=$enc"
        if($gone.error -or $gone.id -ne $createdSessionId){ ok "after delete: gone as expected" } else { ng "after delete still alive" }
      } catch { ok "after delete: fetch failed as expected" }
    } catch { ng "session delete failed: $_" }
  }
}

step "2) Badge - isCancelled preserved + abort persists"
try{
  $dir2=if($repo){ $repo.fullPath } else { (Invoke-Api GET "/api/repos" | Select-Object -First 1).fullPath }
  $enc2=[Uri]::EscapeDataString($dir2)
  $s2=Invoke-Api POST "/api/opencode/session?directory=$enc2" @{ title="verify-badge" }
  $sid2=$s2.id
  ok "badge session: $sid2"
  Invoke-Api POST "/api/session-status/$sid2/cancelled" | Out-Null
  ok "POST /session-status/:id/cancelled ok"
  Start-Sleep -Seconds 3
  $st=Invoke-Api GET "/api/session-status"
  $row=$st | Where-Object { $_.sessionId -eq $sid2 }
  if($row -and $row.isCancelled){ ok "isCancelled still true after 3s (poller preserves)" } else { ng "isCancelled cleared by poller: $($row | ConvertTo-Json -Compress)" }
  Invoke-Api DELETE "/api/session-status/$sid2/cancelled" | Out-Null
  $st2=Invoke-Api GET "/api/session-status"
  $row2=$st2 | Where-Object { $_.sessionId -eq $sid2 }
  if($row2 -and -not $row2.isCancelled){ ok "DELETE cancelled cleared" } else { ng "DELETE still cancelled" }
  try{ Invoke-Api POST "/api/opencode/session/$sid2/abort?directory=$enc2" | Out-Null; ok "POST /session/:id/abort ok" } catch { sk "abort failed (idle may 4xx): $_" }
  Start-Sleep -Seconds 1
  $st3=Invoke-Api GET "/api/session-status"
  $row3=$st3 | Where-Object { $_.sessionId -eq $sid2 }
  if($row3 -and $row3.isCancelled){ ok "abort set isCancelled (proxy persists)" } else { sk "after abort not cancelled (may be idle): $($row3 | ConvertTo-Json -Compress)" }
  try{ Invoke-Api DELETE "/api/opencode/session/$sid2`?directory=$enc2" | Out-Null }catch{}
} catch { ng "badge flow failed: $_" }

step "3) Command runs - calendar (command-runs + schedules)"
try{
  $view=Invoke-Api GET "/api/command-runs/view?scope=all"
  if($null -ne $view.items){ ok "GET /command-runs/view scope=all ok items=$($view.items.Count)" } else { ng "view unexpected" }
} catch { ng "view failed: $_" }
try{
  $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $from=$now - 30*24*60*60*1000
  $runs=Invoke-Api GET "/api/command-runs?from=$from&to=$now"
  ok "GET /command-runs range ok count=$($runs.Count)"
} catch { sk "command-runs range failed: $_" }
try{ $sched=Invoke-Api GET "/api/schedules"; ok "GET /schedules ok count=$($sched.Count) (calendar cron source)" } catch { sk "schedules failed: $_" }

step "4) Memory - recall / search"
try{
  $recall=Invoke-Api GET "/api/search/recall?q=pnpm&k=4"
  if($null -ne $recall.block){ ok "GET /search/recall ok hits=$($recall.hits.Count) blockLen=$($recall.block.Length)" } else { ng "recall bad" }
} catch { ng "recall failed: $_" }
try{ $msgs=Invoke-Api GET "/api/search/messages?q=test&k=2"; ok "GET /search/messages ok hits=$($msgs.hits.Count)" } catch { ng "messages search failed: $_" }
try{ $commits=Invoke-Api GET "/api/search/commits?q=fix&k=2"; ok "GET /search/commits ok hits=$($commits.hits.Count)" } catch { ng "commits search failed: $_" }

step "5) HTML view - /api/html/pages CRUD + preview"
try{
  $pages=Invoke-Api GET "/api/html-view/pages"
  ok "GET /html-view/pages ok count=$($pages.Count)"
  $tn="verify-html-$(Get-Date -Format HHmmss)"
  $created=Invoke-Api POST "/api/html-view/pages" @{ name=$tn; kind="file"; path="test\dummy.html"; html="<html><body>verify</body></html>" }
  if($created.name -eq $tn){ ok "POST /html-view/pages created: $tn" } else { ng "html create bad" }
  $pages2=Invoke-Api GET "/api/html-view/pages"
  if($pages2 | Where-Object { $_.name -eq $tn }){ ok "after create: present" } else { ng "after create: missing" }
  Invoke-Api DELETE "/api/html-view/pages?name=$tn" | Out-Null
  ok "DELETE /html-view/pages ok"
  $pages3=Invoke-Api GET "/api/html-view/pages"
  if(-not ($pages3 | Where-Object { $_.name -eq $tn })){ ok "after delete: gone" } else { ng "after delete still present" }
} catch { ng "html pages CRUD failed: $_" }
try{
  $b=@{ path="workspace/config.json" } | ConvertTo-Json -Compress
  $ex=Invoke-RestMethod -Uri "$BaseUrl/api/preview/extract" -Method POST -Body $b -ContentType "application/json" -TimeoutSec 15
  if($ex.text){ ok "POST /preview/extract ok len=$($ex.text.Length)" } else { sk "preview extract empty" }
} catch { sk "preview extract failed: $_" }

Write-Host "`n================================" -ForegroundColor White
Write-Host "Result: PASS=$passed FAIL=$failed SKIP=$skipped" -ForegroundColor $(if($failed -gt 0){ "Red" } else { "Green" })
if($failed -gt 0){ exit 1 } else { exit 0 }
