# 결정 기록 (Decisions)

형식: ID — 결정 / 이유 / 근거 커밋. 뒤집으려면 새 항목으로 기록하고 기존 항목에 "대체됨: Dxx".

## 아키텍처·프로토콜
- D01 디스크가 원본, 서버는 Yjs를 영구 저장하지 않음. room은 메모리에만 있고, 연결이 0개가 되면 30초 TTL 뒤 소멸.
- D02 transport는 `@hono/node-ws` + y-websocket 호환 프로토콜. prod(bun exe)도 `@hono/node-server`로
  서빙하므로 bun 어댑터 대신 사용. (0.12.49)
- D03 메시지 타입: 0 sync, 1 awareness는 relay. 3(query awareness)은 조용히 무시.
  99/100(room meta push: ownerClientId, lastHash, epoch, externalChanged, aiBlockedAt)/101(owner 전용 reset 요청)은 서버 전용 타입.
- D04 owner 선출은 백엔드가 함(lib 아님). 첫 awareness conn이 owner, 끊기면 earliest 승계,
  everOwner 우선 복원. 명시적 handoff 없음(`/handoff`는 410 스텁).
- D05 저장 충돌 판정은 서버 room.lastHash 기준(클라이언트 baseHash는 진단용).
  applySave는 room별 saveChain으로 직렬화, temp에 쓴 뒤 rename. 저장 중에는 watcher 무시.
- D06 epoch/resume: room 생성 시 epoch(UUID) 발급. 재연결은 /session(resumeEpoch, knownHash) 후
  같은 Y.Doc으로 재접속. viewer 리마운트·doc 재생성 금지.
  room이 살아 있으면 서버 lastHash로 판정, room이 없을 때만 knownHash 사용.
- D07 half-open 감지: lastRxAt 기준 25초 무수신이면 재연결, 서버 sweepDeadConns.
- D08 owner write-back/seed는 synced(step2 수신) && isOwner일 때만(클라이언트·서버 이중 가드).
  빈 바이트 저장 거부, 자동 경로는 배너 없이 스킵 + 500ms 후 1회 재시도.

## PPT
- D10 이미지: lib runtime.createImageUrl을 data: URL로 고정(blob:은 Y.Doc로 넘어가면 죽음).
  base64로 +33% 메모리 비용 감수. (8aeac39, f13d7a9)
- D11 image_loss 가드: 서버가 media/관계 수가 줄어든 저장을 409로 거부.
  `x-collab-allow-image-loss: 1`(사용자가 확정 버튼 누름)일 때만 통과. 이후 write-back 중지. (c7d0399, 97405fd)
- D12 4001 room_reset: owner가 type 101 전송 → 서버가 전원 close 4001 + room 해체.
  클라이언트는 dropCollabSession 후 파일 기준으로 재로드. 참가자가 있으면 확인창. (86589d5)
- D13 슬라이드 위치 게이트: 1 이상은 즉시 게시, 0은 300ms 지연 후 재확인.
  slideCount > 0이 되면 arm, getActiveSlideIndex로 실제 index 동기화. (c5c6b72, b0ab4f7, cbd69cd, aa47a9f)
- D14 PPT 동결(c638efa). 예외는 AGENTS.md C4절.

## Presence·UI
- D20 awareness는 `setLocalStateField('app', ...)`만 사용. 신원 정보의 단일 출처는
  `app.{id,name,color,mode,device,slide,where}`. 최상위 userName/userColor 게시 제거. (53a0c9d)
- D21 같은 app.id는 대표 상태 1개만 표시(app.slide 있음 > lastUpdated > clientID).
  lib slide fallback 제거. (4fb5d4b)
- D22 위치 텍스트("슬라이드 N", "Sheet1!B3")는 화면에 렌더하지 않음.
  app.slide/app.where와 data-slide는 내부·테스트용으로 유지. (c638efa)
- D23 참가자 표시는 상단 바 1곳 + 탐색기 숫자. lib의 공유/아바타 UI는 숨김(hiddenDialogs share). (fbf12c4)
- D24 입장/퇴장 토스트는 trace 모드에서만. 연결됨 배지는 에러일 때만 표시.
- D25 이름: 서버 `/suggest-name`(user1, user2…)으로 발급. 'You' 기본값 금지.
  코멘트는 작성자 이름 필수.
- D26 원격 마우스 커서 제거
  - 결정: 원격 마우스 커서는 게시·표시하지 않는다. 참가자 바, 도형 선택 외곽선, 슬라이드 위치만 유지한다.
    presence(awareness)는 SSE가 아니라 collab WebSocket으로 오간다. awareness 송신은 최대 4회/초.
  - 이유(측정 근거): 마우스 이동마다 상태 전체를 JSON 직렬화해 송신하고, 수신 측 projector가
    매번 React 리렌더를 유발한다. lib에 커서 토글 옵션이 없어 전송 계층에서 제거했다.
  - 금지: 커서 좌표를 awareness에 다시 게시하지 않는다. presence 전체를 지우지 않는다
    (원격 선택 외곽선이 `selectedElementId`에 의존).
  - 관련 커밋: 1d9a710, fbf12c4
  - 회귀 검사: 3-1(신규 presence 필터 금지 — 미활성), 3-2(`collabPresenceFilter.test.ts` 21건)

  근거 (lib 4.33.0 / ooxml-ui 1.8.0):
  - `chunk-552NAFTD.js:12570-12590` — pointermove마다 `broadcastPresence({cursorX, cursorY, activeSlideIndex})`.
  - `BROADCAST_THROTTLE_MS = 50` (`chunk-MCHPNO42.mjs:31551`) → 초당 20회 갱신.
  - 갱신 1회마다 상태 전체를 JSON 직렬화해 송신하고, 수신 측에서는 awareness
    'change'+'update' 두 이벤트마다 projector를 돌려(`chunk-552NAFTD.js:388-402`) React 리렌더가 뛴다.
  - 끄는 옵션이 없다: `CollaborationConfig`(`ooxml-ui/dist/pptx/types.d.ts:181-237`)과
    `ViewerDialogId`(`customization-types.d.ts:166`)에 커서 토글이 없다.
    → lib 패치 없이 **전송 계층**에서 제거한다.
  - 구현: `frontend/src/lib/collabPresenceFilter.ts`. y-protocols의
    `modifyAwarenessUpdate`(awareness.js:219)로 송수신 양쪽에서 좌표를 뺀다.
    로컬 state는 건드리지 않는다(C5의 setLocalState 금지 유지).
    커서만 바뀐 갱신은 생략하고 나머지는 초당 4회 + trailing.
  - `presence` 전체를 지우면 안 된다 — 원격 선택 외곽선(E3)이
    `selectedElementId`에 의존한다(`chunk-552NAFTD.js:12628`).
  - 수신에서 좌표를 빼면 `clampCursorPosition(undefined) = 0`이라 좌상단에 유령 커서가
    생긴다(`chunk-MCHPNO42.mjs:31626`). 표시 차단은
    `[data-testid='remote-user-cursors'] { display: none }`로 한다.
  - 보존 확인: `app.{id,name,color,mode}`, `presence.{userName,userColor,role,
    activeSlideIndex,selectedElementId}`는 그대로 전송된다.

- D27 재사용(풀) 원칙
  - 결정: 문서 뷰어의 네이티브 리소스(canvas, 디코드 이미지, ImageBitmap)는 원칙적으로 재사용(풀/LRU)한다.
    단, 순서가 있다: **먼저 유휴 상태의 "다시 그리기 자체"를 0회로 만든다.** 실제로 버려지는 객체가
    측정될 때만 풀링한다. React가 소유한 DOM은 풀링하지 않고 key 안정화·prop 참조 고정으로 리마운트를 막는다.
  - 이유(측정 근거): 이 네이티브 메모리는 JS heap 밖이라 V8 GC가 늦게 돌고 레이아웃 객체가 고원까지 쌓인다.
    M7-2 실측에서 canvas/OffscreenCanvas/getContext/size 재설정/img.src 대입/data URL/ImageBitmap/blob URL
    생성은 편집 3분간 **전부 0회**였다. 원인은 유휴 재렌더 2종(슬라이드 점 paint 자기 루프, usePeers 1Hz tick)이었다.
    → 풀링 대상 0건. 풀링보다 먼저 "다시 그리기 0회"가 정답이었다. (M7-2)
  - 금지: 추측으로 풀링을 먼저 넣지 않는다(측정 → 원인 → 수정). React 소유 DOM을 풀링하지 않는다.
  - 관련 커밋: 43232e2, 199bc09
  - 회귀 검사: 3-2(`memoryRender.test.ts` — 유휴 리렌더 0회 단언), 3-3(E2E 유휴 렌더 카운터)

- D28 스트림 출력 상한 통일 (결정됨, 4b-2에서 적용)
  - 결정: **실행 중 출력은 꼬리 20k자, 끝난 출력은 앞 20k자.** 전체 출력은 턴이 끝난 뒤 fetch로 받는다.
    상수는 1곳에만 둔다.
  - 이유(측정 근거): 코얼레싱을 해도 화면에 그릴 때 합치는 비용이 상한 크기에 비례하므로 꼬리를 120k로
    두면 델타마다(또는 100ms마다) 240KB 문자열을 복사한다. 현재는 주석("꼬리 120k")과
    코드(120k 초과 시 20k만 유지)가 어긋나고, 규칙이 3개(120k head / 120k→20k tail / 20k head)로 갈렸다.
  - 금지: 스트림 출력 상한 숫자를 상수 파일 밖에 두지 않는다(3-1은 현재 경고, 4b-2 적용 후 error로 전환).
  - 관련 커밋: f466c97(문서), 4b-2에서 코드 적용
  - 회귀 검사: 3-1(상한 상수 위치 — 현재 경고), 3-2(4b-2에서 추가)

## 세션·메모리

> 번호 매핑(M8 인계안 → 실제 파일). 인계안 D26/D27/D28은 그대로 D26/D27/D28.
> 인계안 D29 → D29(빈 번호). 인계안 D30(유휴 렌더 0회) → **D35**(기존 D30은 "세션 해제 = lease"로 별개).
> 인계안 D31(뷰어 닫기 = 언마운트) → **기존 D32**(내용 동일). 인계안 D32(collab 세션 수명) → **기존 D30+D31**(내용 동일).
> 인계안 D33(SSE 안전망) → **D36**(기존 D33은 octet-stream 저장).

- D29 폴링은 앱당 1개 + 상황별 주기
  - 결정: 같은 query key에서 `refetchInterval`을 가진 observer는 **최상위 1곳뿐**이다
    (`frontend/src/components/Pollers.tsx`). 나머지는 `refetchInterval: false`로 캐시만 읽는다.
    세션 상태는 busy면 1200ms, idle이면 5000ms, 숨김 탭에서는 정지한다.
  - 이유(측정 근거): 이전에는 상태를 쓰는 컴포넌트 9개가 각자 1.2초 타이머를 가져
    유휴 상태에서도 초당 수 번 폴링이 돌았다. observer 9개 × 1.2s = interval 실행 7.9/s,
    PPT 편집 모드 증가율이 +0.42 → +0.26MB/s로 내려갔다(M7-4 E-a vs E-g 실측).
  - 금지: 같은 query key에 `refetchInterval`을 새로 추가하지 않는다. 허용 목록에 넣으려면
    D29 근거와 측정값이 필요하다(`pnpm check:memory`가 걸러낸다).
  - 관련 커밋: 8683102
  - 회귀 검사: 3-1(`refetchInterval` 허용 목록 + **같은 query key 중복 검사**), 3-2(`memoryPolling.test.ts` —
    주기 1200/5000, 캐시 전용 observer는 타이머를 만들지 않음 / `memoryObserver.test.ts` —
    queryCache 기준 폴링 observer 1개 + 앱 소스가 조건부 폴링을 유지하는지), 3-3(E2E 유휴 interval run/s)

- D30 탭당 파일당 세션 1개(registry). release는 acquire가 준 lease 토큰으로만(1회성, entry 소유 확인).
  path 기반 release API는 삭제. (8604b47, 28bf811)
  - 결정: collab 세션은 registry가 소유하고, 해제는 lease 토큰으로만 한다.
  - 이유(측정 근거): path 기반 release + "누가 null이어도 해제" 조합은 다른 뷰어가 쓴 세션을 죽였다.
  - 금지: path 기반 release API를 다시 만들지 않는다.
  - 관련 커밋: 342035c, 28bf811
  - 회귀 검사: 3-1(`releaseCollabSession` export 금지), 3-2(`collabSessionRegistry.test.ts` 6건)

- D31 4001 reset은 dropCollabSession 필수. drop 시 같은 세션을 쓰던 다른 보유자에게 통지. (342035c, 28bf811)
  - 결정: 4001 reset은 `dropCollabSession`으로만 처리한다.
  - 이유(측정 근거): reset을 drop 없이 처리하면 화면과 서버 상태가 어긋나 조용한 유실이 생긴다.
  - 금지: 4001을 "재연결"로 대체하지 않는다.
  - 관련 커밋: 342035c, 28bf811
  - 회귀 검사: 3-2(`collabSessionRegistry.test.ts`)

- D32 뷰어 닫기 = 언마운트. 숨겨서 유지 금지. (d95f8e7)
  - 결정: 뷰어는 닫을 때 언마운트한다(`isOpen && <Viewer/>`). 숨김(display:none, visibility)으로 닫지 않는다.
    `FileBrowserSheet` 닫기는 경로 선택 UI만 닫는 것이고, 인라인 미리보기는
    "미리보기 닫기"(`explorerSelectedPath` 비움)로만 해제된다. **이것은 의도된 설계다.**
  - 이유(측정 근거): 닫은 뒤에도 뷰어 루프·presence 10초 재게시·Y.Doc(data: 이미지)이 살아 있어
    메모리가 반환되지 않았다. 언마운트로 소거시킨다.
  - 금지: 닫은 뷰어를 display:none으로 숨겨 두지 않는다. 시트 닫기와 파일 닫기를 같은 것으로 취급하지 않는다.
  - 관련 커밋: d95f8e7
  - 회귀 검사: 3-3(`viewer-unmount.spec.ts` — 닫은 뒤 viewer-root 0, `__openSockets()` 0)

- D33 저장은 octet-stream 바이너리로 보내고 base64는 만들지 않음.
  같은 바이트는 재전송 생략(sha256, room 20개 상한). (0.12.64)
- D34 React Query 전역 gcTime 10초. 숨김 탭 30초 후 messages/message-list/last-message 캐시를
  type:'inactive'로 정리. (8607716)

- D35 유휴 상태 렌더 0회
  - 결정: 데이터가 바뀌지 않으면 렌더하지 않는다. 1Hz 시각 tick은 시각을 표시하는 컴포넌트
    하위에만 공급한다(`NowCtx`/`NowProvider`). paint는 멱등으로 하고, 강제 리플로우
    (offsetWidth 등 읽기 후 쓰기)는 금지한다.
  - 이유(측정 groundwork): M7-2 실측에서 슬라이드 점 paint 자기 루프와 usePeers 1Hz tick이
    유휴 재렌더의 원인이었다. 레이아웃 8.6/s → 0/s, DOM mutation 73~147/s → 0/s, PptxViewer 렌더 2.6/s → 0/s.
  - 금지: 유휴 상태에서 setState를 호출하는 tick을 새로 넣지 않는다. 1Hz tick을 트리 전체에 공급하지 않는다.
  - 관련 커밋: 43232e2, 199bc09
  - 회귀 검사: 3-1(`setInterval` 허용 목록), 3-2(`memoryRender.test.ts` — 같은 데이터면 렌더 증가 0),
    3-3(E2E 유휴 렌더 카운터)

- D36 SSE 정상일 때 폴링은 안전망만 (결정됨, 4b-2에서 적용)
  - 결정: SSE on에서 폴링이 더 빨라지는 구조(`usePollLastMessage` 380ms)는 금지한다.
    SSE off이면서 busy일 때만 2000ms로 돌고, idle이면 정지하며 busy→idle 전환 시 최종 1회 fetch한다.
    세션당 EventSource는 1개다(전송용과 ephemeral이 공용 레지스트리 1개를 공유).
    델타는 100ms 코얼레싱으로 처리한다. SSE 정상 중에는 60개 전체 invalidate를 하지 않는다.
  - 이유(측정 groundwork): 4b-0 코드 조사에서 SSE on이 오히려 폴링을 5배 빠르게 만든 것을 확인했다
    (`useOpenCode.ts:1396` — `mergePartial ? 380 : 2000`, `mergePartial = sseOn`).
    델타 1개당 setQueryData 1회 + 할당 5개 + 누적 문자열 전체 복사가 붙는다.
    `part.delta`는 무조건 append이므로 스트림이 2개면 텍스트가 중복될 수 있다(정합성 버그).
  - 금지: SSE on에서 폴링 주기를 380ms로 두지 않는다. 세션당 EventSource를 2개 열지 않는다.
  - 관련 커밋: 4b-P0 / 4b-2에서 적용
  - 회귀 검사: 3-1(`new EventSource` 1곳 허용 — 현재 경고, 4b-P0 후 error), 3-2(중복 델타 1벌 테스트),
    3-3(E2E 세션당 소켓 1개)

- D37 자기 저장은 해시로 식별한다 (M10, 2026-10-20)
  - 결정: 자기 저장은 **내용(해시)** 으로 식별한다. 시간 창 방식은 금지한다.
    `applySave` 는 rename **전에** 새 해시를 `room.pendingHashes`(최근 3개)에 넣고,
    rename 이 끝나면 `room.lastHash` 를 갱신하면서 pending 에서 제거한다.
    watcher 는 디스크 해시가 `lastHash` 또는 `pendingHashes` 에 있으면 자기 저장으로 보고 무시한다.
    watcher 는 temp 파일명(`.tmp-*`)을 무시하고, 짧게 디바운스한 뒤 **최종 경로에서만** 해시를 계산하며,
    읽기 실패/크기 0 이면 판정을 보류하고 재시도한다.
  - 진짜 외부 변경의 대응: `externalChanged` 플래그와 lock/meta 통지만 한다.
    **방, owner, epoch는 유지한다.** 방 재설정은 owner 의 명시적 "파일 기준으로 다시 열기"(type 101 → 4001)로만 한다.
    owner 가 사라지는 경로는 conn close 와 TTL 뿐이어야 하며, 살아 있는 edit conn 이 있는데 owner 가 없으면
    `owner_cleared_unexpected` 오류 로그를 남긴다.
  - 이유(측정 근거): V1(E2 실패)의 근본 원인은 **동시 세션 POST 경합**이었다.
    `createSession` 에 경합 가드가 없으면 같은 파일에 방이 2개 만들어지고, rooms 맵에는 나중 것만 남아
    앞의 방은 고아가 된다. **고아 방의 watcher 도 살아 있어** 자기 방의 오래된 lastHash 와 디스크를 비교하면서
    다른 방이 방금 쓴 파일을 "외부 변경"으로 오인했다 → externalChanged → 클라이언트 재접속 → 409 →
    owner 상실 → 편집이 디스크에 반영되지 않음.
    증거: 백엔드 로그에 같은 room id 로 "created"가 1ms 간격 2회, 그 406ms 뒤 "external change detected".
    (`main.tsx` 의 `<StrictMode>` 가 dev에서 세션 POST 를 2회 호출해 이 경합을 드러낸다.)
  - 금지: 시간 창(저장 후 N초 내의 watcher 이벤트는 무시)으로 자기 저장을 판별하지 않는다.
    방 생성에 경합 가드를 두지 않는다. 외부 변경으로 방/owner/epoch를 없애지 않는다.
  - 관련 커밋: 705e63c (backend), T2f/T2g/T2h (backend/test/routes/collab-relay.test.ts)
  - 회귀 검사: 3-2(relay T2f 자기저장=외부변경 아님 / T2g 외부변경=방·owner 유지 / T2h 동시 세션 POST=방 1개)

- D38 저장 바이트의 출처와 편집 종료 순서 (M12/M14, 2026-10-20)
  - 결정(1): **저장 바이트는 Y.Doc 가 아니라 lib 뷰어의 직렬화 결과(getContent)다.**
    `PptxViewer.handleWriteBack(bytes)`(`frontend/src/components/file-browser/PptxViewer.tsx:554`)는
    lib 의 `onWriteBack` 이 넘긴 바이트를 그대로 `persistBytes` 로 보낸다.
  - 결정(1-정정, M14 실험): "커밋 후 A 의 뷰어 DOM 이 갱신되지 않아 구 내용이 직렬화된다"는
    **해소되었다**(실험: 커밋 +0.4초에 DOM 은 커밋 반영). 실제 원인은
    **커밋 직후 lib 의 write-back 이 호출되지 않는다**(타임라인에 `writeback.enter` 없음) +
    편집 모드 종료로 인한 **리마운트가 그 미처리 write-back 을 유실**시키는 것이다.
    ⇒ "lib 내부 문제"가 아니라 **앱이 리마운트를 너무 일찍 한다**는 문제다.
  - 결정(2): **편집 모드 종료는 flush(저장) await → viewerKey 변경(리마운트) 순서**다.
    flush 는 커밋 반영을 기다린 뒤(getContent) 저장하고, 실패하면 편집 모드를 유지하고 배너를 띄운다.
    (P1-6 "편집 종료는 flush 가 끝날 때까지 기다린다" 의 Escape 경로 적용.)
  - 결정(3): **저장 직전까지 "직전 성공 저장 이후 리마운트" 상태를 기록**하고,
    owner 인데 3초 이상 저장 요청이 없으면 `writeback_stalled` 로 경고한다(조용한 유실 탐지).
  - 이유(측정 근거): M14 실험.
    - 커밋 방식 3종 비교: **Escape=유실**(리마운트), 바깥 클릭=반영(2.5초 뒤 write-back), 다른 도형 클릭=반영.
      → 피해는 "Escape 로 끝낼 때"로 좁혀진다.
    - 커밋 반영 지연 ≈ 100ms(커밋 +0ms 에는 편집 상태, +300ms 에 반영) → flush 는 이 대기를 해야 한다.
    - P0 시나리오(A 먼저 접속·보기 / B 편집): **A 는 owner 가 아니었고(역할 viewer), B(편집)가 owner** 였다.
      서버 owner 규칙에 "편집 모드" 조건은 없으나, **owner 가 보기 모드일 때 아무도 저장하지 않는
      구조는 이 시나리오에서 재현되지 않았다**(단, B=owner 의 커밋이 같은 결함으로 유실됨).
  - 금지: **리마운트(언마운트) 이후의 flush**(M13 0-2). Y.Doc 을 앱에서 직접 직렬화.
    고정 sleep(커밋 반영 대기 대신). 시간 창 추측. lib 내부 write-back 스케줄에 의존한 암묵적 저장.
    (PptxViewer 안에서 `fileFullscreenChange` 를 듣는 방식은 금지 — `setEditing(false)` 와 경합해
     리마운트와 race happened. 종료 직렬화는 `setEditing` 을 가진 쪽(DocumentPreview) 한 곳에서만.)
  - 관련 커밋: 705e63c(백엔드 경합·해시 식별), ee12673(타임라인 계측), 06ca84c(no-store, **원인 아님** —
    파일 본문 캐시가 아니었다. 무해하므로 유지하되 "원인 아님"으로 기록), M14 종료 직렬화 커밋
  - 회귀 검사: 3-2(E2b — 편집 모드 종료 후 디스크에 편집이 남는지), 3-3(E2/E2b/E2c/E4 디스크 반영 계열)

## XLSX/DOCX (A1′)
- D40 YCollabSession mode: 'own'(PPT, 기존 경로 그대로)과 'transport'(XLSX/DOCX, lib provider가 doc/awareness 소유).
  transport 모드에서는 호스트 소유 doc을 destroy하지 않음. (e0a901d)
- D41 awareness 인스턴스는 1개만. `ycs.awareness === session.awareness` 단언(C7).
- D42 Yjs 타입 상수는 lib에서 import(SHEETS=getMap, YDOC_SLIDES_KEY=getArray).
  XLSX 빈 방 판정은 isSharedWorkbookEmpty.
- D43 lib의 createDepartureChannel(BroadcastChannel)은 pagehide 시 로컬 awareness만 정리하고
  transport가 아니므로 허용(D01 원칙 위반 아님).

## 미결정 (사용자 판단 대기)
- Q01 /handoff 410 스텁을 완전히 삭제할지.
- Q02 v0.13에서 이미지를 part 참조로 전환할지(Y.Doc 크기·전송량 문제, W3 측정 선행).
