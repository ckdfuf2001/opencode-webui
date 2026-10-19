# 메모리 노트

관찰된 사실과 그 근거 줄 번호만 기록한다. 추측은 넣지 않는다.

## 1. 협업 세션 해제는 lease 토큰으로만 한다 (M3/N1)

`frontend/src/lib/collabSessionRegistry.ts`

- 경로 기반 `releaseCollabSession(path)` 는 **삭제했다**. 삭제 이유:
  - 호출자가 실제로 acquire 했는지 알 수 없다.
  - acquire 하지 않은 뷰어(인라인 미리보기 / 전체화면)가 언마운트하면 **남의 refs를 깎아** 편집 중 세션을 죽일 수 있었다.
  - 4001 로 방이 해체된 뒤 같은 경로에 새 세션이 들어온 상태에서 옛 보유자의 늦은 release 가 **새 세션을** 죽일 수 있었다.
- `acquireCollabSession()` 은 lease 를 돌려준다: `{ session, reused, onReset, release }`.
  - `release()` 는 자신이 잡은 entry 를 클로저로 가진다.
  - 1회성이다(StrictMode 이중 cleanup, 중복 호출에 안전).
  - registry 에 다른 세션이 들어와 있으면 무효가 된다.
- 따라서 **토큰 없이 release 할 경로가 타입 단계에서 존재하지 않는다.**

## 2. 4001 reset 은 반드시 dropCollabSession 이어야 한다 (M2-2)

`frontend/src/components/file-browser/PptxViewer.tsx` 의 `session.onReset(...)`

- release 를 거치지 않으면 죽은 세션이 registry 에 남아 **재사용된다**(refs 가 늘어나 언마운트로도 안 지워진다).
- `dropCollabSession(path, session)` 는 항목을 즉시 제거하고 파괴한 뒤,
  **같은 세션을 공유하던 다른 뷰어에게 통지**한다(죽은 세션을 조용히 들고 있지 않게).
- 늦게 구독하면 즉시 통지된다.

## 3. 숨김 탭 캐시 정리 대상 키 3개 + `type: 'inactive'`

`frontend/src/hooks/useOpenCode.ts` 의 `useReleaseCacheOnHidden()`

| 대상 키 | 실제 queryKey 위치 |
|---|---|
| `['opencode','messages']` | `useOpenCode.ts:2182` `['opencode','messages', opcodeUrl, sessionID, directory]` |
| `['opencode','message-list']` | `useOpenCode.ts:907` `['opencode','message-list', sessionID, limit, offset, order]` |
| `['opencode','last-message']` | `useOpenCode.ts:1308` |

- `message-list` 는 **offset 마다 항목이 생긴다.** 이전에는 이 키만 빠져 있었다.
  (`messages` 와 `last-message` 는 접두사 매칭으로 정상 동작 중이었다.)
- 전부 `type: 'inactive'` 로 제한한다. active 쿼리를 지우면 화면(observer)이
  캐시에서 빠진 쿼리를 계속 붙잡게 되어 오히려 새 페치를 유발한다.
  같은 방식을 `frontend/src/pages/SessionDetail.tsx:213` 이 이미 쓴다.
- React Query 전역 `gcTime` 은 `frontend/src/App.tsx` 에서 **10초**로 설정되어 있다(기본 5분이 아님).

## 4. 메모리 판정 방법

**`performance.memory.usedJSHeapSize` 는 아직 회수되지 않은 쓰레기를 포함한다.**
단독으로 누수 판정 근거가 되지 않는다. 아래 둘로만 판정한다.

- DevTools Memory 탭의 **쓰레기통(GC) 버튼 직후 값**
- `?memDebug=1` 로 켠 뒤 `__memFloor()` — 최근 10회 관측의 **최솟값**.
  시간이 지나며 이 바닥선이 올라가는 것이 누적 신호다.

진단 훅은 제거하지 않는다(회귀 시 재사용):

```js
// ?memDebug=1 로 접속 후 콘솔
__memProbe()          // heapMB(GC 전) / heapFloorMB / queryCache / domNodes / sockets / moduleMaps
__memProbe(true)      // 오래된 쿼리 15개까지(할당이 크므로 필요할 때만)
__memFloor()          // 최근 10회 최솟값
__moduleMapSizes()    // useOpenCode 모듈 레벨 Map 크기
__openSockets()       // 닫히지 않은 WebSocket 수
__openEventSources()  // 닫히지 않은 EventSource 수
```

## 5. 상한이 이미 있는 것 (재점검 불필요)

- `useOpenCode.ts` `mentionStatCache` 는 `frontend/src/components/message/MessagePart.tsx` 에서 **500 상한**.
- `clientLogs` 200 상한, `curSlideHistory` 200 상한, `peerSlideHistory` 100 상한.
- `truncateLargeToolOutputs` 는 변경이 없으면 **원래 배열 참조를 반환**한다(`changed ? next : messages`).
  즉 폴링마다 새 참조가 생기지 않는다.

## 6. 상한이 없어 유일하게 메시지 수에 비례해 자는 것

`useOpenCode.ts` `backfilledIds` = `Map<sessionID, Set<messageId>>`

- backfill 때마다 증가하고, 명시적 drop(`dropBackfilledId`) 또는 세션 정리(`clearBackfilledIds`)에서만 줄어든다.
- `lastFastPullAt` / `lastReasoningPullAt` 은 delete 경로가 없다. 단 `Map<sessionID, number>` 라 방문 세션 수만큼만 자란다.
- retainers 가 이쪽을 지목하기 전까지는 손대지 않는다.

## 7. 뷰어 닫기 = 언마운트 (M6)

- 사용자 실측: PPT 닫은 뒤에도 `[data-testid=pptx-viewer-root]`가 1개 남아 있었다.
  → lib 렌더 루프 + presence 10초 재게시 + Y.Doc(data: 이미지)이 계속 살아 있었음.
  "숨김 탭에서는 안 늘고 보일 때만 는다"도 이것으로 설명됨(rAF/타이머는 화면이 보일 때만 돎).
- 수정: `d95f8e7`. 회귀 테스트 `e2e/collab/viewer-unmount.spec.ts`.
- 판정 명령(`?memDebug=1`):

  ```
  document.querySelectorAll('[data-testid=pptx-viewer-root]').length  // 닫은 뒤 0
  __openSockets()                                                      // 닫은 뒤 0
  ```

- 미완: 소켓 단언이 `viewer-unmount.spec.ts:135`에서 `toBeLessThanOrEqual(1)`이라 느슨하다.
  닫은 뒤에는 0이어야 하므로 0으로 강화할 것. 시트/다이얼로그(M6c)·xlsx·docx 닫기 케이스도 없음.

## 8. 측정 왜곡 2건 (M7-2 / M7-4)

### 8-1. 1초 CDP 폴링은 renderer를 +0.45MB/s 쓴다
- 프로브가 Performance.getMetrics + page.evaluate 를 1초마다 호출하면, 콜라��� 자체가
  renderer private를 초당 0.45MB씩 올린다.
- 증명: ?collab=0 뷰 모드에서 레이아웃 0회·렌��� 0회인데도 2분간 +54MB가 났다.
  같은 조건에서 폴링 주기를 10초(PROBE_INTERVAL_MS=10000)로 바꾸니 **-0.3MB(평탄)**.
- 규칙: renderer private를 볼 때는 PROBE_INTERVAL_MS=10000 이상을 쓴다.
  1초 주기 수치는 프로브 오염값이다.

### 8-2. window.gc()로 renderer private는 판정하지 않는다
- window.gc()는 JS heap만 회수한다. renderer private는 할당기가 페이지를 붙잡고 있어
  바로 내려가지 않는다.
- 잘못된 판정: M7-4 E-d에서 "GC 후 15MB만 내려감 → retainer"로 읽었으나 이 지표는
  판정 근거가 되지 못한다. UI의 GC 버튼은 최소값까지 떨어지게 만들기 때문에
  그쪽 지표가 유효하다.
- 규칙: 판정은 (1) GC 후 JS heap 값과 (2) 장시간(30분) 고원 도달 여부로 한다.

## 9. M7-2/M7-4 결론 (증가율 트랙 종료)

| 조건 (dev 5173, headed, 47MB 덱, 편집 3분, 10초 프로브) | MB/s (스케줄 시간 기준, ≈1.26배 과대) |
|---|---|
| 수정 전 (T1a) | +0.93 |
| 슬라이드 점 paint 멱등화 + usePeers tick 제거 (43232e2, 199bc09) | +0.42 |
| 단일 세션 상태 폴러 (8683102) | +0.26 |

- 잔여 +0.13MB/s(뷰 모드 공통 바닥)는 heap snapshot 대상이 아니다. 고원 확인만 한다.
- 레이아웃 8.6/s → 0/s, DOM mutation 73~147/s → 0/s, PptxViewer 렌더 2.6/s → 0/s.
- **보정(M8)**: 위 수치는 프로브가 샘플의 `elapsed`(스케줄 시간)로 나눈 값이다. 샘플당 계측
  작업 때문에 실제 경과가 약 1.26배 길어(200s 스케줄 → 252s 벽시계) 모든 MB/s가 약 1.26배 과대다.
  순위·상대비교는 유효하지만 절대값은 1.26으로 나눠 읽는다. 8683102 이후 프로브는 벽시계로 계산한다.

## 10. 측정 절차 고정 (M8)

### 10-1. "닫기"는 인라인 패널의 "미리보기 닫기"다
- `/repos/:id`의 `FileBrowserSheet`는 경로 선택 UI일 뿐이다. `onClose`는 `explorerSelectedPath`를
  지우지 않으므로 시트를 닫아도 인라인 미리보기(PPT 뷰어)는 살아 있다(정상 설계).
- 메모리를 잴 때 닫기는 인라인 패널의 "미리보기 닫기"로 `explorerSelectedPath`를 비우는 것이다.
  시트 닫기 후 150ms는 페이드 아웃용 마운트 유지 구간이다(`MODAL_TRANSITION_MS`).
- 사용자가 브라우저를 수동 새로고침한 run은 무효로 하고 재측정한다.

