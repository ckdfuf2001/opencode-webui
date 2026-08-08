# Agent / 업무 도우미 도메인 모델 가이드

opencode-webui는 **opencode를 기반**으로 "AI가 업무를 대신 처리해주는 업무 도우미" 역할을 목표로 합니다.
opencode의 고유 구조(프로젝트·에이전트·커맨드·스킬)를 그대로 유지하면서, 코딩 전용 개념을 아래처럼 **업무 도우미용 개념으로 치환**합니다.

## 개념 치환표

| 사용자(업무) 개념 | opencode 구조 | 설명 |
| --- | --- | --- |
| **업무 (Business Task)** | `project` | 하나의 업무 단위 (예: 월간보고, 모니터링, 장애 대응). 각 작업 공간(디렉터리)과 대응하며, **하나의 담당자(agent)가 전담 처리**. |
| **동일 권한 관리** | `agent` | 같은 권한·모델·도구 세트를 묶는 단위. 특정 담당(에이전트)이 쓰는 도구/권한/MCP를 정의. |
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
- **agent (권한 관리)**: skill/command가 실제로 쓰는 도구·권한(edit/bash/webfetch/MCP)·모델을 담당별로 묶은 것.

## 채팅 기반 자동화 등록 (md 파일)

이 앱의 자동화(command/skill/agent)는 **md 파일**로 등록한다(JSON config 아님).
위치는 두 가지다:

| 범위 | 위치 |
| --- | --- |
| 전역 (모든 세션) | `workspace/.config/opencode/{command,skill,agent,plugin}/` |
| 프로젝트 (특정 작업공간) | `<repo>/.opencode/{command,skill,agent,plugin}/` |

| 종류 | 파일 | 형식 |
| --- | --- | --- |
| command (작업 시작) | `command/<이름>.md` | 본문만 (실행할 skill 순서와 인자 설명) |
| skill (업무 스텝) | `skill/<이름>/SKILL.md` | frontmatter `name`/`description` + 본문 |
| agent (권한 묶음) | `agent/<이름>.md` | frontmatter `description`/`mode`(all·subagent·primary) + 본문(시스템 프롬프트) |
| plugin (도구) | `plugin/<이름>.ts` | TypeScript (opencode plugin) |

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

모든 항목이 확인되면 위 "등록 방법"대로 등록한다.

### 등록 방법

- 파일 쓰기가 가능한 세션이면 **해당 경로에 직접 파일을 작성**한다
  (전역은 `workspace/.config/opencode/`, 프로젝트는 `<repo>/.opencode/`).
- 파일을 쓸 수 없으면 **완성된 md 내용을 채팅에 출력**하고, 사용자가
  "명령 패널 → Register new opencode file" 다이얼로그에 복사하도록 안내한다.
- 작성 후에는 해당 파일을 읽어 **검증**하고, 반영이 안 되면 opencode 서버 재시작이나
  UI 다이얼로그 등록을 안내한다.

## 반복 업무 (스케줄링)

반복적으로 실행할 업무(예: 매일 아침 월간보고, 매시간 모니터링)는 **PC의 cron이나
Windows 작업 스케줄러를 직접 구성하지 말고**, 이 앱의 **스케줄 기능**을 이용한다.

- **UI**: 레포 상세 → **Schedules** 다이얼로그 (Project Schedules)
- **API**: `POST /api/schedules` (백엔드가 30초마다 체크해 실행)

스케줄 구성 항목:

| 항목 | 설명 |
| --- | --- |
| `name` | 스케줄 이름 |
| `action` | `command`(커맨드 실행) 또는 `chat`(프롬프트 실행) |
| `command` / `prompt` | 실행할 커맨드 이름(`/이름`) 또는 프롬프트 |
| `cron` | 5필드 cron (분 시 일 월 요일) |
| `agent` | 실행할 담당 agent (선택) |
| `enabled` | 활성화 여부 |
| `activeFrom` / `activeUntil` | 활성 기간 (선택) |

- 실행 시 해당 레포 작업공간에 `[BATCH]<이름>_YYYYMMDD-HHMM` 세션이 생성되어
  커맨드 또는 프롬프트가 실행된다.
- 즉시 실행: `POST /api/schedules/{id}/run` 또는 다이얼로그의 **Run now**.
- 스킬 실패/이상 시 알림 여부·방식은 위 설계 순서 5단계(담당 agent 정의)에서 결정한다.

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
2. 담당 agent를 정의할 때 대화형으로 아래 항목을 물어 정리하고, **md 파일 형식**
   (`agent/<이름>.md`: frontmatter `description`/`mode`(subagent/primary/all) + 본문 =
   시스템 프롬프트)으로 제공한다: 이름(name), 설명(description), 모델(model),
   도구(tools: write/edit/bash/webfetch), 권한(permission: edit/bash/webfetch →
   ask/allow/deny), 그리고 **스킬 결과가 예상과 다를 때(오류·실패)의 처리: 알림 여부와 방식,
   재시도/중단 여부**.
3. command를 정의할 때는 실행할 skill들의 순서와 인자 입력 형식("n월 gsp 시스템")을 명확히 한다.
4. skill을 정의할 때는 해당 스텝이 접근 가능한 tool/MCP와, 다른 skill을 재호출할지 여부를 명시한다.
5. 반복 업무(스케줄) 요청 시 PC cron/Windows 작업 스케줄러를 직접 만들지 않고, 이 앱의
   스케줄 기능(레포 상세 Schedules 다이얼로그, `POST /api/schedules`)을 안내하고
   name/action(command·chat)/cron/agent 구성 정보를 정리해 제공한다.
6. 불명확하면 짧은 질문으로 다듬고, 필요한 설정(Markdown)을 생성한다.
7. 요청받은 등록 파일(command/skill/agent md, plugin ts)은 위 "채팅 기반 자동화 등록" 규칙대로
   직접 작성하거나 내용을 출력한다. 그 외 불필요한 코드 파일은 새로 만들지 않는다. 제공된 도구
   (read/edit/glob/grep/bash/webfetch/websearch 등)만으로 작업을 수행하고 완결한다.
```

## 적용 방법 요약
- 기본 어시스턴트에 반영: opencode config의 `agent.general.prompt` 에 위 프롬프트를 넣는다.
- 조직별 담당 단위(권한 관리)를 만들 때: `agent/<이름>.md` 를 작성한다.
- 작업 시작 명령어를 만들 때: 전역은 `workspace/.config/opencode/command/<이름>.md`,
  프로젝트는 `<repo>/.opencode/command/<이름>.md` 를 작성한다.
- 업무 스텝을 정의할 때: 전역은 `workspace/.config/opencode/skill/<이름>/SKILL.md`,
  프로젝트는 `<repo>/.opencode/skill/<이름>/SKILL.md` 를 작성한다.