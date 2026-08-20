# Agent / 업무 도우미 도메인 모델 가이드

opencode-webui는 **opencode를 기반**으로 "AI가 업무를 대신 처리해주는 업무 도우미" 역할을 목표로 합니다.
opencode의 고유 구조(프로젝트·에이전트·커맨드·스킬)를 그대로 유지하면서, 코딩 전용 개념을 아래처럼 **업무 도우미용 개념으로 치환**합니다.

## 개념 치환표

| 사용자(업무) 개념 | opencode 구조 | 설명 |
| --- | --- | --- |
| **업무 (Business Task)** | `project` | 하나의 업무 단위 (예: 월간보고, 모니터링, 장애 대응). 각 작업 공간(디렉터리)과 대응하며, **하나의 담당자(agent)가 전담 처리**. |
| **동일 권한 관리** | `agent` | 같은 권한·모델·도구 세트를 묶는 단위. 특정 담당(에이전트)이 쓰는 도구/권한/MCP를 정의. command와 유사하게 수행 흐름을 별도 시스템 프롬프트 + 툴 권한으로 독립 실행 환경을 만들고, 생성한 에이전트를 사용하면 커맨드 없이도 유사한 흐름으로 수행하게 함. 또한 커맨드 수행시 더 제한된 범위에서 동작하도록 함. |
| **작업 시작 명령어** | `command` | 내부·외부에서 작업을 시작하는 진입점. 예) `/월간보고 n월 gsp 시스템` → "n월 gsp 시스템" 대상 작업 시작. 여러 스킬의 절차(워크플로)로 구성됨. |
| **업무 스텝** | `skill` | 업무에서 하나의 단계. 사용할 tool·MCP를 제한함. 다른 스킬을 다시 호출(재사용)할 수 있는지 등을 정의. |

### 종속성 흐름
```
command (작업 시작)
   └─ skill ① (스텝) ─ tool/MCP 제한
   └─ skill ② (스텝) ─ tool/MCP 제한  ← 다른 skill 재호출 가능
   └─ ...
   → 업무(project) 결과 산출
```

- **project (업무)**: 한 번의 명령 실행 단위이자 결과/문서 저장 공간. **하나의 담당자(agent)가 전담 처리**한다.
- **command (진입점)**: 사용자/외부 시스템이 실제로 입력하는 최소 인터페이스. 인자를 받아 어떤 skill을 어떤 순서로 실행할지 정의.
- **skill (스텝)**: 각 stage의 절차이자 **권한·도구 격리** 단위. 특정 스킬이 어떤 tool/MCP에만 접근하도록 제한해 실수를 방지하고, 필요한 경우 다른 스킬을 조합 재호출.
- **agent (권한 관리)**: skill/command가 실제로 쓰는 도구·권한(edit/bash/webfetch/MCP)·모델을 담당별로 묶은 것. command와 유사하게 **별도 시스템 프롬프트와 허용된 툴 권한을 가진 독립 실행 환경**이라, 커맨드를 더 제한적으로 수행시킬 수 있다.

## 채팅 기반 자동화 등록 (md 파일)

이 앱의 자동화(command/skill/agent)는 **md 파일**로 등록한다(JSON config 아님).
위치는 두 가지다:

| 범위 | 위치 | 기본 여부 |
| --- | --- | --- |
| 프로젝트 (특정 작업공간) | `<repo>/.opencode/{agents,commands,skills,plugins}/` | **기본(권장)** |
| 전역 (모든 세션) | `workspace/.config/opencode/{agents,commands,skills,plugins}/` | 특별한 경우에만 |

**기본적으로는 프로젝트(레포) 단위로 등록**한다. `npm run dev`와 명령 패널의
"Register new opencode file" 다이얼로그도 프로젝트 범위를 기본으로 쓴다. 전역 범위는
"모든 작업공간에서 항상 쓰는" 경우에만 사용한다(예: 모든 업무에서 공통으로 쓰는 문서 도구).
이유: 프로젝트 단위 파일은 `<repo>/.opencode/` 안에 있어 **git으로 버전 관리**되고,
작업공간 별로 다른 자동화를 가질 수 있다. 전역 파일은 `workspace/`(gitignore)에 있어
**삭제·유실 시 복구할 수 없다**.

opencode는 **복수형 디렉터리**(`agents/`, `commands/`, `skills/`, `plugins/`)를 정식 규약으로
스캔한다. 단수형(`agent/`, `command/`, `skill/`)도 하위호환으로 지원되지만, 앱의 레지스트리
(명령 패널 → Register new opencode file)는 **복수형**으로 파일을 쓴다.

| 종류 | 파일 | 형식 |
| --- | --- | --- |
| command (작업 시작) | `commands/<이름>.md` | 본문만 (실행할 skill 순서와 인자 설명). 권장: 선택적으로 `description` frontmatter 추가 |
| skill (업무 스텝) | `skills/<이름>/SKILL.md` | frontmatter `name`/`description` + 본문 |
| agent (권한 묶음) | `agents/<이름>.md` | frontmatter `description`/`mode`(all·subagent·primary) + 본문(시스템 프롬프트) |
| plugin (도구) | `plugins/<이름>.ts` | TypeScript (opencode plugin) |

**중요 — skill/agent/plugin은 "폴더 + 지정 파일" 구조, command는 "폴더 안의 .md 파일"이다.**

- **skill은 반드시 폴더 구조**: `skills/<이름>/SKILL.md`. `skills/<이름>.md`처럼
  skills 폴더에 .md 파일을 직접 두면 인식되지 않는다.
- **command는 .md 파일**: `commands/<이름>.md`.
- **agent는 .md 파일**: `agents/<이름>.md`.
- **plugin은 .ts 파일**: `plugins/<이름>.ts`.

### 생성 위치 → scope(범위) 판별 규칙

명령 패널에 표시되는 scope는 **파일이 "어디에" "어떤 구조로" 있는지**로 결정된다.
파일을 만들기 전에 아래 표로 목적에 맞는 위치를 고른다.

| scope | 판별 조건 | 편집/삭제 |
| --- | --- | --- |
| **project** | `<repo>/.opencode/{commands,skills,agents,plugins}/` 안에 위 형식의 파일이 존재 | 가능 (기본 목표) |
| **global** | `workspace/.config/opencode/{commands,skills,agents,plugins}/` 안에 존재, 또는 opencode.json의 `command`/`agent` 키로 정의됨 | 가능 |
| **built-in** | 위 어디에도 파일이 없음 — opencode가 기본 제공 (`init`, `review`, `customize-opencode` 등) | **불가** (배지로만 표시) |

혼동하기 쉬운 사례: `customize-opencode`처럼 파일이 없는 항목은 built-in으로
표시되며 delete/edit 버튼이 나오지 않는다. "빌트인인데 왜 global로 보이지?"
하는 헷갈림을 막으려면, 생성 시 **반드시 파일을 의도한 위치에 정확한 구조로
만들어야 한다** (예: `skills/<이름>/` 폴더를 만들고 그 안에 `SKILL.md`를 쓴다).

**주의 — agent frontmatter의 `tools`는 배열이 아니다.** opencode의 agent `tools` 필드는
`{도구명: true}` 객체만 허용하며(배열이면 `ConfigInvalidError` → **해당 레포의 command/skill/agent
전체가 한 번에 로드 실패**하고 커맨드 목록이 비어 보인다) 본질적으로 **deprecated**다.
도구/권한 제한은 `permission` 필드(`edit: allow` 등)로 하고, 되도록 `tools`는 쓰지 않는다.

### 자동화 설계 순서 (단계별 사용자 확인)

**먼저 "무엇을 자동화할지" 업무 목표를 확인**하고, 아래 순서로 **툴 → 스킬 → 커맨드**를
설계한다. **각 단계에서 설계 초안을 보여주고 사용자 확인을 받은 뒤** 다음 단계로 넘어간다.

1. **목표 확인** — 무엇을 처리하는 작업인가? (예: 월간보고, 모니터링) 결과물은 무엇인가?
2. **필요한 툴** — 작업에 어떤 tool/MCP가 필요한가? 아래 순서로 **우선 확보 방안을 찾는다**:
   1. **내 MCP 확인** — 이미 등록된 MCP 서버에 해당 기능이 있는지.
   2. **git에서 exe/릴리즈로 제공되는 도구** 확인 — 릴리즈 바이너리로 바로 쓸 수 있는지.
   3. **git 소스로 제공되는 도구** 확인 — 소스 clone/build가 가능한지.
   4. **직접 개발** — 위에서 없을 때만 고려하며, **개발은 최대한 지양**하고 필요하면
      반드시 **사용자 확인**을 받는다.
   → 사용자 확인
3. **스킬 설계** — 툴을 조합한 업무 스텝(skill) 단위로 나눈다. 각 스킬의 입력/출력과
   접근 가능한 tool/MCP를 정의한다. → 사용자 확인
4. **커맨드 설계** — 스킬을 순서대로 엮는 시작 명령어(command)와 인자(입력) 형식,
   트리거 문구를 정의한다. → 사용자 확인
5. **담당 agent 정의** — 모드(all/subagent/primary), 모델, 허용 도구·권한
   (edit/bash/webfetch/MCP)을 정의한다. **특히 스킬 결과가 예상과 다를 때(오류·실패)의
   처리를 결정한다: 알림을 줄지, 어떤 방식(채팅/노티)으로, 재시도할지 중단할지.**
   → 사용자 확인
6. **(선택, default: 생성 안 함) agent도 함께 생성할까?** — `agent로도 생성을 할까요?`
   질문으로 **기본값은 "생성 안 함"**이며, 사용자가 원할 때만 만든다.
   agent는 command와 유사하지만, **별도의 시스템 프롬프트와 허용된 툴 권한을 가진
   독립 실행 환경**이다. 이 agent를 사용하는 세션에서 커맨드를 수행하면 해당
   커맨드를 더 **제한된 도구·권한 안에서** 수행한다. 예: 커맨드는 절차만 정의하고,
   실제 도구 사용은 전용 agent(권한 묶음)가 선택된 세션에서 격리. → 사용자 확인

### 내장 MCP 도구 (이미 등록되어 바로 사용 가능)

- **doc-reader** — `read_document(path)` / `edit_document(path, operations)`로
  Office/PDF(DRM 포함) 파일 읽기·편집.
- **agent-browser** — `agent_browser_*` 도구(open/snapshot/click/fill/type/
  screenshot 등)로 실제 브라우저 자동화. 네비게이션 후에는 클릭/입력 전에
  `agent_browser_snapshot`으로 안정적인 요소 참조를 얻는다.
- 설치·업데이트: `npm run agent-browser:install` / `npm run agent-browser:update`
  (별도 다운로드·전역 설치 불필요 — `bin/agent-browser/`에 바이너리+Chromium 번들).

모든 항목이 확인되면 위 "등록 방법"대로 등록한다.

### 등록 방법

- 파일 쓰기가 가능한 세션이면 **해당 경로에 직접 파일을 작성**한다
  (**기본은 프로젝트 `<repo>/.opencode/`, 전역은 `workspace/.config/opencode/`**).
  특별한 이유가 없으면 프로젝트 단위로 만든다.
- **구조를 정확히 지켜라**: skill은 `skills/<이름>/SKILL.md` **폴더**를 만들고 그
  안에 쓴다(폴더 없이 `skills/<이름>.md`로 두면 인식·scope 판별이 안 됨), command는
  `commands/<이름>.md`, agent는 `agents/<이름>.md`, plugin은 `plugins/<이름>.ts`.
- 파일을 쓸 수 없으면 **완성된 md 내용을 채팅에 출력**하고, 사용자가
  "명령 패널 → Register new opencode file" 다이얼로그에 복사하도록 안내한다.
- 작성 후에는 해당 파일을 읽어 **검증**한다. opencode는 자동화 파일을 **인스턴스 단위로
  캐시**하지만, 이 앱의 백엔드가 `commands/·skills/·agents/·plugins/` 파일 변경을
  감시해 해당 프로젝트 인스턴스만 **자동으로 리로드**(`/instance/dispose`, 약 1.5초)하므로
  사용자가 수동 재시작을 할 필요는 없다(전역 `workspace/.config/opencode/` 변경 시에는
  모든 레포 인스턴스를 리로드). 세션·진행 중 요청은 유지된다.
  **bin/opencode.exe는 ≥ 1.18 버전이어야 한다**(per-instance reload 지원).

## 운영 시 주의 (반드시 숙지)

이 항목들은 앱 구조 때문에 발생하는 동작이므로 **오해하지 않도록** 미리 알아둔다.

1. **`workspace/`는 git에 추적되지 않는다.** 루트 `.gitignore`가 `workspace/` 전체를 무시하므로
   `workspace/.config/opencode/{agents,commands,skills,plugins}/` 안의 자동화 파일도
   **버전 관리 대상이 아니다.** 삭제되면 복구할 수 없다(이전 git에도 없음). 그래서
   **기본 등록 범위는 프로젝트(`<repo>/.opencode/`)**로 하며, 영구 보존이 필요한
   command/skill/agent는 저장소 안에 git으로 관리되도록 한다. 전역 파일만으로 만들 필요는
   없고, 사용자에게 백업 필요를 안내한다.
2. **`workspace/.config/opencode/opencode.json`은 백엔드 시작 시 DB에서 재생성된다.**
   `syncDefaultConfigToDisk()`가 DB의 기본 config를 이 파일로 다시 쓴다. MCP 기본값
   (doc-reader, agent-browser)은 `backend/src/services/default-mcp.ts`의
   `mergeDefaultMcpEntries()`가 **없으면 병합하고, 기존 항목도 canonical 절대경로 커맨드로
   보수한다**(doc-reader는 반드시 `backend/scripts/doc_reader_mcp.py` 절대경로 — 상대경로
   `..\backend\...`는 repo 세션에서 스크립트를 못 찾아 실패, agent-browser는
   `bin/agent-browser/.meta.json` 기준 이진 경로) + `enabled: true` 강제.
   따라서 MCP는 이 파일을 직접 수정하지 말고 앱 설정(또는 DB)으로 관리한다.
   **단, 전역 병합은 repo 루트의 `opencode.json`에는 적용되지 않는다.**
2b. **레포별 브라우저 격리**: 각 repo 루트(`workspace/repos/<repo>/opencode.json`)에
   백엔드가 `agent-browser` 항목만 **공용 namespace(`opencode`) + repo 전용 세션
   (`repo-<localPath>`)으로 직접 기록/병합**한다(`writeRepoOpenCodeConfig()`).
   repo가 클론/생성될 때마다 쓰고, 백엔드 시작 시 모든 기존 repo에도 보장한다.
    모든 repo가 데몬 하나(`opencode`)를 공유하되 **세션마다 CDP 브라우저 컨텍스트가
    분리**되어(쿠키/스토리지/상태 격리, 네임스페이스당 Chrome 트리 1개 공유) 서로의 탭이
    공유/비는 문제가 없다. 전역 동기화가 이 파일을 덮어쓰지 않으므로 repo 자신의 config
   키는 보존되고, 기존 `enabled: false`도 보존되어 repo에서 MCP를 끌 수 있다.
   브라우저 탭이 비거나 섞이면 `workspace/repos/<repo>/opencode.json`에 repo 전용
   `AGENT_BROWSER_SESSION`이 있는지 먼저 확인한다.
3. **MCP가 잠시 "disabled"로 보일 수 있다.** 등록 직후 opencode가 서버를 띄우고 도구를
   불러오는 몇 초 동안 web UI가 `disabled` 상태로 표시하며, 연결 완료 후 `connected`로
   바뀐다. 오류가 아니며 MCP 항목은 항상 `enabled: true`로 등록한다.
4. **이전 버그**: 백엔드가 DB 내용으로 config를 덮어써서 디스크에 수동 추가한 MCP가
   사라지던 문제를 병합(merge)으로 해결했다. 이제 시작 시마다 기본 MCP가 자동 보존된다.
5. **백엔드 API 문서**: exe 배포 후 소스 분석 불가 문제를 해결 위해 런타임에 조회 가능:
   - `GET /api/openapi.json` — 전체 백엔드 라우트 OpenAPI 3.1 스펙
   - `GET /api/docs` — Swagger UI (CDN 기반, 오프라인 시 JSON 직접 조회)

## 반복 업무 (스케줄링)

반복적으로 실행할 업무(예: 매일 아침 월간보고, 매시간 모니터링)는 **PC의 cron이나
Windows 작업 스케줄러를 직접 구성하지 말고**, 이 앱의 **스케줄 기능**을 이용한다.

- **UI**: 레포 상세 → **Schedules** 다이얼로그 (Project Schedules)
- **API**: `POST /api/schedules` (백엔드가 30초마다 체크해 실행) — 문서: `GET /api/openapi.json`, `GET /api/docs` (Swagger UI)

### 배치(스케줄) 등록 API

사용자가 `bash`/`webfetch` 도구로 직접 호출해 스케줄을 등록·수정·삭제할 수 있다.
백엔드는 `5001`, opencode는 `5552`. 커맨드 실행은 `/api/opencode` 프록시를 이용한다.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/api/schedules?repoId=<id>` | 목록 (repoId 필터 선택) |
| `POST` | `/api/schedules` | 생성 |
| `PUT` | `/api/schedules/{id}` | 수정 (부분 업데이트) |
| `DELETE` | `/api/schedules/{id}` | 삭제 |
| `POST` | `/api/schedules/{id}/run` | 즉시 실행 |

**POST /api/schedules 요청 본문:**

```json
{
  "repoId": 3,
  "name": "오늘경제요약",
  "action": "command",
  "command": "/오늘경제요약",
  "cron": "0 8 * * 1-5",
  "enabled": true,
  "activeFrom": null,
  "activeUntil": null,
  "agent": "economy-summary"
}
```

| 필드 | 설명 |
| --- | --- |
| `repoId` | 스케줄을 실행할 레포 id (`GET /api/repos`로 확인) |
| `name` | 스케줄 이름 |
| `action` | `command`(커맨드 실행) 또는 `chat`(프롬프트 실행) |
| `command` | `action=command`일 때, 실행할 커맨드 이름(`/이름`) |
| `prompt` | `action=chat`일 때, 전송할 프롬프트 |
| `cron` | 5필드 cron (분 시 일 월 요일) |
| `agent` | 실행할 담당 agent (선택) |
| `enabled` | 활성화 여부 (기본 true) |
| `activeFrom` / `activeUntil` | 활성 기간 (밀리초, 선택) |

- 실행 시 해당 레포 작업공간에 `[BATCH]<이름>_YYYYMMDD-HHMM` 세션이 생성되어
  커맨드 또는 프롬프트가 실행된다.
- 즉시 실행: `POST /api/schedules/{id}/run` 또는 다이얼로그의 **Run now**.
- 스킬 실패/이상 시 알림 여부·방식은 위 설계 순서 5단계(담당 agent 정의)에서 결정한다.
- 레포 id 조회: `GET /api/repos` → `[{"id":3,"name":"일일요약",...}]`.

### 자동화 파일 변경 시 자동 리로드 (automation watcher)

- `repos/<repo>/.opencode/{agents,commands,skills,plugins}` 하위 또는
  `workspace/.config/opencode/{agents,commands,skills,plugins}` 하위에 파일이
  추가/변경/삭제되면 백엔드가 해당 프로젝트 인스턴스만 **자동 리로드**하여
  새 커맨드/스킬/에이전트를 즉시 반영한다(디바운스 1.5초, 리로드 간 최소 10초).
  리로드는 `POST /instance/dispose?directory=<repo>`로 수행하므로 **opencode 프로세스를
  재시작하지 않는다** — 세션·진행 중 작업은 유지된다.
- **전역(`workspace/.config/opencode/`) 변경**은 모든 프로젝트에 영향을 주므로
  workspace 루트 + 모든 레포 인스턴스를 함께 리로드한다.
- **`node_modules`·`.git`·`dist` 등은 무시**하므로 패키지 설치 노이즈로 리로드하지 않는다.
- **활성 세션 보호**: 진행 중인 요청(메시지/커맨드/질문 응답)이 있으면 리로드를 **미루고**
  대기하다가 idle이 되면 실행한다. 따라서 배치(스케줄) 실행 중 커맨드 파일을 만들어도
  실행 중인 세션이 죽지 않는다. 오래 busy면(최대 10분) 이번 변경은 건너뛴다.
- **전제 버전**: per-instance reload는 opencode **≥ 1.18**에서 지원된다(`bin/opencode.exe`
  가 그 이하라면 자동 리로드가 동작하지 않으므로 README의 현재 버전을 확인한다).
- 직접 재시작이 필요한 경우: 설정에서 opencode 바이너리 재설정 또는 앱 재시작을 이용한다.

## 기본(어시스턴트) 시스템 프롬프트
아래는 위 개념을 기본 어시스턴트(general agent)에 적용하기 위한 시스템 프롬프트입니다.

```markdown
You are the 업무 도우미 assistant of opencode-webui, built on opencode.

도메인 개념 치환 (opencode 구조 유지):
- project  = 업무 단위 (월간보고, 모니터링, 장애 대응 등 하나의 업무)
- agent    = 동일 권한·모델·도구 묶음 (권한 관리 단위)
- command  = 내부/외부에서 작업을 시작하는 명령어. 여러 skill의 절차(워크플로)로 구성됨.
             예: "/월간보고 n월 gsp 시스템" 형태로 인자("n월 gsp 시스템")를 받아 시작.
- skill    = 업무의 하나의 스텝. 사용할 tool·MCP를 제한하며, 필요 시 다른 skill을 재호출 가능.

역할:
1. 사용자가 업무(예: 월간보고, 모니터링)를 만들거나 수정하면, **먼저 무엇을 자동화할지 목표를
   확인**하고 **툴 → 스킬 → 커맨드 순으로** project·command·skill·agent 구조로 설계한다.
   **각 단계에서 초안을 보여주고 사용자 확인을 받은 뒤** 다음 단계로 넘어간다. 툴은
   **내 MCP → git exe/릴리즈 → git 소스** 순으로 확보 방안을 찾고, **직접 개발은 최대한
   지양**하며 필요 시 사용자 확인을 받는다.
2. **agent 생성은 선택이며 기본값은 "생성 안 함"이다.** command/skill 설계가 끝난
   **마지막 단계**에서 "agent도 함께 생성할까요? (기본: 안 함)"라고 **한 번만** 확인한다.
   원하지 않으면 agent 없이 command/skill만 등록한다. 만들겠다는 응답을 받은 **뒤에만**
   바로 파일을 쓰지 말고 아래 필드를 **하나씩 대화형으로 확인**한다: 이름(name)·
   설명(description), mode(subagent/primary/all), 모델(model), 허용 도구
   (tools: write/edit/bash/webfetch), 권한(permission: edit/bash/webfetch →
   ask/allow/deny), 그리고 **스킬 결과가 예상과 다를 때(오류·실패)의 처리: 알림 여부와 방식,
   재시도/중단 여부**. 모든 항목을 확인한 뒤에야 `agents/<이름>.md`
   (frontmatter `description`/`mode` + 본문=시스템 프롬프트)로 생성한다.
3. command를 정의할 때는 실행할 skill들의 순서와 인자 입력 형식("n월 gsp 시스템")을 명확히 한다.
4. skill을 정의할 때는 해당 스텝이 접근 가능한 tool/MCP와, 다른 skill을 재호출할지 여부를 명시한다.
5. 반복 업무(스케줄) 요청 시 PC cron/Windows 작업 스케줄러를 직접 만들지 않고, 이 앱의
   스케줄 기능으로 처리한다. 사용자가 배치 등록을 요청하면 **`POST /api/schedules`** API를
   직접 호출해 등록한다(위 "배치(스케줄) 등록 API" 참고: repoId는 `GET /api/repos`로 확인,
   action `command`는 `command` 필드에 `/커맨드이름`, `chat`은 `prompt`에 프롬프트, cron은
   5필드). 완료 후 등록 결과를 보고한다.
6. 불명확하면 짧은 질문으로 다듬고, 필요한 설정(Markdown)을 생성한다.
7. 요청받은 등록 파일(command/skill/agent md, plugin ts)은 위 "채팅 기반 자동화 등록" 규칙대로
   **기본적으로 프로젝트 단위(`<repo>/.opencode/`)**로 직접 작성하거나 내용을 출력한다.
   그 외 불필요한 코드 파일은 새로 만들지 않는다. 제공된 도구
   (read/edit/glob/grep/bash/webfetch/websearch 등)만으로 작업을 수행하고 완결한다.
```

## 적용 방법 요약
- 기본 어시스턴트에 반영: opencode config의 `agent.general.prompt` 에 위 프롬프트를 넣는다.
- **자동화 파일은 특별한 이유가 없으면 프로젝트 단위(`<repo>/.opencode/`)로 만든다.** (git 버전 관리 대상)
- 조직별 담당 단위(권한 관리)를 만들 때: 프로젝트는 `<repo>/.opencode/agents/<이름>.md`,
  전역은 `workspace/.config/opencode/agents/<이름>.md` 를 작성한다.
- 작업 시작 명령어를 만들 때: 프로젝트는 `<repo>/.opencode/commands/<이름>.md`,
  전역은 `workspace/.config/opencode/commands/<이름>.md` 를 작성한다.
- 업무 스텝을 정의할 때: 프로젝트는 `<repo>/.opencode/skills/<이름>/SKILL.md`,
  전역은 `workspace/.config/opencode/skills/<이름>/SKILL.md` 를 작성한다.