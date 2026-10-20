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

## 11. 측정 규칙 (M8 고정)

### 11-1. 프로브
- 주기는 **10초**(`PROBE_INTERVAL_MS=10000`). 1초 CDP 폴링은 renderer를 +0.45MB/s 부풀린다(8-1).
- **시간축은 벽시계 기준.** 8683102 이전 MB/s 수치는 스케줄 시간 기준이라 약 1.26배 과대다.
- 매번 **renderer private + JS heap(GC 후 `__memFloor()`) + DOM 노드 수**를 같이 기록한다.
  renderer private 하나로만 판정하지 않는다.
- `window.gc()`는 JS heap만 회수한다. renderer private는 할당기가 페이지를 붙잡고 있어 바로 내려가지
  않는다(8-2). "GC 후 안 내려감 = retainer"로 판정하지 않는다. 판정은 **30분 고원 여부 + JS heap 추이**로 한다.
- **"닫기"는 인라인 "미리보기 닫기"**로 한다(10-1). 수동 새로고침이 끼면 run은 무효다
  (`jsUsed`가 20MB 안팎으로 떨어지면 리로드를 의심한다).
- **interval은 생성(create/s)과 실행(run/s)을 따로 센다.** 실행(run)이 늘면 타이머가 추가된 것이다.

### 11-2. URL 스위치와 콘솔 훅

| 스위치 | 용도 |
|---|---|
| `?memDebug=1` | `__memProbe`/`__memFloor`/`__memCounters` 설치. prod 빌드에서도 동작. 계측은 `memDebug`가 켜진 탭에만 |
| `?collabDebug=1` | `__collabDebug` — 참가자·presence·소켓 상태 확인 |
| `?poll=0` | 폴링 정지(폴링 비용 분리 측정). dev + memDebug 한정 |
| `?collab=0` | 공동편집 미사용(presence/awareness 비용 분리) |
| `?peersTick=1000` | usePeers 1Hz tick A/B용(기본 off) |
| 콘솔 `__memFloor()` | GC 후 JS heap 최소값. **판정용 지표**(8-2) |
| 콘솔 `__memProbe(true)` | 마지막 계측 덤프(counters deltas) |
| 콘솔 `__openSockets()` | 열린 소켓 수. 닫은 뒤 0이어야 한다(D32) |
| 콘솔 `__collabDebug` | collab/presence 상태 덤프 |

## 12. 판정 기준 (회귀 기준선)

| 항목 | 기준선 | 상태 |
|---|---|---|
| 유휴 interval 실행(run/s) | 현재 4.0/s → 목표 ≤1/s | 4b-2에서 갱신 |
| PPT 편집 모드 증가율(10초 프로브) | 수정 전 +0.93 → 현재 +0.26MB/s | 스케줄시간 기준(1.26배 과대) |
| 뷰 모드 공통 바닥 | +0.13MB/s (dev) / prod는 1절 결과로 갱신 | 1절 완료 |
| 닫은 뒤 | 열기 직전 대비 +30MB 이내(GC 후), viewer-root 0, `__openSockets()` 0 | prod 실측 +50MB(50회 이동), 조건별 확인 필요 |
| 절대 크기(dev) | 앱만 189.8 / 덱 열기 직후 1369.6 / 편집 20초 후 2705.9MB | 미해결 |
| 절대 크기(prod) | 앱만 ~120 / 덱 열기 직후 ~538 / 편집 20초 후 ~660MB | 2절 실측(§13) |
| 뷰 모드 JS heap floor | 47MB 덱 prod 뷰 모드에서 **435MB**(앱만 10MB) | **v0.13 "절대 크기 분해"** 항목 |
| 이미지 캐시·GPU 메모리 | Chrome 작업관리자 기준. CDP로는 **읽을 수 없다** | 미해결(수동 기록 필요) |

### 12-1. 1절 30분 고원 (prod dist, 47MB 덱, 뷰 모드, `collab=0&poll=0`, 10초 프로브, 벽시계)

| 시점 | renderer private | JS floor | LayoutCount |
|---|---|---|---|
| 0분 | 726.7MB | 435MB | 0 |
| 5분 | 712.2MB | 435MB | 0 |
| 10분 | 722.4MB | 436MB | 0 |
| 15분 | 732.3MB | 436MB | 0 |
| 20분 | 741.4MB | 436MB | 0 |
| 25분 | 751.4MB | 436MB | 0 |
| 30분 | 760.1MB | 437MB | 0 |

- 총 +33.4MB / 30분 = **+0.02MB/s**. 10분 이후에는 **+1.9MB/분 일관 증가**(고원 아님).
- JS heap floor 435 → 437MB(**+2MB/30분**). 레이아웃 0회. → **JS heap은 평탄, private는 계속 상승 = 네이티브 쪽**(D 판정).
- **대조군(60초 프로브, 15분)**: 703.0 → 725.4MB = **+1.85MB/분**. 10초 프로브와 **기울기가 같다**.
  → 상승은 프로브 오염이 아니라 앱/브라우저 네이티브다.
- GPU private 201.4 → 192.2MB(감소) → GPU 메모리가 아니다. renderer native(이미지 캐시/컴포지터) 쪽.
- 미해결: **prod 뷰 모드에서 네이티브가 +1.9MB/분** 계속 늘어난다. 3절(절대 크기 분해) 대상.

### 12-1. 1절 30분 고원 + 1b 네이티브 귀속 (prod dist, 47MB 덱, 뷰 모드, `collab=0&poll=0`, 10초 프로브, 벽시계)

| 조건 | renderer private | JS floor | 30분 변화 | MB/분 | LayoutCount |
|---|---|---|---|---|---|
| N-a 앱만(뷰어 없음) | 107.4 → 119.8MB | 10MB | +12.4MB | +0.007 | 0 |
| N-c 작은 덱(8.8KB, 75B PNG 3장) | 167.8 → 164.9MB | 41MB | −2.9MB | −0.01 | 0 |
| N-b 47MB 덱 (1절 재현) | 849.5 → 880.5MB | 436MB | +31.0MB | **+1.04** | 0 |
| (1절 원본 측정) | 726.7 → 760.1MB | 435MB | +33.4MB | +1.11 | 0 |

- **판정: 네이티브 상승은 "덱이 있을 때"만 난다.** 앱만(+0.007MB/분)과 작은 덱(−0.01MB/분)은 평탄.
  47MB 덱에서만 +1.04MB/분 → **덱 크기(디코드된 이미지/파싱 결과)에 비례하는 네이티브 메모리.**
  8시간이면 약 500MB — 고원 미도달이라 종결할 수 없다(v0.13 V2).
- JS heap floor도 덱에 비례: 앱만 10MB → 8.8KB 덱 41MB → 47MB 덱 436MB.
  (47MB 덱 하나가 힙 426MB를 잡는다 → v0.13 "절대 크기 분해" 대상)
- 60초 프로브 대조군(1절): 10초 프로브와 기울기 동일(+1.85 vs +1.9MB/분) → 프로브 오염 아님.
- GPU private는 감소(201 → 192MB) → GPU 메모리가 아니다. renderer native(컴포지터/디코드 이미지) 쪽.

### 12-2. 2절 prod 절대 크기 (prod dist + 프록시, exe 빌드 스크립트 부재)

| 시점 | prod | dev | 차이 |
|---|---|---|---|
| 앱만 | ~120MB | 189.8MB | |
| 47MB 덱 열기 직후 | ~538MB | 1369.6MB | 덱이 올리는 크기 **+416MB vs +1180MB** |
| 편집 20초 후 | ~660MB | 2705.9MB | |
| 편집 종료 후 10분 | 633.8 → 692.5MB | — | JS floor 441→440 평탄, t=300s 이후 +0.01MB/s → **고원 도달** |
| 슬라이드 50회 이동 후 | 731.7 → 641.9MB | — | JS heap 466→390MB로 **감소**, private 잔존 +50MB |

- prod에서도 덱 1장이 **416MB**를 올린다. 목표(덱 대비 3배, 약 150MB)에 미달 → 3절 진행 대상.
- "1.2GB"는 dev 부풀림이 약 2/3이었다.

## 13. 누수 아님으로 판정한 것 (다시 조사하지 말 것)

- `lastFastPullAt` / `lastReasoningPullAt` — 세션 수 비례, 숫자 값만, delete 경로 없음.
- `clientLogs` 200 / `curSlideHistory` 200 / `peerSlideHistory` 100 상한.
- `mentionStatCache` 500 상한.
- `sameMessageList` 참조 유지(같은 데이터면 새 배열 만들지 않음).
- 채팅 DOM 창 18개(`WINDOW_SIZE`, `SessionDetail.tsx:150`) / fetch 60개(`RECENT_MESSAGE_LIMIT`).
- `backfilledIds`(ID만 저장) / `recentTotals`(숫자만) + react-query `gcTime: 10_000` → 60개 창 밖 메시지 객체 미보존.
- `truncateLargeToolOutputs` / `capSseTextPart` / `capFinishedStreamOutput` — 상한 존재.

## 14. 열린 항목

> M12/M14 실험 결과(공동편집 데이터 유실 건)는 **docs/handoff.md** 의 "M12/M14 진행 위치" 절로 옮겼다.
> 여기서는 링크만 둔다: `docs/handoff.md` → "M14 실험 결과(데이터 유실)".

### 14-0. lib 의 모델→Y.Doc 반영 순서 (M21 2절 근거, `chunk-DD3ARHEW.mjs`)

```
publish.current = (nextSlides) => {
  const serialized = JSON.stringify(slides);
  queueMicrotask(() => {
    if (!active || !canWrite() || token !== revision || slides === superseded
        || loadVersion !== lastLoad.current || serialized === lastSynced) return;   // ← 반영이 막히면 미동기 편집이 남는다
    reconcileSlidesInYDoc(slides, doc, factories);   // ← 모델 → Y.Doc 반영
    lastSynced = serialized;
    scheduleWriteBack();                            // ← write-back 예약
  });
};
```

⇒ **반영은 마이크로태스크 경계를 넘겨야 일어난다.** 그리고 **언마운트(편집 종료) 시점에는
lib 컴포넌트가 죽어 publish 자체가 실행되지 않으므로, 그 순간 커밋된 편집은 Y.Doc 에 반영되지 않는다.**
⇒ flush 가 "2초 안에 로컬 update 없음"으로 스킵되는 이유가 이것이다(실측 `wb.flush.skip{deadline}`).
⇒ 해법(M20 2절): flush 안에서 **동기화를 1회 직접 실행**(lib 내부 `reconcileSlidesInYDoc` 호출)한 뒤 직렬화,
또는 앱 측에서 언마운트 전에 `getContent()` 로 저장(2-3/2-4). 둘 다 다음 세션 과제.


- 4b-0 결과: SSE on 380ms 폴링(P0), 델타 중복 append(정합성 P0), cap 규칙 3개, 델타당 할당 5개.
- 절대 크기 분해: 이미지 디코드, data: 문자열 사본, 편집 이중 마운트.
- **prod 뷰 모드 네이티브 +1.9MB/분**(§12-1): 8시간이면 약 900MB. 고원 미도달이므로 종결 불가.
  1b(N-a 앱만 / N-b 47MB 덱 / N-c 75B PNG 덱)로 PPT 탓인지 앱 탓인지 귀속 중. → **§12-1 참조(완료)**
- **뷰 모드 JS heap floor 435MB**(47MB 덱, prod): JS 쪽은 평탄하지만 덱 1장이 힙을 425MB 잡는다.
  v0.13 "절대 크기 분해" 항목으로 기록.
- Chrome 작업관리자 열(Memory footprint/Image cache/GPU memory)은 CDP로 읽을 수 없어 **수동 기록 필요**.
  가능하면 `chrome://tracing` memory-infra 덤프(0분/30분)로 malloc·partition_alloc·blink_gc·cc 중 증가분 확인.

### 14-1. v0.13 이월 항목 (M9-6절에서 남은 앱 이슈)

| # | 내용 | 근거 | 상태 |
|---|---|---|---|
| V1 | **owner write-back 후 세션 재설정 → owner 상실 → 편집이 디스크에 안 반영**<br>E2(live text reflection + disk) 실패. | e2e/collab/pptx-collab.spec.ts:141 | **원인 규명(1절)**: 판정표 = "14.7초부터 없음"(저장 바이트에 편집 미포함). 저장은 성공했지만 저장된 바이트의 `a:t` 는 `Hello` — **Y.Doc 에는 편집이 있었는데(다른 참가자 화면에 보임) 직렬화는 A 자신의 뷰어 DOM 기준**이고 그 DOM 이 커밋 후 갱신되지 않았다. 2절(저장 바이트 출처) 진행 필요. 백엔드 경합·자기저장 해시 식별은 705e63c 로 해결. |
| V2 | 뷰 모드 네이티브 +1.04MB/분 (§12-1). **덱이 있을 때만** 발생(앱만 +0.007, 8.8KB 덱 −0.01MB/분) → 덱 크기 비례. JS heap floor도 덱에 비례(10→41→436MB) | 1b 측정 | 1b로 귀속 확정. v0.13 "절대 크기 분해"와 함께 |
| V3 | 이미지 손실 가드 계수 오탐 — **수정 완료(9f86d17)**. 정규식 탐색이 로컬 헤더와 중앙 디렉터리를 모두 세고 'ppt/media/' 디렉터리 엔트리까지 세어 실제 3장짜리 덱을 8장으로 셌다. 앱 저장 바이트(디렉터리 엔트리 없음)는 6장으로 세어져 "8→6 = 손실"로 오탐 → **이미지가 있는 덱의 저장이 전부 막혔다.** ZIP 엔트리 기준으로 세도록 고쳤고 회귀 테스트를 추가했다. | backend/test/services/collab-image-count.test.ts | **해결됨** |

### 14-2. E2E 하네스 복구 기록 (M9-6절)

하네스만 고쳐서는 통과가 안 됐다. 원인은 3개가 겹쳐 있었다.

1. **격리 워크스페이스가 둘** — playwright 설정은 메인 프로세스(웹서버용)와 테스트 워커에서 각각 평가된다.
   `mkdtempSync` 를 매번 부르면 워크스페이스가 2개 생겨, 워커가 만든 fresh 파일이 백엔드에 안 보였다.
   → `COLLAB_E2E_WS` 로 공유(설정은 1곳만 수정).
2. **폴더 펼치기가 토글** — 헬퍼가 폴더 이름 span 을 클릭하는 방식은 expanded 반전이라 반복 클릭하면
   다시 접혔다(8회 클릭 → 최종 접힘). → `Expand` 버튼(토글 아님) 사용 + 이미 펼쳐졌으면 no-op.
3. **알림 배너가 클릭을 가로챔** — `PushPrompt`(알림 허용 배너, `fixed top-0 z-[100] bg-amber-500`)가
   상단바의 "Workspace" 버튼을 덮었다. → 앱 플래그 `?e2e=1` / `VITE_E2E=1` 로 배너·토스트를 끈다.
   (E2E webServer 는 vite 를 `VITE_E2E=1` 로 띄운다 → 스펙이 어떤 URL 로 가더라도 적용.)
4. 선택적 fetch 실패(명령 목록)의 `console.error` 가 E2E 의 엄격한 콘솔 검사를 죽였다
   (환경: opencode 서버 인스턴스 로드 타임아웃). → `?e2e=1` 일 때만 `console.warn` 으로 낮춘다.



