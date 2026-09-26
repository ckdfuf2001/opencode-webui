# 핸드폰 Teams → PC opencode-webui 연동 가이드

핸드폰 Teams에서 메시지를 보내면, PC에서 실행 중인 opencode-webui가 처리하고
결과를 Teams로 돌려주는 구성이다.
[agent-messenger](https://github.com/agent-messenger/agent-messenger)의
Teams 연동(`agent-teams`) + opencode-webui의 공개 실행 API(`/api/public`)를 쓴다.

## 0. 구조 (핵심: 터널 불필요)

```
[폰 Teams 앱] ⇄ Teams 클라우드 ⇄ [PC: 브릿지] ⇄ localhost [opencode-webui :5001 → opencode]
```

- Teams 수신은 **trouter 웹소켓 아웃바운드**(또는 CLI 폴링), 발신도 아웃바운드 API 호출이다.
- 포트포워딩·공인 URL·Teams 봇 등록·관리자 승인이 **전부 불필요**하다.
- 단, PC 전원/백엔드 실행/Teams 로그인 유지만큼은 필요하다 (아래 5단계).

## 1. 준비물

PC(Windows, opencode-webui가 실행되는 머신):

- Node.js 18+ (`node --version`)
- Teams 데스크톱 앱에 로그인된 상태 (본인 계정)
- opencode-webui 백엔드 실행 중 (`npm run dev` 또는 exe)
- 핸드폰에는 Teams 앱만 있으면 된다 (같은 계정)

## 2. agent-messenger 설치 + Teams 인증

```powershell
npm install -g agent-messenger
agent-teams auth login        # 장치 코드 방식 — 브라우저에서 승인 1회
agent-teams auth status       # 토큰 상태(만료 시각 포함) 확인
agent-teams whoami            # 본인 확인
```

- **`auth login` 권장**: refresh token을 저장해서 만료 시 자동 갱신된다.
- 대안 `agent-teams auth extract` (데스크톱 앱에서 추출, 무설정):
  토큰 수명이 **60~90분**이라 PC Teams 로그인이 풀리면 주기적으로 다시 해줘야 한다.
- 본인 user id 확인 (무한루프 방지용, 아래 4단계에서 사용):
  `agent-teams user me`

## 3. 대상 대화 확정 (ID 확보)

본인 1:1·그룹·셀프 채팅 기준 명령어다. 팀 채널이면 `message send <team-id> <channel-id>` 계열로 바꾸면 된다
(아래 스크립트의 `chat send`/`chat history` 부분만 교체).

```powershell
agent-teams chat list                                   # CHAT_ID 확보
agent-teams chat history <CHAT_ID> --limit 5            # 읽기 테스트
agent-teams chat send <CHAT_ID> "bridge test" --format markdown   # 쓰기 테스트
```

- 처음엔 셀프 채팅(`48:notes`, 내게 쓰기)으로 테스트하면 안전하다.
- `chat history` 출력은 JSON 배열 `[{id, content, author, timestamp}]`이다.

## 4. opencode-webui 실행 API 준비

브라우저에서 opencode-webui를 열고 **`/expose` 페이지**에서 실행용 커맨드를 등록한다.

1. 실행할 슬래시 커맨드(예: `/ask`, 없으면 만드는 법은 커맨드 등록 다이얼로그 참고)에
   `exposeName` 지정 (예: `teams-ask`), enabled ON
2. `sessionMode` 선택:
   - `new` — 메시지마다 새 세션 (상태 없는 Q&A용)
   - `reuse` + `pinnedSessionId` — 고정 세션에 계속 쌓기 (대화 이어가기용).
     고정 세션은 `/expose/sessions` 목록 또는 채팅 URL의 `ses_xxx`에서 복사
3. **권한 사전 허용 (중요)**: 무인 실행이라 승인 카드에서 멈추면 답이 안 온다.
   처리할 작업에 필요한 도구(읽기/쓰기/실행 범위)는 미리 룰로 허용해 둔다
   (Settings → Permissions, 또는 레포별 룰).

동작 확인:

```powershell
$B = "http://127.0.0.1:5001"   # .env PORT 확인 (exe 기본 5002)
Invoke-RestMethod "$B/api/public/commands/teams-ask/run" -Method Post `
  -ContentType "application/json" `
  -Body (@{ repoId = 8; args = "ping" } | ConvertTo-Json)
# → { success, sessionId, ... }
```

- `repoId` 또는 `directory` 중 하나는 필수 (둘 다 없으면 첫 레포로 폴백되니 명시 권장).
- 결과 조회: `GET /api/session-messages/:sessionId/recent?limit=30`
  → 마지막 assistant 메시지 중 `time.completed` 있는 것의 text parts를 합친 게 답변이다.
  진행 확인은 `GET /api/session-status`의 busy→idle 전이로도 된다.

## 5. 브릿지 스크립트 (PC 상주)

아래를 `teams-bridge.ps1`로 저장한다. 검증된 CLI 명령어만 쓰는 폴링 방식이다
(실시간 리스너는 SDK 전용이라 오히려 운영이 무겁다 — 필요하면 agent-messenger
Teams SDK 문서의 `TeamsListener`로 교체 가능).

```powershell
# ---- 설정 ----
$BACKEND = "http://127.0.0.1:5001"   # opencode-webui 백엔드 (.env PORT)
$CHAT_ID = "19:...@..."              # 3단계에서 확보한 chat id
$EXPOSE  = "teams-ask"               # 4단계 exposeName
$REPO_ID = 8                         # 처리할 레포 id
$POLL_SEC = 30                       # Teams 폴링 주기
$STATE   = "$env:TEMP\teams-bridge.json"

# ---- 상태 ----
$state = @{ lastSeen = ""; lastSent = "" }
if (Test-Path $STATE) { try { $state = Get-Content $STATE -Raw | ConvertFrom-Json } catch {} }
$ME = ""
try { $ME = (agent-teams user me | ConvertFrom-Json).id } catch {}

function Save-State { $state | ConvertTo-Json | Set-Content $STATE }

function Get-NewInbound {
  $msgs = agent-teams chat history $CHAT_ID --limit 10 | ConvertFrom-Json
  if (-not $msgs) { return $null }
  # 오래된 순으로 보고, 마지막 처리 이후 + 본인 발신 아닌 것만
  foreach ($m in ($msgs | Sort-Object timestamp)) {
    if ($m.id -eq $state.lastSeen -or $m.id -eq $state.lastSent) { continue }
    $authorId = if ($m.author -is [string]) { $m.author } else { $m.author.id }
    $authorName = if ($m.author -is [string]) { $m.author } else { $m.author.displayName }
    if ($ME -and ($authorId -eq $ME)) { continue }
    if ($m.content -match '^\[teams-bridge\]') { continue }  # 혹시 모를 자기응답 차단
    return $m
  }
  return $null
}

function Wait-Answer([string]$sessionId, [int]$timeoutSec = 600) {
  $t0 = Get-Date
  while (((Get-Date) - $t0).TotalSeconds -lt $timeoutSec) {
    Start-Sleep -Seconds 5
    try {
      $r = Invoke-RestMethod "$BACKEND/api/session-messages/$sessionId/recent?limit=30" -TimeoutSec 10
    } catch { continue }
    $done = $r.messages | Where-Object { $_.info.role -eq 'assistant' -and $_.info.time.completed } | Select-Object -Last 1
    if ($done) {
      $text = ($done.parts | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text }) -join "`n"
      if ($text.Trim()) { return $text }
    }
  }
  return $null
}

while ($true) {
  try {
    $m = Get-NewInbound
    if ($m) {
      $state.lastSeen = $m.id; Save-State
      $run = Invoke-RestMethod "$BACKEND/api/public/commands/$EXPOSE/run" -Method Post `
        -ContentType "application/json" `
        -Body (@{ repoId = $REPO_ID; args = [string]$m.content } | ConvertTo-Json) -TimeoutSec 70
      $answer = Wait-Answer $run.sessionId
      if (-not $answer) { $answer = "[teams-bridge] 시간 초과 — PC 화면의 해당 세션에서 직접 확인해주세요." }
      if ($answer.Length -gt 4000) { $answer = $answer.Substring(0, 4000) + "`n…(이하 생략)" }
      $sent = agent-teams chat send $CHAT_ID "[teams-bridge]`n$answer" --format markdown | ConvertFrom-Json
      if ($sent.id) { $state.lastSent = $sent.id; Save-State }
    }
  } catch {
    Write-Warning "bridge tick failed: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds $POLL_SEC
}
```

실행·상주화:

```powershell
# 1회 실행 (테스트)
powershell -NoProfile -File .\teams-bridge.ps1

# 상주 (로그온 시 자동 시작 권장: 작업 스케줄러에 powershell -File 전체경로 등록)
Start-Process powershell -ArgumentList '-NoProfile','-File',"$PWD\teams-bridge.ps1" -WindowStyle Hidden
```

## 6. 트러블슈팅

| 증상 | 확인 |
|---|---|
| `Not authenticated` / 401 | `agent-teams auth status` → 만료면 `auth login` 다시. extract 모드면 PC Teams 로그인 유지 확인 |
| 브릿지가 자기 답에 반응 (무한루프) | `user me` id와 발신자 대조 + `lastSent` + `[teams-bridge]` 접두 3중 차단이 스크립트에 있음. 그래도 돌면 Teams에서 브릿지 프로세스 중지 후 `$STATE` 파일 삭제 |
| 답이 안 오고 세션이 멈춤 | 권한 대기 가능성 → PC 화면 해당 세션의 승인 카드 확인. 무인용은 룰 사전 허용(4단계) |
| 답이 너무 김 | 스크립트가 4000자에서 자름. 상수 조정 |
| 백엔드 연결 실패 | `.env` PORT와 `$BACKEND` 일치 확인 (`5001` dev / exe 기본 `5002`). 방화벽 불필요 (전부 localhost) |
| PC 절전 | 전원 "절전 안 함" + Teams/백엔드/브릿지 3개 상주 확인 |

## 7. 보안 주의

- 백엔드 API에 인증이 없다 → `HOST`는 `127.0.0.1` 유지, 백엔드 포트를 외부에 개방하지 않는다
  (외부 노출이 필요하면 reverse proxy + basic auth를 앞에 두는 별도 구성이 필요).
- Teams 자격증명은 `~/.config/agent-messenger/` (0600)에 있다. PC 잠금/계정 암호 필수.
- `expose` 등록은 enabled인 것만 외부 호출 가능 — 안 쓰는 건 `/expose` 페이지에서 끄거나 지운다.
- 팀 채널에 연결하면 팀원에게 브릿지 답변이 보인다. 처음엔 셀프/1:1 채팅 권장.

## 참고

- agent-messenger Teams 명령어 전체: https://github.com/agent-messenger/agent-messenger/blob/main/skills/agent-teams/SKILL.md
- opencode-webui 실행 API: `POST /api/public/commands/:exposeName/run`
  (`{repoId?, directory?, args?, sessionId?, agent?, model?}`), 결과는
  `GET /api/session-messages/:sessionId/recent`, 진행은 `GET /api/session-status`
- expose 등록 UI: `/expose` 페이지
