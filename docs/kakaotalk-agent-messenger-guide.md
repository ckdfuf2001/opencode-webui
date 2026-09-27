# 핸드폰 카카오톡 → PC opencode-webui 연동 가이드

핸드폰 카카오톡에서 메시지를 보내면, PC에서 실행 중인 opencode-webui가 처리하고
결과를 카카오톡으로 돌려주는 구성이다.
[agent-messenger](https://github.com/agent-messenger/agent-messenger)의
카카오톡 연동(`agent-kakaotalk`) + opencode-webui의 공개 실행 API(`/api/public`)를 쓴다.

> Teams 버전은 [teams-agent-messenger-guide.md](./teams-agent-messenger-guide.md) 참고.
> 구조·expose 준비(4단계)는 동일하고, 메신저 부분만 카카오톡으로 바뀐다.

## 0. 구조 (핵심: 터널 불필요)

```
[폰 카카오톡] ⇄ 카카오 서버 ⇄ [PC: 브릿지(agent-kakaotalk)] ⇄ localhost [opencode-webui :5001 → opencode]
```

- **PC 카카오톡 앱을 "보조기기(태블릿 슬롯)"로 로그인**해 메시지를 주고받는다.
  폰 세션은 그대로 유지된다 (카톡은 폰 1 + PC 1 + 태블릿 1 동시 로그인 허용).
- 포트포워딩·공인 URL·봇 등록·관리자 승인이 전부 불필요하다.
- 단, PC 전원/카카오톡 실행/백엔드/브릿지 유지는 필요하다 (7단계).

### Teams와 다른 점 (먼저 읽기)

| | Teams | 카카오톡 |
|---|---|---|
| 인증 | `auth login`(장치 코드) 또는 데스크톱 추출 | **보조기기 로그인** — 폰에서 숫자 코드 확인 1회 |
| 토큰 수명 | PC Teams 로그인이 풀리면 60~90분마다 갱신 필요 | refresh 토큰 자동 갱신 (재로그인 거의 불필요) |
| 대화 ID | `19:...@thread...` 문자열 | **숫자 chat_id** (`chat list`로 확인) |
| 히스토리 | `chat history` | `message list <chat-id>` |
| 발신 | `chat send` | `message send <chat-id>` |
| 증분 조회 | 없음 (매번 최근 N개) | `--from <log_id>` (이후 것만) |
| 메시지 필드 | `id`,`content`,`author` | `log_id`,`message`,`author_id`,`author_name` |
| 못 하는 것 | — | 검색·반응·수정·삭제·오픈채팅 탐색 불가 |

## 1. 준비물

PC(Windows, opencode-webui가 실행되는 머신):

- Node.js 18+ (`node --version`)
- **PC 카카오톡 설치 + 로그인된 상태** (경로 예: `C:\Program Files\Kakao\KakaoTalk\KakaoTalk.exe`)
- 폰 카카오톡 (코드 확인용 — 같은 계정)
- opencode-webui 백엔드 실행 중 (`npm run dev` 또는 exe)

> 카카오톡 PC 앱이 켜져 있어야 자격증명 자동 추출이 쉽다. 꺼져 있으면 이메일/비밀번호를
> 직접 입력해야 할 수 있다.

## 2. agent-messenger 설치 + 카카오톡 인증

```powershell
npm install -g agent-messenger
agent-kakaotalk auth login
```

> ### ⚠️ 인증은 반드시 "직접" 실행한다 (터미널에서 손으로)
>
> **`auth login` 은 대화형이다. 스크립트/에이전트/헤드리스로 대신 실행하지 말고,
> 사람이 터미널에 직접 입력해서 실행한다.**
>
> 이유 (실측):
> - **비밀번호 입력** — PC 카톡 앱 캐시에 비밀번호가 없으면 네이티브 다이얼로그(또는 TTY)로
>   받는다. 백그라운드/숨김 프로세스로 띄우면 **다이얼로그가 뜨지 않아** 그대로 멈춘다.
> - **폰 확인 코드** — 기기 등록 시 CLI가 숫자 패스코드를 출력하고 폴링한다. 만료가 짧아
>   그 순간 화면을 보며 **폰에서 즉시 확인**해야 한다. 자동화로 감싸면 출력을 제때 못 봐서
>   `registration_timeout` 으로 끝난다.
>
> 즉 `auth login` 만 사람이 직접 하고, **그 이후(chat list / message send / 브릿지 실행·상주)는
> 자동화해도 된다.**

로그인 흐름과 응답:

1. **이메일** — 보통 PC 카톡 앱에서 자동 추출. 못 찾으면 아래처럼 직접 넘긴다.
2. **비밀번호** — 네이티브 다이얼로그 1회 입력(이후 재사용 안 함).
   대화형이 불가한 환경이면 `--password-file` 을 쓴다(읽고 즉시 삭제되어 기록에 남지 않음):
   ```powershell
   Set-Content -Path "$env:TEMP\kakao-pw.txt" -Value "비밀번호" -NoNewline
   agent-kakaotalk auth login --email <이메일> --password-file "$env:TEMP\kakao-pw.txt"
   ```
3. **폰 확인 코드** — `{"next_action":"confirm_on_phone","passcode":"1234"}` 가 나오면
   **폰 카카오톡에서 그 숫자를 확인**한다. CLI가 폴링하다 자동 완료한다.
4. 완료되면 `{"authenticated":true,...}` 가 출력된다.

자주 나오는 응답:

| 응답 | 의미 / 조치 |
|---|---|
| `authenticated: true` | 성공. 다음 단계로 |
| `next_action: provide_email` | 앱 캐시에 이메일이 없음 → `--email` 로 지정 |
| `next_action: provide_password` | 비밀번호 필요 → 다이얼로그로 입력하거나 `--password-file` |
| `next_action: confirm_on_phone` | **폰에서 패스코드 확인** (창을 닫지 말고 대기) |
| `error: registration_timeout` | 코드 만료 → `auth login` 다시 실행 |
| `error: bad_credentials` | 비밀번호 오류. `--force` 로 슬롯 바꾸지 말고 자격증명을 다시 확인 |
| `error: login_failed` (슬롯 충돌) | `--device-type pc --force` 또는 `--device-type tablet --force` |

인증 확인:

```powershell
agent-kakaotalk auth status     # authenticated / device_type / refresh 토큰 보유 여부
agent-kakaotalk whoami          # user_id, account_display_id 확인
```

자격증명은 `~/.config/agent-messenger/kakaotalk-credentials.json` (0600)에 저장된다.

## 3. 대상 대화 확정 (chat_id 확보)

```powershell
agent-kakaotalk chat list --pretty                        # chat_id / type / unread_count 확인
agent-kakaotalk message list <CHAT_ID> -n 5 --pretty      # 읽기 테스트
agent-kakaotalk message send <CHAT_ID> "bridge test"      # 쓰기 테스트
```

- **처음엔 "나와의 채팅"** 으로 테스트하면 안전하다 (남에게 안 보임).
  `chat list` 에서 `type` 이 `MemoChat` 인 방이 "나와의 채팅"이다.
- 출력은 JSON 배열이며 각 메시지에 `log_id`, `type`, `author_id`, `author_name`, `message`, `sent_at` 가 있다.
- `message list` 는 페이지네이션을 내부 처리하니 `-n` 만 늘리면 된다 (최대 ~4,000개).

## 4. opencode-webui 실행 API 준비

브라우저에서 opencode-webui를 열고 **`/expose` 페이지**에서 실행용 커맨드를 등록한다.
(Teams 가이드 4단계와 동일 — 자세한 설명은 그쪽 참고)

1. 실행할 슬래시 커맨드(예: `/ask`)에 `exposeName` 지정 (예: `kakao-ask`), enabled ON
2. `sessionMode` 선택: `new`(매번 새 세션) 또는 `reuse` + `pinnedSessionId`(대화 이어가기)
3. **권한 사전 허용 (중요)**: 무인 실행이라 승인 카드에서 멈추면 답이 안 온다.
   필요한 도구를 미리 룰로 허용 (Settings → Permissions)

동작 확인:

```powershell
$B = "http://127.0.0.1:5001"   # .env PORT 확인 (exe 기본 5002)
Invoke-RestMethod "$B/api/public/commands/kakao-ask/run" -Method Post `
  -ContentType "application/json" `
  -Body (@{ repoId = 8; args = "ping" } | ConvertTo-Json)
# → { success, sessionId, ... }
```

## 5. 브릿지 스크립트 (PC 상주)

실행 스크립트는 저장소에 있다: **`scripts/kakao-bridge.ps1`**

```powershell
# 기본값으로 실행 (chat_id 를 비우면 "나와의 채팅"(MemoChat)을 자동 선택)
powershell -NoProfile -File .\scripts\kakao-bridge.ps1

# 명시적으로 지정
powershell -NoProfile -File .\scripts\kakao-bridge.ps1 `
  -ChatId 129784894687551 -Expose kakao-ask -RepoId 1 `
  -Model a/deepseek-ai/deepseek-v4.1-flash -PollSec 15
```

| 파라미터 | 기본 | 설명 |
|---|---|---|
| `-Backend` | `http://127.0.0.1:5001` | 백엔드 주소 (.env PORT, exe 기본 5002) |
| `-ChatId` | (자동) | 비우면 `chat list` 에서 첫 `MemoChat` 선택 |
| `-Expose` | `kakao-ask` | exposeName |
| `-RepoId` | `1` | 처리할 레포 id |
| `-Model` | (기본) | **권장** — 예: `a/deepseek-ai/deepseek-v4.1-flash` |
| `-PollSec` | `15` | 폴링 주기 |
| `-StateFile` | `%TEMP%\kakao-bridge.json` | 마지막 log_id / lastSent 저장 |

> 스크립트 주의점 (구현 시 겪은 함정)
> - **PowerShell 변수명은 대소문자를 구분하지 않는다.** 상태 파일 파라미터를 `-State` 로 두면
>   내부 상태 해시테이블 `$state` 와 **같은 변수**가 되어 서로 덮어쓴다 → `-StateFile` 로 분리.
> - **`$args` 는 예약 변수**다. CLI 인자 배열에 쓰면 안 되고 `$cliArgs` 등으로 둔다.
> - **네이티브 CLI 출력은 UTF-8** 이다. 스크립트 시작에서
>   `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` 을 설정하지 않으면
>   한글 메시지가 깨져 `ConvertFrom-Json` 이 실패한다.

### 반드시 알아야 할 두 가지 (실측)

**1. `-Model` 을 지정하라.**
비우면 세션 기본 모델로 가는데, 그 모델이 계정에서 사용 불가면 조용히 실패한다:
```
APIError: Not Found: Function '...': Not found for account '...'   (NVIDIA 404)
```
`chat list`/모델 목록에서 실제로 동작하는 모델 id 를 넣는다.

**2. "나와의 채팅"에서는 발신자로 자기 메시지를 구분할 수 없다.**
MemoChat 은 모든 메시지의 `author_id` 가 나 자신이라, `author_id == whoami.user_id`
로 거르면 **폰에서 보낸 메시지까지 걸러진다.** 그래서 스크립트는
`[kakao-bridge]` 접두와 `lastSent` log_id 로만 자기 응답을 차단한다.
(폰에서 보낸 메시지에는 접두가 없으므로 정상 통과)

## 6. 보안 주의

- 백엔드 API에 인증이 없다 → `HOST`는 `127.0.0.1` 유지, 백엔드 포트를 외부에 개방하지 않는다.
- 카카오 자격증명은 `~/.config/agent-messenger/kakaotalk-credentials.json` (0600)에 있다.
  PC 잠금/계정 암호는 필수다. 이 파일을 복사해 다른 PC에서 쓰면 refresh 토큰이 회전하며 깨질 수 있다.
- **브릿지는 "나"로 메시지를 보낸다.** 단톡방에 연결하면 답변이 방 전체에 보인다.
  처음엔 "나와의 채팅" 또는 1:1로만 테스트한다.
- 무인 실행이므로 `expose` 는 필요한 것만 enabled 로 두고, 권한은 최소 범위로 허용한다.

## 7. 트러블슈팅

| 증상 | 확인 |
|---|---|
| `No KakaoTalk credentials found` | `agent-kakaotalk auth login` |
| `bad_credentials` | 비밀번호 오류. `--force` 로 슬롯 바꾸지 말고 `--email`/`--password-file` 로 다시 로그인 |
| `login_failed` (슬롯 충돌) | 태블릿 슬롯 점유 → `--device-type pc --force` 또는 `--device-type tablet --force` |
| 폰 확인 코드가 안 옴 / 만료 | `auth login` 다시 실행 → 새 코드 |
| 브릿지가 자기 답에 반응(무한루프) | 스크립트에 `author_id == whoami.user_id`, `lastSent`, `[kakao-bridge]` 접두 3중 차단이 있음. 그래도 돌면 브릿지 중지 후 `$STATE` 삭제 |
| 답이 안 오고 세션 멈춤 | 권한 대기 가능성 → PC 화면 승인 카드 확인, 무인용은 룰 사전 허용(4단계) |
| `message list` 가 빈 배열 | chat_id 오타 또는 잘못된 계정. `chat list --pretty` 로 재확인 |
| 특정 기능 안 됨 | 카카오는 검색·반응·수정·삭제·오픈채팅 탐색 미지원 (5단계 표 참고) |
| 백엔드 연결 실패 | `.env` PORT와 `$BACKEND` 일치 확인 (`5001` dev / exe 기본 `5002`). 방화벽 불필요(localhost) |
| PC 절전 | 전원 "절전 안 함" + 카카오톡/백엔드/브릿지 3개 상주 확인 |

## 참고

- agent-kakaotalk 명령어 전체: https://github.com/agent-messenger/agent-messenger/blob/main/skills/agent-kakaotalk/SKILL.md
- opencode-webui 실행 API: `POST /api/public/commands/:exposeName/run`
  (`{repoId?, directory?, args?, sessionId?, agent?, model?}`), 결과는
  `GET /api/session-messages/:sessionId/recent`, 진행은 `GET /api/session-status`
- expose 등록 UI: `/expose` 페이지
