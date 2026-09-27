# 메신저 -> opencode-webui 브릿지 (PC 상주 데몬)
#
# 폰 메신저에서 보낸 요청을 opencode-webui 로 넘기고 답을 같은 채팅으로 돌려준다.
# 승인이 필요하면 채팅으로 물어보고, 답장(허용/항상/거부)을 opencode 로 전달한다.
# 백엔드/opencode 가 응답하지 않으면 그 사실을 채팅으로 알린다.
#
# 플랫폼은 -Platform 으로 고른다 (기본 kakaotalk). agent-messenger CLI 를 쓰며,
# 플랫폼별 명령/필드 차이는 어댑터 표(Get-Adapter)에서 흡수한다.
# 자세한 배경/설치/인증은 docs/kakaotalk-agent-messenger-guide.md 참고.
#
# 사전 준비:
#   1) agent-messenger 설치 + 해당 플랫폼 인증
#      (카카오: agent-kakaotalk auth login — 반드시 사람이 직접)
#   2) opencode-webui /expose 에 exposeName 등록 (기본 kakao-ask)
#   3) 백엔드 실행
#
# 실행(데몬):
#   scripts\kakao-bridge-daemon.bat            (백그라운드 + 로그, 즉시 리턴)
#   scripts\kakao-bridge-stop.bat              (중지)
#   상주는 작업 스케줄러 "로그온 시" 등록 권장.

param(
  [string]$Platform = 'kakaotalk',               # kakaotalk | teams | slack | discord | telegram | line
  [string]$Backend  = "http://127.0.0.1:5001",   # opencode-webui 백엔드 (.env PORT, exe 기본 5002)
  [string]$ChatId   = "",                        # 비우면 대화 목록에서 자동 선택
  [string]$Expose   = "kakao-ask",               # exposeName
  [int]$RepoId      = 1,                         # 처리할 레포 id
  [string]$Model    = "",                        # 예: a/deepseek-ai/deepseek-v4.1-flash
  [int]$PollSec     = 8,
  # PowerShell 변수명은 대소문자를 구분하지 않는다 -> $State 로 두면 $state 와 충돌한다.
  [string]$StateFile = "$env:TEMP\bridge-state.json",
  [switch]$Quiet                                 # 진행 알림(연결/준비 중)을 보내지 않음
)

$ErrorActionPreference = 'Continue'

# 네이티브 CLI 출력은 UTF-8 이다. PowerShell 기본 콘솔 인코딩으로 읽으면 한글이 깨져
# ConvertFrom-Json 이 실패한다. 네이티브 호출 전 반드시 UTF-8 로.
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

function Say([string]$msg) { Write-Output ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg) }
function Call-Tool([string]$cmd, [string[]]$arguments) {
  $out = & $cmd @arguments 2>&1
  return @{ code = $LASTEXITCODE; text = ($out -join "`n") }
}

# ---------------------------------------------------------------------------
# 플랫폼 어댑터
#   agent-messenger CLI 는 플랫폼마다 하위명령과 필드명이 다르다.
#   여기서 공통 형태 { id, text } 로 정규화해 본문 로직은 플랫폼을 모르게 한다.
#   구조만 맞으면 새 플랫폼은 아래 표에 한 줄 추가로 붙는다.
#   (kakaotalk 만 실측 검증됨. 나머지는 agent-messenger 문서 기준 매핑.)
# ---------------------------------------------------------------------------
function Get-Adapter([string]$p) {
  switch ($p.ToLowerInvariant()) {
    'kakaotalk' { return @{ label='카카오톡'; cli='agent-kakaotalk'; listArgs=@('chat','list'); msgs=@('message','list'); send=@('message','send'); idField='log_id'; textField='message'; defaultPick='MemoChat' } }
    'teams'     { return @{ label='Teams';   cli='agent-teams';     listArgs=@('chat','list');           msgs=@('chat','history');          send=@('chat','send');    idField='id';     textField='content';  defaultPick='' } }
    'slack'     { return @{ label='Slack';   cli='agent-slack';     listArgs=@('channel','list');        msgs=@('message','list');          send=@('message','send'); idField='ts';     textField='text';     defaultPick='' } }
    'discord'   { return @{ label='Discord'; cli='agent-discord';   listArgs=@('channel','list');        msgs=@('message','list');          send=@('message','send'); idField='id';     textField='content';  defaultPick='' } }
    'telegram'  { return @{ label='Telegram';cli='agent-telegram';  listArgs=@('chat','list');           msgs=@('message','list');          send=@('message','send'); idField='id';     textField='text';     defaultPick='' } }
    'line'      { return @{ label='LINE';    cli='agent-line';      listArgs=@('chat','list');           msgs=@('message','list');          send=@('message','send'); idField='id';     textField='text';     defaultPick='' } }
    default     { throw "지원하지 않는 플랫폼: $p" }
  }
}
$A = Get-Adapter $Platform

# 공통 형태 { id, text } 로 정규화
function Normalize-Msg($m) {
  return @{
    id   = [string]($m.($A.idField))
    text = [string]($m.($A.textField))
    ts   = if ($m.sent_at) { [int64]$m.sent_at } elseif ($m.timestamp) { [int64]$m.timestamp } else { 0 }
  }
}

# ---- 상태 ----
$state = @{
  lastLogId     = '0'
  sentLogIds    = @()
  askedPerms    = @()
  awaitPermId   = ''
  awaitPermDesc = ''
  runSessionId  = ''
  lastActivity  = ''
  lastErrorKey  = ''   # 같은 오류 반복 알림 방지
  lastErrorAt   = 0
}
if (Test-Path $StateFile) {
  try {
    $saved = Get-Content $StateFile -Raw | ConvertFrom-Json
    foreach ($k in @('lastLogId','awaitPermId','awaitPermDesc','runSessionId','lastActivity','lastErrorKey')) {
      if ($null -ne $saved.$k) { $state[$k] = [string]$saved.$k }
    }
    if ($null -ne $saved.lastErrorAt) { $state.lastErrorAt = [int64]$saved.lastErrorAt }
    if ($saved.sentLogIds) { $state.sentLogIds = @($saved.sentLogIds) }
    if ($saved.askedPerms) { $state.askedPerms = @($saved.askedPerms) }
  } catch {}
}
function Save-State { $state | ConvertTo-Json -Depth 5 | Set-Content $StateFile }

function Send-Chat([string]$text) {
  $cliArgs = @($A.send) + @($ChatId, $text)
  $r = Call-Tool $A.cli $cliArgs
  if ($r.code -ne 0) { Say "전송 실패: $($r.text)"; return $false }
  try {
    $obj = $r.text | ConvertFrom-Json
    $lid = [string]($obj.($A.idField))
    if ($lid) { $state.sentLogIds = @($state.sentLogIds + $lid | Select-Object -Last 100) }
  } catch {}
  return $true
}

# 백엔드/opencode 문제를 채팅으로 알린다 (같은 오류 반복은 2분에 1번만).
function Notify-Error([string]$key, [string]$text) {
  $now = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  if ($state.lastErrorKey -eq $key -and ($now - $state.lastErrorAt) -lt 120000) { return }
  $state.lastErrorKey = $key
  $state.lastErrorAt = $now
  Save-State
  Send-Chat $text
}

# ---- 대화 확정 ----
if (-not $ChatId) {
  $r = Call-Tool $A.cli $A.listArgs
  if ($r.code -ne 0) { Say "대화 목록 실패: $($r.text)"; exit 1 }
  $chats = $r.text | ConvertFrom-Json
  $pick = if ($A.defaultPick) { $chats | Where-Object { $_.type -eq $A.defaultPick } | Select-Object -First 1 } else { $null }
  if (-not $pick) { $pick = $chats | Select-Object -First 1 }
  if (-not $pick) { Say '대화를 찾지 못했습니다.'; exit 1 }
  $ChatId = [string]$pick.chat_id
  Save-State
  Say "chat_id 자동 선택: $ChatId"
}

# 레포 디렉터리 (승인 조회에 필요)
$RepoDir = ''
try {
  $repos = (Invoke-RestMethod "$Backend/api/repos" -TimeoutSec 15)
  $repo = $repos | Where-Object { $_.id -eq $RepoId } | Select-Object -First 1
  if ($repo) { $RepoDir = [string]$repo.fullPath }
} catch {}
if (-not $RepoDir) { Say "경고: repoId=$RepoId directory 를 못 찾음 — 승인 조회 생략" }
else { Say "repo directory: $RepoDir" }

$runBodyBase = @{ repoId = $RepoId }
if ($Model) { $runBodyBase.model = $Model }

# 첫 실행이면 과거 메시지를 재생하지 않도록 최신 id 로 건너뛴다.
if (-not $state.lastLogId -or $state.lastLogId -eq '0') {
  $r = Call-Tool $A.cli (@($A.msgs) + @($ChatId, '-n', '1'))
  if ($r.code -eq 0) {
    try {
      $last = ($r.text | ConvertFrom-Json | Select-Object -Last 1)
      if ($last) { $state.lastLogId = [string]$last.($A.idField); Save-State }
    } catch {}
  }
}

Say "bridge 시작 - platform=$Platform chat=$ChatId expose=$Expose repo=$RepoId model=$(if($Model){$Model}else{'(기본)'}) poll=${PollSec}s"
if (-not $Quiet) { Send-Chat "연결됐어요. 하고 싶은 일을 그냥 보내주시면 처리해서 답변드릴게요.`n(연결 확인: '상태' 또는 '핑', 사용법: '도움말')" }

# ---- 새 메시지 (증분) ----
function Get-NewInbound {
  # $args 는 예약 변수라 쓰지 않는다.
  $cliArgs = @($A.msgs) + @($ChatId)
  if ($state.lastLogId -and $state.lastLogId -ne '0') { $cliArgs += @('--from', [string]$state.lastLogId) }
  $cliArgs += @('-n', '50')
  $r = Call-Tool $A.cli $cliArgs
  if ($r.code -ne 0) { Say "메시지 조회 실패: $($r.text)"; return $null }
  $msgs = $r.text | ConvertFrom-Json
  if (-not $msgs) { return $null }
  foreach ($raw in ($msgs | Sort-Object { [int64]($_.sent_at ?? $_.timestamp ?? 0) })) {
    $m = Normalize-Msg $raw
    if (-not $m.id) { continue }
    # --from 은 inclusive 라서 기준점이 다시 딸려온다 — 갱신 전에 같은 id 를 거른다.
    if ($m.id -eq [string]$state.lastLogId) { continue }
    $state.lastLogId = $m.id
    if ($state.sentLogIds -contains $m.id) { continue }
    if (-not $m.text.Trim()) { continue }
    return $m
  }
  return $null
}

# ---- 승인 ----
function Parse-Approval([string]$text) {
  $t = $text.Trim()
  if ($t -match '^(허용|허용해|ㅇ|응|예|네|yes|y|allow|once)$')  { return 'once' }
  if ($t -match '^(항상|항상허용|항상 허용|계속|always)$')          { return 'always' }
  if ($t -match '^(거부|거부해|아니|아니오|ㄴ|no|n|deny|reject)$') { return 'reject' }
  return $null
}
function Get-PendingPermission {
  if (-not $RepoDir) { return @() }
  $d = [uri]::EscapeDataString($RepoDir)
  try {
    $list = Invoke-RestMethod "$Backend/api/opencode/permission?directory=$d" -TimeoutSec 15
    if ($null -eq $list) { return @() }
    return @($list)
  } catch { return @() }
}
function Reply-Permission([string]$permissionId, [string]$reply) {
  $d = [uri]::EscapeDataString($RepoDir)
  try {
    Invoke-RestMethod "$Backend/api/opencode/permission/$permissionId/reply?directory=$d" -Method Post `
      -ContentType 'application/json' -Body (@{ reply = $reply } | ConvertTo-Json) -TimeoutSec 20 | Out-Null
    return $true
  } catch { Say "승인 응답 실패($reply): $($_.Exception.Message)"; return $false }
}

# ---- 제어 명령 ----
function Handle-Control([string]$text) {
  $t = $text.Trim().ToLowerInvariant()
  if ($t -match '^(핑|ping|ㅍ)$') { Send-Chat '퐁 — 연결 정상이에요.'; return $true }
  if ($t -match '^(상태|상태확인|status|state|ㅅ)$') {
    $nowWhat = if ($state.awaitPermId) { "승인 답장 기다리는 중 ($($state.awaitPermDesc))" }
               elseif ($state.runSessionId) { '답변 만드는 중' }
               else { '대기 중 (새 요청 받을 수 있어요)' }
    Send-Chat @"
연결 정상이에요.
· 플랫폼: $($A.label)
· 대화: $ChatId
· 모델: $(if ($Model) { $Model } else { '(기본)' })
· 작업 폴더: repoId=$RepoId
· 지금: $nowWhat
· 마지막 활동: $(if ($state.lastActivity) { $state.lastActivity } else { '-' })
"@
    return $true
  }
  if ($t -match '^(도움말|help|\?|명령)$') {
    Send-Chat @"
사용법:
· 하고 싶은 일을 그냥 보내면 처리해서 답해드려요.
· 권한이 필요하면 허용 / 항상 / 거부 로 답해주세요.
· 상태 — 연결/진행 상황 확인
· 핑 — 연결 확인
· 도움말 — 이 안내
"@
    return $true
  }
  return $false
}

# ---- 실행 결과 확인 (블로킹하지 않음) ----
function Get-RunResult([string]$sessionId) {
  try { $r = Invoke-RestMethod "$Backend/api/session-messages/$sessionId/recent?limit=30" -TimeoutSec 10 }
  catch { return $null }
  $done = $r.messages | Where-Object { $_.info.role -eq 'assistant' -and $_.info.time.completed } | Select-Object -Last 1
  if (-not $done) { return $null }
  if ($done.info.error) { return "처리 중 문제가 생겼어요: $($done.info.error.data.message)" }
  $text = ($done.parts | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text }) -join "`n"
  if (-not $text.Trim()) { return '답변을 만들지 못했어요. 모델 설정을 확인해주세요.' }
  return $text
}

# ================= 메인 루프 =================
while ($true) {
  try {
    # 1) 진행 중 실행 완료 확인
    if ($state.runSessionId) {
      $result = Get-RunResult $state.runSessionId
      if ($result) {
        if ($result.Length -gt 4000) { $result = $result.Substring(0, 4000) + "`n...(이하 생략)" }
        if (Send-Chat $result) { Say "답변 전송 완료" }
        $state.runSessionId = ''
        Save-State
      }
    }

    # 2) 새 승인 요청 -> 채팅으로 확인
    if (-not $state.awaitPermId) {
      foreach ($p in (Get-PendingPermission)) {
        $pid_ = [string]$p.id
        if (-not $pid_) { continue }
        if ($state.askedPerms -contains $pid_) { continue }
        $desc = "$($p.permission) $((@($p.patterns) -join ', '))".Trim()
        $state.awaitPermId = $pid_
        $state.awaitPermDesc = $desc
        $state.askedPerms = @($state.askedPerms + $pid_ | Select-Object -Last 50)
        Save-State
        Send-Chat "잠깐 확인이 필요해요.`n`n다음을 실행해도 될까요?`n· $desc`n`n'허용' / '항상' / '거부' 중에 답해주세요."
        Say "승인 질문: $desc ($pid_)"
        break
      }
    }

    # 3) 메시지 처리
    $m = Get-NewInbound
    if ($m) {
      $state.lastActivity = Get-Date -Format 'MM-dd HH:mm:ss'
      Save-State
      if (Handle-Control $m.text) { continue }

      if ($state.awaitPermId) {
        $reply = Parse-Approval $m.text
        if ($reply) {
          $ok = Reply-Permission $state.awaitPermId $reply
          $label = switch ($reply) { 'once' { '허용' } 'always' { '항상 허용' } default { '거부' } }
          if ($ok) {
            Send-Chat "$label 로 처리했어요. 이어서 진행할게요."
            $state.awaitPermId = ''; $state.awaitPermDesc = ''; Save-State
          } else {
            Send-Chat '승인 전달에 실패했어요. PC 화면에서 직접 처리해주세요.'
          }
          continue
        }
        Send-Chat "아직 확인을 기다리고 있어요. '허용' / '항상' / '거부' 로 답해주세요.`n(요청: $($state.awaitPermDesc))"
        continue
      }

      if ($state.runSessionId) {
        Send-Chat '앞선 답변을 아직 만들고 있어요. 조금 뒤에 다시 보내주세요.'
        continue
      }

      Say "수신: $($m.text)"
      if (-not $Quiet) { Send-Chat '확인했어요. 답변 준비할게요...' }
      $body = $runBodyBase.Clone()
      $body.args = $m.text
      try {
        $run = Invoke-RestMethod "$Backend/api/public/commands/$Expose/run" -Method Post `
          -ContentType 'application/json' -Body ($body | ConvertTo-Json) -TimeoutSec 90
        $state.runSessionId = [string]$run.sessionId
        Save-State
        Say "실행 sessionId=$($state.runSessionId)"
      } catch {
        # 백엔드가 죽었거나 expose 가 없을 때 — 채팅으로 알린다 (조용히 실패하지 않는다).
        Say "실행 요청 실패: $($_.Exception.Message)"
        Notify-Error 'run-failed' "요청을 처리하지 못했어요. 백엔드(opencode-webui)가 실행 중인지 확인해주세요.`n(오류: $($_.Exception.Message))"
      }
    }
  } catch {
    Say "tick 오류: $($_.Exception.Message)"
    # 백엔드/opencode 연결 실패는 사용자가 알 수 있게 채팅으로 (2분에 1번).
    if ($_.Exception.Message -match '연결|refused|Unable to connect|timed out|500') {
      Notify-Error 'backend-down' '백엔드에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.'
    }
  }
  Start-Sleep -Seconds $PollSec
}
