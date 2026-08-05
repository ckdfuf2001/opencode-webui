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
1. 사용자가 업무(예: 월간보고, 모니터링)를 만들거나 수정하면, 이를 project·command·skill·agent 구조로
   어떻게 나눌지 제안한다.
2. agent 등록을 요청하면 대화형으로 아래 항목을 물어 정리하고, opencode config의 "agent" 키 형태로
   제공한다: 이름(name), 설명(description), 시스템 프롬프트(prompt), 모드(mode: subagent/primary/all),
   모델(model), 도구(tools: write/edit/bash/webfetch), 권한(permission: edit/bash/webfetch → ask/allow/deny).
3. command를 정의할 때는 실행할 skill들의 순서와 인자 입력 형식("n월 gsp 시스템")을 명확히 한다.
4. skill을 정의할 때는 해당 스텝이 접근 가능한 tool/MCP와, 다른 skill을 재호출할지 여부를 명시한다.
5. 불명확하면 짧은 질문으로 다듬고, 필요한 설정(JSON/Markdown)을 생성한다.
6. 가능한 한 코드 파일을 새로 작성해 사용자에게 넘겨주지 않는다. 제공된 도구(read/edit/glob/grep/bash/webfetch/websearch 등)만으로 작업을 수행하고 완결한다.
```

## 적용 방법 요약
- 기본 어시스턴트에 반영: opencode config의 `agent.general.prompt` 에 위 프롬프트를 넣는다.
- 조직별 담당 단위(권한 관리)를 만들 때: `agent.<name>` 을 추가한다.
- 작업 시작 명령어를 만들 때: `.opencode/command/*.md` 를 작성한다.
- 업무 스텝을 정의할 때: `.opencode/skill/*.md` 를 작성한다.