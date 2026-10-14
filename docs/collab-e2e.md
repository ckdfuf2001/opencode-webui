# 공동편집 E2E 테스트 명세 (v0.12.60)

> E1~E11은 직전 가이드 5장에 정의했던 케이스입니다. 이 문서는 그 정의를 **에이전트가 해석 없이 구현할 수 있는 수준**으로 구체화한 것입니다. 케이스를 새로 정의할 필요는 없고, 이 문서를 `docs/collab-e2e.md`로 저장소에 넣은 다음 그대로 구현하면 됩니다. 문서에 없는 판단이 필요하면 임의로 정하지 말고 "스펙 질문"으로 보고합니다.

---

## 0. 범위

**포함**
- PPTX 공동편집을 브라우저 컨텍스트 2개(A=Ada, B=Grace)로 검증합니다.
- 화면에서 보이는 결과를 검증합니다: 참여자 표시, 실시간 반영, 원격 선택 표시, 리마운트 없음, 승계, 재연결, AI 잠금.
- 디스크에 저장된 결과를 검증합니다: 슬라이드 수, 텍스트 반영.

**제외** (다른 테스트에서 다루거나 사람이 확인)
- XLSX와 DOCX (2단계와 3단계에서 같은 형식으로 추가)
- 백엔드 재시작이나 epoch 시나리오 (hermetic T4로 이미 다룸)
- 모바일 백그라운드나 화면 잠금 (실기기에서만 확인 가능)
- 실제 LLM 호출 (AI 편집은 `/api/preview/edit`를 직접 호출해서 대신함)

---

## 1. 테스트 환경

### 1.1 위치와 실행
```
e2e/collab/
  playwright.config.ts
  fixtures/collab-3slides.pptx      # 커밋하는 고정 fixture
  helpers/{env.ts, users.ts, viewer.ts, disk.ts}
  pptx-collab.spec.ts               # E1~E11
```
- 실행 명령은 `bun run test:e2e:collab`입니다.
- `webServer`는 백엔드와 프론트엔드를 같이 띄웁니다. dev 모드를 기준으로 하고, prod exe는 선택 사항으로 둡니다.
- `WORKSPACE_PATH`는 테스트 실행마다 새로 만드는 임시 디렉터리로 지정합니다. OpenCode 서버를 띄우지 않아도 된다면 띄우지 않습니다. 필요하면 그 이유를 보고합니다.
- `retries: 0`, `workers: 1`로 설정합니다. 공동편집 테스트는 서로 간섭하므로 직렬로 실행합니다.
- **flake 검증**: 완료 보고 전에 `--repeat-each=3`으로 3회 연속 전부 통과해야 합니다.

### 1.2 Fixture
- `collab-3slides.pptx`는 슬라이드 3장으로 구성합니다. 각 슬라이드에 이름이 고정된 텍스트 도형을 하나씩 둡니다.
  - 슬라이드 1: `Title 1` = "Slide One"
  - 슬라이드 2: `Body 2` = "Hello"
  - 슬라이드 3: `Body 3` = "Third"
- `ooxml-core`의 pptx 빌더로 만드는 스크립트(`fixtures/make.ts`)도 함께 커밋합니다.
- 각 테스트는 fixture를 워크스페이스에 **새 이름으로 복사해서** 씁니다. 같은 room이 다른 테스트에 재사용되지 않게 하기 위해서입니다.

### 1.3 사용자
- 컨텍스트 A와 B는 `browser.newContext()`로 각각 만듭니다. 스토리지가 분리됩니다.
- E8을 제외한 모든 케이스는 `addInitScript`로 아래 사용자 정보를 미리 넣습니다.
```ts
localStorage.setItem('collab-user', JSON.stringify({ id: 'u-ada', name: 'Ada', color: '#2563eb' }))
// B: { id: 'u-grace', name: 'Grace', color: '#059669' }
```
- 모든 페이지는 `?collabDebug=1`로 엽니다(2.3절).

---

## 2. 화면 요소 계약 (구현 쪽에서 반드시 제공)

테스트는 아래 선택자만 씁니다. lib 내부 클래스명에 직접 의존하지 않습니다.

### 2.1 앱 컴포넌트 `data-testid`

| testid | 요소 | 필수 속성 |
|---|---|---|
| `collab-status` | 연결 배지 | `data-status` = `connecting\|connected\|reconnecting\|offline\|error` |
| `collab-presence-bar` | 참여자 바 | — |
| `collab-peer` | 참여자 하나 (나 포함) | `data-peer-id`, `data-mode`(`view\|edit`), `data-slide`(1부터 시작), `data-owner`(`true\|false`), `data-self` |
| `collab-ai-blocked` | "AI 대기 중" 칩 | — |
| `collab-name-modal` | 이름 입력 모달 | 안쪽 `input`, 확인 버튼 `collab-name-submit` |
| `file-row` | 탐색기의 파일 행 | `data-path` |
| `file-row-collab-avatar` | 파일 행 안의 아바타 | `data-peer-id` |
| `pptx-viewer-root` | viewer를 감싸는 요소 | — |

### 2.2 원격 선택 표시
- lib이 원격 선택 외곽선을 그린다면, 그 DOM에 **앱이 래퍼나 MutationObserver로 `data-testid="collab-remote-selection"`과 `data-peer-id`를 붙입니다.** 불가능하다면 lib이 쓰는 안정적인 선택자를 `helpers/viewer.ts` 한 곳에 상수로 두고, 그 근거(lib 파일과 줄 번호)를 주석으로 남깁니다.
- 원격 선택 표시가 lib에 없다면 E3은 **블로커로 보고**합니다. 직접 구현할지는 별도로 결정합니다.

### 2.3 디버그 훅 (`?collabDebug=1`일 때만)
```ts
window.__collabDebug = {
  mountCount: number,          // PowerPointViewer 마운트 횟수 (useEffect에서 +1)
  role: 'owner'|'collaborator'|'viewer'|null,
  synced: boolean,
  ownerClientId: number|null,
  clientId: number,
  lastSave: { at: number, status: number } | null,
  slideCountY: number,         // doc의 pptx:slides 길이
}
```
- 단언(assertion)에는 화면을 우선으로 씁니다. 디버그 훅은 화면으로 확인할 수 없는 항목(마운트 횟수, Y 슬라이드 수, 저장 결과)에만 씁니다.
- **편집 동작 자체를 디버그 훅으로 대신하면 안 됩니다.** 텍스트 입력과 선택은 실제 클릭과 키보드로 합니다.

### 2.4 디스크 검증 헬퍼 (`helpers/disk.ts`)
- `readDeck(path)`: 워크스페이스 파일을 `ooxml-core`로 파싱해서 `{ slideCount, textOf(shapeName) }`을 반환합니다.
- `waitForDisk(path, predicate, timeout=8000)`: write-back debounce(2.5초)에 여유를 둔 대기 함수입니다.

---

## 3. 공통 헬퍼 (`helpers/viewer.ts`)

| 함수 | 동작 |
|---|---|
| `openFile(page, path, mode)` | 탐색기에서 파일을 클릭하고, `mode==='edit'`이면 편집 버튼을 누릅니다. `collab-status[data-status=connected]`가 될 때까지 기다립니다(최대 10초) |
| `gotoSlide(page, n)` | 썸네일을 클릭합니다. 모바일 뷰포트에서는 슬라이드 시트를 엽니다 |
| `editShapeText(page, shapeName, text)` | 도형을 더블클릭한 뒤 전체 선택하고 입력, Escape. 도형 위치는 lib의 도형 DOM에 붙어 있는 이름 또는 id 속성으로 찾습니다. 근거는 주석으로 남깁니다 |
| `selectShape(page, shapeName)` | 한 번 클릭 |
| `peer(page, id)` | `collab-peer[data-peer-id=id]` locator |
| `measure(fn)` | 반영 지연(ms)을 재서 테스트 결과에 첨부합니다 |

---

## 4. 케이스 정의

공통 규칙:
- 반영 대기는 `expect.poll` 또는 `toHaveText`를 쓰고, **timeout은 3초**로 둡니다. 실제 지연은 `measure`로 기록하고, **중앙값이 1초를 넘으면 실패**로 봅니다.
- 테스트가 끝날 때마다 두 페이지 모두 `pageerror`와 `console.error`가 0개인지 확인합니다. 기존에 알려진 경고는 허용 목록으로 관리합니다.

### E1. 참여자 표시 (편집자와 관찰자)
1. A가 `edit`로 열고 슬라이드 2로 이동합니다.
2. B가 `view`로 엽니다.

**단언**
- B 화면: `peer(B,'u-ada')`가 보이고 이름은 "Ada", `data-mode=edit`, `data-slide=2`, `data-owner=true`입니다.
- A 화면: `peer(A,'u-grace')`가 보이고 `data-mode=view`입니다.
- B의 탐색기: 해당 파일의 `file-row`에 `file-row-collab-avatar[data-peer-id=u-ada]`가 있습니다. 탐색기는 10초 poll이므로 timeout을 12초로 둡니다.
- 이름이 기본값 `"You"`인 참여자가 없습니다. 본인은 이름 뒤 `(you)` 표기가 붙습니다 (예: `Grace (you)`).
  (초안의 `"You" 텍스트 없음` 단언은 2026-10-15 지시로 대체됨 — 모두가 "You"로 보이던 문제를 막는 것이 목적.)
- 참여자 바는 한 줄이며 `viewer - … · editor - …` 두 그룹으로 표기합니다. `collab-status`는 연결됨 상태일 때 숨음(속성만 유지)합니다.

### E2. 텍스트 실시간 반영
1. E1과 같은 방식으로 A는 edit, B는 view로 엽니다. 두 사람 모두 슬라이드 2에 있습니다.
2. A가 `editShapeText('Body 2', 'Hello from Ada')`를 실행합니다.

**단언**
- B의 `pptx-viewer-root` 안에 "Hello from Ada"가 나타납니다. 지연을 기록합니다.
- 8초 안에 디스크 파일의 `Body 2` 텍스트가 "Hello from Ada"가 됩니다.

### E3. 원격 선택 표시
1. A는 edit, B는 view로 엽니다. 둘 다 슬라이드 2에 있습니다.
2. A가 `selectShape('Body 2')`를 실행합니다.

**단언**
- B 화면에 `collab-remote-selection[data-peer-id=u-ada]`가 보이고, 그 bounding box가 B 화면의 `Body 2` 도형 bounding box와 **4px 이내로 겹칩니다.**
- B의 `peer(B,'u-ada')` 상태 텍스트에 "편집 중"이 들어 있습니다.
- A가 Escape로 선택을 풀면 3초 안에 표시가 사라집니다.

### E4. 두 사람이 동시에 편집할 때 중복 seed 없음
1. A가 edit로 엽니다.
2. B도 edit로 엽니다.
3. 동시에 A는 슬라이드 1의 `Title 1`을, B는 슬라이드 3의 `Body 3`을 수정합니다(`Promise.all`).

**단언**
- 양쪽 화면 모두에서 두 수정 내용이 보입니다.
- 양쪽의 `__collabDebug.slideCountY === 3`이고, 썸네일도 3개입니다.
- 8초 안에 디스크의 `slideCount === 3`이고, 두 수정 내용이 모두 반영돼 있습니다.
- 양쪽 중 `data-owner=true`인 참여자는 정확히 1명입니다.

### E5. owner 편집기가 리마운트되지 않음
1. A(owner)는 edit, B는 view로 엽니다. A의 `mountCount`를 기록해 둡니다(m0).
2. A가 `Body 2`를 선택한 상태로 30초 동안 2초 간격으로 15회 입력합니다. 이 동안 저장이 여러 번 일어나야 합니다.

**단언**
- A의 `mountCount === m0`입니다.
- 마지막 입력 직후에도 A의 텍스트 편집 상태(캐럿)가 유지됩니다. 마지막에 입력한 글자가 이어서 붙어야 합니다.
- A의 `lastSave.status === 200`이고, 저장이 2회 이상 일어났습니다. 저장 횟수는 디버그 카운터로 셉니다.
- B 화면에 최종 텍스트가 보입니다.

### E6. owner가 나가면 승계
1. A와 B 모두 edit로 엽니다. A가 owner인지 확인합니다.
2. A가 수정을 한 번 하고 저장될 때까지 기다린 뒤 `pageA.close()`를 실행합니다.
3. B가 `Body 3`을 수정합니다.

**단언**
- 5초 안에 B 화면에서 `peer(B,'u-ada')`가 사라집니다.
- 5초 안에 B 자신의 `collab-peer[data-self=true]`가 `data-owner=true`가 됩니다.
- 8초 안에 디스크에 A의 수정과 B의 수정이 모두 반영됩니다. B의 저장 결과는 200이고, 409가 한 번도 나오지 않아야 합니다.

### E7. 네트워크 끊김과 재연결
1. A와 B 모두 edit로 엽니다.
2. `contextB.setOffline(true)`로 B를 오프라인으로 만듭니다. B의 `collab-status`가 `reconnecting` 또는 `offline`이 될 때까지 기다립니다.
3. B가 `Body 3`을 수정합니다.
4. 5초 뒤 `contextB.setOffline(false)`로 되돌립니다.

**단언**
- 15초 안에 B의 상태가 `connected`가 됩니다. 그 사이 `error` 상태를 한 번도 거치지 않아야 합니다. 상태 전이를 기록해서 확인합니다.
- A 화면에 B의 오프라인 중 수정 내용이 나타납니다.
- B 화면에 "사본 다운로드" 같은 terminal UI가 나타나지 않습니다.
- B의 `mountCount`가 변하지 않습니다.

### E8. 이름 없이는 참가할 수 없음
1. `collab-user` 값을 넣지 않은 컨텍스트로 파일을 열고 편집 버튼을 누릅니다.

**단언**
- `collab-name-modal`이 보이고, 이름을 입력하기 전까지 `collab-status`는 `connected`가 되지 않습니다.
- 빈 이름으로 확인을 누르면 모달이 그대로 남습니다.
- "Grace"를 입력하고 확인하면 연결되고, 참여자 바에 "Grace"가 보입니다. `localStorage['collab-user']`에 id, name, color가 저장됩니다.

### E9. 보기만 하는 사람은 AI를 막지 않음
1. B만 view로 엽니다.
2. 테스트 코드에서 `POST /api/preview/edit`(또는 실제 office-mcp가 쓰는 쓰기 경로)를 호출해서 `Body 3`을 수정합니다.

**단언**
- 응답이 2xx이고 디스크가 바뀝니다.
- B 화면에 3초 안에 "외부 변경" 배너가 나타납니다. 자동 병합은 하지 않습니다(원칙 유지).

### E10. 편집자가 있으면 AI 차단, 차단 사실 표시
1. A는 edit, B는 view로 엽니다.
2. E9와 같은 AI 편집 호출을 합니다.

**단언**
- 응답 409. 본문에 "사용자가 공동편집 중입니다"가 들어 있습니다.
- 3초 안에 A와 B 화면 모두에 `collab-ai-blocked`가 보이고, 30초 뒤에는 사라집니다. 시간은 `page.clock`으로 앞당겨도 됩니다.
- 디스크는 변하지 않습니다.

### E11. 모바일 뷰포트
- 두 컨텍스트 모두 `viewport: 390×844`, `isMobile: true`, `hasTouch: true`로 만들고 **E1, E2, E3을 반복**합니다. 같은 spec을 `test.describe`로 매개변수화합니다.

**추가 단언**
- `collab-presence-bar`가 화면 안에 보입니다(`toBeInViewport`).
- 슬라이드 시트에 다른 사람이 있는 슬라이드 표시(색 점)가 보입니다.

---

## 5. 수정 전 실패 확인

목적은 테스트가 실제 결함을 잡아내는지 증명하는 것입니다.

- `v0.12.59` 태그를 worktree로 체크아웃하고 **E2와 E5만** 실행합니다. 이 두 케이스는 새 testid가 없어도 돌아가도록 다음 대체 단언을 씁니다.
  - E2: B 페이지 본문에 텍스트가 나타나는지 (`page.getByText`)
  - E5: `mountCount` 대신 MutationObserver로 viewer 루트 노드가 교체된 횟수를 셉니다(헬퍼에 `legacy` 모드를 둠)
- 기대 결과: **E5는 실패해야 합니다.** 지금 코드는 `setSavedBytes` 때문에 저장할 때마다 다시 로드합니다. E2는 실패해도 되고 통과해도 됩니다. 결과를 그대로 보고합니다.
- E1, E3, E8, E10은 v0.12.59에 해당 UI 자체가 없으므로 "해당 없음"으로 적습니다.

---

## 6. 산출물

- 위 파일 구조와 CI 스크립트
- 케이스마다 결과(통과/실패), 반영 지연(중앙값과 최대), `--repeat-each=3` 결과
- E1, E3, E11의 B 화면 스크린샷. 실패한 케이스는 Playwright trace도 첨부합니다.
- lib 근거 목록: 원격 선택 DOM, 도형 이름 속성, presence 필드 키, `sessionIntent`/`role` 런타임 변경 지원 여부
- 수정 전 실패 확인 결과(5장)
- **스펙 질문**: 이 문서만으로 결정할 수 없었던 항목. 임의로 정한 것이 있다면 무엇을 왜 그렇게 정했는지

---

## 7. 리뷰 기준 (제가 보는 것)

1. 편집과 선택을 **실제 입력으로** 했는가 (디버그 훅으로 대신하지 않았는가)
2. 단언이 **B 화면** 기준인가 (A 자신의 화면만 확인하지 않았는가)
3. 반영 대기에 `waitForTimeout`이 없는가 (조건 대기만 써야 함)
4. 디스크 검증이 있는가 (E2, E4, E6)
5. E5가 수정 전 코드에서 실패하는가
6. 3회 반복 실행에서 flake가 없는가
