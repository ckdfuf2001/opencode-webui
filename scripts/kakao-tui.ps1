# 카카오 브릿지 TUI (대화형 조작판)
#
# 브릿지(kakao-bridge.ps1)가 데몬으로 도는 것과 별개로, 사람이 PC에서 직접
# 레포를 고르고 명령을 실행해 보는 용도다. 순서는 고정이다:
#   메인(레포 목록 + 핑/상태/채팅 안내) -> 레포로 이동(현재 접속 레포) ->
#   명령 목록 -> 실행 -> 결과. 어디서든 b=뒤로, q=종료.
#
# 백엔드가 꺼져 있으면 레포/명령 기능은 막히고, 카카오 단독 기능
# (인증 상태, 채팅 목록)은 그대로 된다. 조용히 실패하지 않는다.
#
# 실행:
#   powershell -NoProfile -File .\scripts\kakao-tui.ps1
#   powershell -NoProfile -File .\scripts\kakao-tui.ps1 -Backend http://127.0.0.1:5001 -RepoId 1

param(
  [string]$Backend = "http://127.0.0.1:5001",   # opencode-webui 백엔드 (.env PORT, exe 기본 5002)
  [string]$ChatId  = "",                        # 비우면 MemoChat 자동 선택 (읽기/상태용)
  [int]$RepoId     = 0                          # 0이면 미선택 시작, 번호로 레포로 이동
)

$ErrorActionPreference = 'Continue'

# 네이티브 CLI 출력(agent-kakaotalk JSON)은 UTF-8 이라 $OutputEncoding만 맞춘다.
# [Console]::OutputEncoding은 실제 콘솔일 때만 건드린다. 리다이렉트(로그/파이프) 상태에서
# 바꾸면 그 시점까지 버퍼링된 화면 출력이 유실될 수 있다.
$OutputEncoding = [System.Text.Encoding]::UTF8
try {
  if (-not [Console]::IsOutputRedirected) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  }
} catch {}

$KakaoCli = 'agent-kakaotalk'
$script:curRepo = $null   # 현재 접속 레포 @{ id, name, path }

function Say([string]$msg) { Write-Output ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg) }

function Call-Tool([string]$cmd, [string[]]$arguments) {
  # CLI 미설치면 빨간 오류를 뿌리지 말고 조용히 127 로 돌린다.
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    return @{ code = 127; text = "CLI 없음: $cmd (npm install -g agent-messenger 필요)" }
  }
  $out = & $cmd @arguments 2>&1
  return @{ code = $LASTEXITCODE; text = ($out -join "`n") }
}

function Api-Get([string]$path, [int]$timeoutSec = 10) {
  try {
    $d = Invoke-RestMethod "$Backend$path" -TimeoutSec $timeoutSec
    return @{ ok = $true; data = $d }
  } catch { return @{ ok = $false; err = $_.Exception.Message } }
}

function Api-Post([string]$path, $body, [int]$timeoutSec = 90) {
  try {
    $d = Invoke-RestMethod "$Backend$path" -Method Post -ContentType 'application/json' `
      -Body ($body | ConvertTo-Json -Depth 6) -TimeoutSec $timeoutSec
    return @{ ok = $true; data = $d }
  } catch { return @{ ok = $false; err = $_.Exception.Message } }
}

function Repo-Label($r) {
  $name = if ($r.name) { $r.name } elseif ($r.localPath) { $r.localPath } else { "(이름 없음)" }
  $br = if ($r.currentBranch) { " [$($r.currentBranch)]" } else { "" }
  return "id=$($r.id) $name$br"
}

function Get-Repos {
  $r = Api-Get '/api/repos' 15
  if (-not $r.ok) { return @{ ok = $false; err = $r.err } }
  $repos = @($r.data)
  return @{ ok = $true; repos = $repos }
}

function Get-Commands {
  $r = Api-Get '/api/public/commands' 15
  if (-not $r.ok) { return @{ ok = $false; err = $r.err } }
  return @{ ok = $true; commands = @($r.data.commands) }
}

function Test-BackendPing {
  # 가벼운 순서대로: repos -> public commands. 둘 다 되면 정상.
  $t = [Diagnostics.Stopwatch]::StartNew()
  $r = Api-Get '/api/repos' 8
  $t.Stop()
  if (-not $r.ok) { return @{ ok = $false; err = $r.err } }
  return @{ ok = $true; ms = [int]$t.ElapsedMilliseconds; repos = @($r.data).Count }
}

function Test-KakaoAuth {
  $r = Call-Tool $KakaoCli @('auth', 'status')
  if ($r.code -ne 0) { return @{ ok = $false; err = $r.text } }
  try {
    $o = $r.text | ConvertFrom-Json
    $auth = [string]$o.authenticated
    if ($auth -eq 'True') { return @{ ok = $true; detail = "authenticated (device: $($o.device_type))" } }
    return @{ ok = $false; err = "authenticated=false — agent-kakaotalk auth login 필요" }
  } catch { return @{ ok = $false; err = "auth status 파싱 실패: $($r.text)" } }
}

function Get-ChatList {
  $r = Call-Tool $KakaoCli @('chat', 'list')
  if ($r.code -ne 0) { return @{ ok = $false; err = $r.text } }
  try { return @{ ok = $true; chats = @($r.text | ConvertFrom-Json) } }
  catch { return @{ ok = $false; err = "chat list 파싱 실패" } }
}

function Ensure-ChatId {
  if ($script:ChatId) { return $script:ChatId }
  $r = Get-ChatList
  if (-not $r.ok) { Say "채팅 목록 실패: $($r.err)"; return '' }
  $pick = $r.chats | Where-Object { $_.type -eq 'MemoChat' } | Select-Object -First 1
  if (-not $pick) { $pick = $r.chats | Select-Object -First 1 }
  if (-not $pick) { Say '대화를 찾지 못했습니다.'; return '' }
  $script:ChatId = [string]$pick.chat_id
  return $script:ChatId
}

function Test-BridgeRunning {
  try {
    $hit = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $_.CommandLine -match 'kakao-bridge\.ps1'
    } | Select-Object -First 1
    if ($hit) { return @{ ok = $true; detail = "PID $($hit.ProcessId)" } }
    return @{ ok = $false; err = '브릿지 프로세스 없음 (daemon bat로 시작)' }
  } catch { return @{ ok = $false; err = $_.Exception.Message } }
}

function Read-Choice([string]$prompt) {
  $v = Read-Host $prompt
  if ($null -eq $v) { return 'q' }
  return $v.Trim()
}

# ---------------- 화면: 메인 (레포 목록 + 명령 안내) ----------------
function Show-Main {
  while ($true) {
    Write-Output ''
    Write-Output '=== 카카오 브릿지 TUI : 메인 (레포 목록) ==='
    $ping = Test-BackendPing
    if ($ping.ok) { Say "백엔드: 정상 ($($ping.ms)ms, 레포 $($ping.repos)개)" }
    else { Say "백엔드: 연결 안 됨 — $($ping.err) (레포/명령 기능 제한)" }

    $repos = @()
    if ($ping.ok) {
      $g = Get-Repos
      if ($g.ok) { $repos = $g.repos } else { Say "레포 목록 실패: $($g.err)" }
      $i = 1
      foreach ($r in $repos) {
        $mark = if ($script:curRepo -and $script:curRepo.id -eq $r.id) { '*' } else { ' ' }
        Write-Output (" {0}[{1}] {2}`n      {3}" -f $mark, $i, (Repo-Label $r), $r.fullPath)
        $i++
      }
      if (-not $repos.Count) { Say '등록된 레포가 없습니다. 웹 UI에서 먼저 레포를 추가하세요.' }
    }
    Write-Output ''
    Write-Output ' 명령: <번호>=레포로 이동  p=핑(상세)  s=상태  c=채팅 목록  h=도움말  q=종료'
    $c = Read-Choice '선택'
    switch -Regex ($c) {
      '^(q|quit|exit)$' { $script:nav = 'quit'; return }
      '^(p|핑|ping)$'   { Show-Ping; continue }
      '^(s|상태|status)$' { Show-Status; continue }
      '^(c|채팅|chat)$' { Show-Chats; continue }
      '^(h|도움말|help|\?)$' { Show-Help; continue }
      '^\d+$' {
        $n = [int]$c
        if ($n -ge 1 -and $n -le $repos.Count) {
          $r = $repos[$n - 1]
          $path = if ($r.fullPath) { [string]$r.fullPath } else { [string]$r.localPath }
          $nm = if ($r.name) { [string]$r.name } else { $path }
          $script:curRepo = @{ id = [int]$r.id; name = $nm; path = $path }
          $script:nav = ''
          Show-Repo
          if ($script:nav -eq 'quit') { return }
          continue
        }
        Say "번호 범위를 벗어났습니다 (1~$($repos.Count))."
        continue
      }
      default { Say "알 수 없는 입력: '$c' (h=도움말)"; continue }
    }
  }
}

# ---------------- 화면: 핑 (상세 연결 확인) ----------------
function Show-Ping {
  Write-Output ''
  Write-Output '--- 핑 (상세) ---'
  $b = Test-BackendPing
  Say ($(if ($b.ok) { "백엔드: 정상 ($($b.ms)ms)" } else { "백엔드: 실패 — $($b.err)" }))
  $a = Test-KakaoAuth
  Say ($(if ($a.ok) { "카카오 인증: $($a.detail)" } else { "카카오 인증: 실패 — $($a.err)" }))
  $cid = Ensure-ChatId
  if ($cid) {
    $m = Call-Tool $KakaoCli @('message', 'list', $cid, '-n', '1')
    Say ($(if ($m.code -eq 0) { "채팅 읽기: 정상 (chat_id=$cid)" } else { "채팅 읽기: 실패 — $($m.text)" }))
  }
  $br = Test-BridgeRunning
  Say ($(if ($br.ok) { "브릿지 데몬: 실행 중 ($($br.detail))" } else { "브릿지 데몬: $($br.err)" }))
}

# ---------------- 화면: 상태 ----------------
function Show-Status {
  Write-Output ''
  Write-Output '--- 상태 ---'
  $br = Test-BridgeRunning
  Say ($(if ($br.ok) { "브릿지: 실행 중 ($($br.detail))" } else { "브릿지: 꺼져 있음" }))
  $a = Test-KakaoAuth
  Say ($(if ($a.ok) { "카카오: $($a.detail)" } else { "카카오: 미인증" }))
  if ($script:curRepo) { Say "현재 접속 레포: id=$($script:curRepo.id) $($script:curRepo.name)" }
  else { Say '현재 접속 레포: (없음 — 번호로 이동)' }
  Say "대화 chat_id: $(if ($script:ChatId) { $script:ChatId } else { '(자동 선택 전)' })"
}

# ---------------- 화면: 도움말 ----------------
function Show-Help {
  Write-Output @'

조작법 (어디서든 b=뒤로, q=종료):
 1) 메인에서 번호를 고르면 그 레포로 이동한다 (* = 현재 접속 레포).
 2) 레포 화면에서 명령 번호를 고르면 args를 물어보고 실행한다.
 3) 실행 후 결과가 바로 보이고, b로 명령 목록으로 돌아간다.
 p=핑(백엔드/카카오/채팅/브릿지 상세), s=상태 요약, c=채팅 목록.
'@
}

# ---------------- 화면: 채팅 목록 ----------------
function Show-Chats {
  Write-Output ''
  Write-Output '--- 채팅 목록 ---'
  $r = Get-ChatList
  if (-not $r.ok) { Say "실패: $($r.err)"; return }
  $i = 1
  foreach ($c in $r.chats) {
    Write-Output (" [{0}] chat_id={1} type={2} unread={3}" -f $i, $c.chat_id, $c.type, $c.unread_count)
    $i++
  }
  Write-Output ' (b=뒤로, q=종료. 번호=최근 5개 읽기)'
  while ($true) {
    $c = Read-Choice '선택'
    if ($c -match '^(b|back)$') { return }
    if ($c -match '^(q|quit|exit)$') { $script:nav = 'quit'; return }
    if ($c -match '^\d+$') {
      $n = [int]$c
      if ($n -ge 1 -and $n -le $r.chats.Count) {
        $cid = [string]$r.chats[$n - 1].chat_id
        $m = Call-Tool $KakaoCli @('message', 'list', $cid, '-n', '5', '--pretty')
        Write-Output $m.text
        continue
      }
    }
    Say "알 수 없는 입력: '$c'"
  }
}

# ---------------- 화면: 레포 (현재 접속 레포의 명령 목록) ----------------
function Show-Repo {
  while ($true) {
    Write-Output ''
    Write-Output ("=== 현재 접속 레포: id={0} {1} ===" -f $script:curRepo.id, $script:curRepo.name)
    Write-Output (" 경로: {0}" -f $script:curRepo.path)
    $g = Get-Commands
    $cmds = @()
    if (-not $g.ok) {
      Say "명령 목록 실패: $($g.err) (백엔드 확인 후 r으로 새로고침)"
    } else {
      $cmds = $g.commands
      $i = 1
      foreach ($t in $cmds) {
        $desc = if ($t.description) { " - $($t.description)" } else { '' }
        $ex = if ($t.exampleArgs) { " (예: $($t.exampleArgs))" } else { '' }
        Write-Output (" [{0}] {1} (/…{2}){3}{4}" -f $i, $t.name, $t.commandName, $desc, $ex)
        $i++
      }
      if (-not $cmds.Count) { Say '등록된 실행 명령이 없습니다. 웹 UI /expose 에서 exposeName을 등록하세요.' }
    }
    Write-Output ''
    Write-Output ' 명령: <번호>=실행  r=목록 새로고침  b=뒤로(레포 목록)  q=종료'
    $c = Read-Choice '선택'
    switch -Regex ($c) {
      '^(q|quit|exit)$' { $script:nav = 'quit'; return }
      '^(b|back)$'      { return }
      '^(r|refresh)$'   { continue }
      '^\d+$' {
        $n = [int]$c
        if ($n -ge 1 -and $n -le $cmds.Count) {
          $script:nav = ''
          Show-Run $cmds[$n - 1]
          if ($script:nav -eq 'quit') { return }
          continue
        }
        Say "번호 범위를 벗어났습니다 (1~$($cmds.Count))."
        continue
      }
      default { Say "알 수 없는 입력: '$c'"; continue }
    }
  }
}

function Get-RunResult([string]$sessionId) {
  # kakao-bridge.ps1 Get-RunResult 와 동일 판정 (완료된 assistant 마지막 메시지).
  try { $r = Invoke-RestMethod "$Backend/api/session-messages/$sessionId/recent?limit=30" -TimeoutSec 10 }
  catch { return $null }
  $done = $r.messages | Where-Object { $_.info.role -eq 'assistant' -and $_.info.time.completed } | Select-Object -Last 1
  if (-not $done) { return $null }
  if ($done.info.error) { return "처리 중 문제가 생겼어요: $($done.info.error.data.message)" }
  $text = ($done.parts | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text }) -join "`n"
  if (-not $text.Trim()) { return '답변을 만들지 못했어요. 모델 설정을 확인해주세요.' }
  return $text
}

# ---------------- 화면: 실행 ----------------
function Show-Run($t) {
  Write-Output ''
  Write-Output ("--- 실행: {0} (/{1}) ---" -f $t.name, $t.commandName)
  if ($t.description) { Write-Output (" 설명: {0}" -f $t.description) }
  if ($t.exampleArgs) { Write-Output (" 예시 args: {0}" -f $t.exampleArgs) }
  Write-Output (" 대상 레포: id={0} {1}" -f $script:curRepo.id, $script:curRepo.name)
  while ($true) {
    # $args 는 예약 변수라 쓰지 않는다 (kakao-bridge.ps1 동일 주의).
    $inArgs = Read-Host 'args (빈칸=그대로 실행, b=뒤로, q=종료)'
    if ($null -eq $inArgs) { $script:nav = 'quit'; return }
    $inArgs = $inArgs.Trim()
    if ($inArgs -match '^(q|quit|exit)$') { $script:nav = 'quit'; return }
    if ($inArgs -match '^(b|back)$') { return }
    Say "실행 중: $($t.name) repoId=$($script:curRepo.id) ..."
    $run = Api-Post ("/api/public/commands/$($t.name)/run") @{ repoId = $script:curRepo.id; args = $inArgs } 90
    if (-not $run.ok) { Say "실행 요청 실패: $($run.err)"; continue }
    $sid = [string]$run.data.sessionId
    if (-not $sid) { Say "sessionIdなし 응답: $($run.data | ConvertTo-Json -Compress)"; continue }
    Say "sessionId=$sid — 결과 대기 (최대 120초)"
    $result = $null
    for ($i = 0; $i -lt 40 -and -not $result; $i++) {
      Start-Sleep -Seconds 3
      $result = Get-RunResult $sid
      if (-not $result) { Write-Host -NoNewline '.' }
    }
    Write-Output ''
    if (-not $result) { Say '시간 초과 — 웹 UI 세션에서 직접 확인하세요.' }
    else {
      if ($result.Length -gt 4000) { $result = $result.Substring(0, 4000) + "`n...(이하 생략)" }
      Write-Output '--- 결과 ---'
      Write-Output $result
      Write-Output '------------'
    }
    Write-Output ' (Enter=같은 명령 다시, b=명령 목록으로, q=종료)'
  }
}

# ================= 시작 =================
# 화면 이동 규약: 함수 출력 캡처 금지 ($x = Show-... 처럼 받으면 Write-Output이
# 화면 대신 변수로 들어가 TUI가 빈 화면이 된다). 이동 신호는 $script:nav 로만.
$script:nav = ''
if ($RepoId -ne 0) {
  $g = Get-Repos
  if ($g.ok) {
    $r = $g.repos | Where-Object { $_.id -eq $RepoId } | Select-Object -First 1
    if ($r) {
      $path = if ($r.fullPath) { [string]$r.fullPath } else { [string]$r.localPath }
      $nm = if ($r.name) { [string]$r.name } else { $path }
      $script:curRepo = @{ id = [int]$r.id; name = $nm; path = $path }
      Say "시작 레포: id=$RepoId $nm"
    } else { Say "경고: RepoId=$RepoId 없음 — 목록에서 선택하세요." }
  } else { Say "경고: 백엔드 연결 안 됨 — $($g.err)" }
}

Show-Main
Say '종료합니다.'
