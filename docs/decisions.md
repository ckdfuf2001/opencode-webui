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
  - 결정(2-대기, M16): **커밋 반영 대기는 하지 않는다.** 앵커(바이트 비교)는 원리상 틀렸다 —
    앵커는 "마지막으로 실행된 write-back" 이므로 Escape 시점의 커밋 write-back(아직 예약 상태)과 다르다.
    바이트가 같아지는 순간은 오히려 구 내용을 "반영 완료"로 오판한다(실측 8145→8140).
    또 직렬화 시점마다 바이트가 달라 **정상 저장을 전부 막을 수 있다**(M15 결함 4).
    ⇒ **취소 대신 실행**으로 해결한다: lib 이 리마운트/role 변경 cleanup 에서 예약한 write-back 을
    `cancel()` 으로 버리는 것을 패치로 막는다.
  - 결정(2-취소, M18): **lib 패치로 write-back 예약을 취소하지 않는다.**
    `ooxml-ui/dist/pptx/chunk-MCHPNO42.mjs` 의 `createWriteBackScheduler` 에 `flush()` 를 추가하고,
    `pptx-react-viewer/dist/chunk-552NAFTD.js` 에 effect **두 개**를 둔다.
    - **(1) 언마운트 전용 effect**(`deps: [scheduler]`): cleanup 이 `flush()` 를 호출한다.
      언마운트 시 cleanup 은 선언 순서대로 실행되므로 (1) 이 먼저 flush 하고 (2) 의 cancel 은 예약이 없어 noop.
    - **(2) 원래 cancel effect 를 되살린다**(`deps: [scheduler, doc, role, hasWriteBack, externalSession]`):
      문서/role/외부 세션이 **바뀌면** 예약은 취소된다(강등·세션 교체 시 남은 예약 실행 금지).
    - **flush 실행 조건**: owner 인 경우(`pendingConfig.role === 'owner'`) **그리고**
      앱이 `flushOnUnmount !== false` 로 명시한 경우(기본 true).
      4001 리셋처럼 "이번 언마운트가 리셋" 인 경우는 **앱이 `flushOnUnmount=false` 로 알린다**
      (`PptxViewer` 의 `onReset` → `resetInFlightRef` → config). 리셋이면 예약은 취소된다.
    - **flush 는 scheduler 의 generation 과 분리된 자체 토큰**을 쓴다(M19).
      cancel() 은 generation 만 올리므로 **flush 를 무효화하지 않는다**(언마운트 시 저장 보존).
      명시적 중단이 필요할 때만 `abortFlush()` 를 쓴다(리셋 전용).
    - **언마운트 판정**: lib 안의 `unmountingRef` 로 구분한다.
      (1) 언마운트 전용 effect 가 cleanup 에서 `unmountingRef=true` → `flush({ allow })`.
      (2) 원래 cancel effect 는 `unmountingRef` 가 false 일 때만 cancel → 문서/role/세션 교체 시 취소.
    - **`flushOnUnmount` 은 최신 값**으로 읽는다(예약 당시 config 는 항상 true 라 잘못 판정된다).
      lib 의 cleanup 이 `latest.current.config?.flushOnUnmount` 를 읽어 `flush({ allow })` 로 전달.
    - **조용한 반환 금지**: skip 사유(not_ready/not_current/no_ydoc/no_source/error)를 로그로 남긴다.
    - **실행 시점은 시간 추측이 아니라 조건**: 로컬 편집이 Y.Doc 에 반영된 `update`
      (origin=`LOCAL_SYNC_ORIGIN`) **뒤**에 실행. 오지 않으면 상한 2초 뒤 실행하고 로그로 남긴다.
    - **실패를 조용히 삼키지 않는다**: 직렬화/저장 실패는 `console.error("[collab] write-back flush failed")`.
    근거: `chunk-552NAFTD.js:11437-11440`(cancel), `:11451`(owner 일 때만 전달),
    `chunk-MCHPNO42.mjs:33003`(스케줄러), `LOCAL_SYNC_ORIGIN`(`chunk-MCHPNO42.mjs:65`),
    바이트 출처는 `deps.serialize`/`getSourceBytes`(DOM 불필요).
  - 결정(2-범위, M15): `fileFullscreenChange`(전역 이벤트)는 **파일 식별자를 포함**해 전달하고,
    수신자는 **자기 파일만** 처리한다. `editing` 이 아니거나 `endingEdit` 중이면 무시한다.
    (B1(b): 한 뷰어의 Escape가 다른 파일의 편집까지 종료시키지 않게 한다.)
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
    **바이트 비교로 커밋 반영을 판정하는 것**(앵커 방식 — 원리상 틀리고 정상 저장까지 막는다).
    (PptxViewer 안에서 `fileFullscreenChange` 를 듣는 방식은 금지 — `setEditing(false)` 와 경합해
     리마운트와 race happened. 종료 직렬화는 `setEditing` 을 가진 쪽(DocumentPreview) 한 곳에서만.)
  - 관련 커밋: 705e63c(백엔드 경합·해시 식별), ee12673(타임라인 계측), 06ca84c(no-store, **원인 아님** —
    파일 본문 캐시가 아니었다. 무해하므로 유지하되 "원인 아님"으로 기록), M16 패치(① lib cancel→flush)
  - 회귀 검사: 3-2(E2b — 편집 모드 종료 후 디스크에 편집이 남는지), 3-3(E2/E2b/E2c/E4 디스크 반영 계열)

- D41 owner 규칙 (M18/M19, 2026-10-20)
  - 결정: **저장은 owner 만** 한다. 서버 `checkSave`(`backend/src/services/collab-rooms.ts:691`)가
    `isCurrentOwner` 로 막고, 아니면 409 `not_owner` 로 거절한다. (M18 1절에서 owner 가드가
    붕괴되지 않았음을 확인 — relay 경로 + 코드 확인.)
  - owner 선출: `reevaluateOwner` — edit 모드 conn 중 가장 먼저 들어온 conn. **view 모드 conn 은 owner 가 될 수 없다**
    (`connMode` 가 'view' 면 건너뛴다). owner 가 없으면 저장 자체가 막힌다.
  - 근거/주의: 이 규칙은 decisions 에 기록되어 있지 않아 코드에서만 존재했다(리뷰 지적).
    E4(2인 동시 편집)에서 **서버 owner 는 존재하는데 화면 `data-owner="true"` 가 0개**로 표시됐다
    ⇒ 저장 가드는 정상, **표시 경로(peer 칩의 owner 매칭) 문제**로 판정(1절 표의 (가)).
  - 관련 커밋: 705e63c(경합), ae29f89/이 커밋(패치), E4 표시는 v0.13.
  - 회귀 검사: 3-2(relay T2i — owner 가 아닌 conn 의 저장이 409), 3-3(E4 owner 표시)

- D42 lib 패치 적용 판정 기준 (M21, 2026-10-20)
  - 결정: **lib 패치는 "런타임 표식 단언" + "빌드 산출물 grep" 이 둘 다 통과해야 적용으로 간주한다.**
    dist 파일을 수정했다는 사실만으로는 판정하지 않는다.
  - 이유: M16~M20 동안 **훅 패치가 CJS 빌드(`dist/chunk-552NAFTD.js`)에 붙어 있고,
    브라우저가 로드하는 ESM 빌드(`dist/chunk-DD3ARHEW.mjs`)에는 없었다.**
    ⇒ 그 기간의 lib 로그 미수집·flush 미동작은 "패치 미적용" 때문이었고,
    "패치를 적용했다"는 주장으로는 판정이 안 된다.
    표식은 `globalThis.__ooxmlPatches = { ui|viewer: "M21" }` 처럼 모듈 최상단에 두되
    `'use strict'` directive 와 import 문 **뒤**에 둔다(directive 앞에 넣으면 파일이 sloppy 모드가 된다).
  - 관련 커밋: 34bc932(표식 도입), M21(ESM 빌드 적용 + fire() 버그 수정 + deadline 저장 금지)
  - 회귀 검사: 3-3(E2E 시작 조건 `assertLibPatchesLoaded` — ui/viewer=M21 아니면 즉시 실패),
    3-2(빌드 산출물 grep 검사)
  - X2a 추가 표식 (2026-10-27): `core: "X2a-core-esm"`(ooxml-core `dist/collab/index.mjs`,
    presence userId 전달+sanitize), `uiXlsx: "X2a-ui"`(ooxml-ui `dist/xlsx.js`,
    user.id 전달+people userId+타이틀바 userId 묶기). `ui: "M21"`은 유지한다.
  - X2a 판정 기록: pnpm 9에서는 patchedDependencies를 `package.json`과 lockfile에 기록한다.
    "lockfile이 적용을 담당한다"는 이전 해석은 철회한다. 전역 pnpm 11.x는 경고를 찍은 뒤
    `packageManager`(9.15.0)로 위임하므로, 패치 작업은 `npx --yes pnpm@9.15.0`으로 고정 실행한다.
    설치 전 `$env:NODE_ENV='development'` 필수(production이면 루트 devDependencies가 조용히 빠진다).

## XLSX/DOCX (A1′)
- D40 YCollabSession mode: 'own'(PPT, 기존 경로 그대로)과 'transport'(XLSX/DOCX, lib provider가 doc/awareness 소유).
  transport 모드에서는 호스트 소유 doc을 destroy하지 않음. (e0a901d)
- D41 awareness 인스턴스는 1개만. `ycs.awareness === session.awareness` 단언(C7).
- D42 Yjs 타입 상수는 lib에서 import(SHEETS=getMap, YDOC_SLIDES_KEY=getArray).
  XLSX 빈 방 판정은 isSharedWorkbookEmpty.
- D43 lib의 createDepartureChannel(BroadcastChannel)은 pagehide 시 로컬 awareness만 정리하고
  transport가 아니므로 허용(D01 원칙 위반 아님).

## 메모리 규칙 보정 (M24, 2026-10-20) — D38 관련 정정

- **superseded 판정 정정**: lib 의 publish 가드 `slides === superseded` 는 **참조 비교**라
  로컬 커밋이 slides 배열을 in-place 로 바꾸면(참조가 그대로) 커밋 전체가 reconcile 에서 건너뛰어진다.
  ⇒ **직전 상태의 serialized 비교**로 바꾼다(옛 로컬 상태 기준). 대입은 setSlides **전** 값,
  해제는 reconcile 성공 시와 reset 시.
  (계측 근거: `pub.call{len:10860, sameAsLastSynced:false}` → `pub.skip{superseded}` → 수정 후 `pub.reconcile`.)
- **flush 규칙 정정(M24, 실측 기준)**: 예약 있음 → **타이머를 앞당겨 즉시 실행**(예약=reconcile 반영 증거).
  예약 없음 → 1틱 대기 후 예약이 생겼으면 즉시 실행, 아니면 `nothing_pending`. allow=false(4001) → 예약 취소.
- **금지 추가**: **flush 가 lib 의 디바운스 예약을 clearTimeout 으로 지우는 것**(예약이 사라져 저장이
  아예 일어나지 않음 — 반드시 유지하거나 즉시 실행한다).
- **M22 반례 철회**: "예약 있음 → 즉시 실행은 E2/E2b 실패로 기각"은 **철회**한다.
  그때 실패는 clearTimeout 회귀(flush 가 예약을 지움) 때문이었고, 수정 후
  E2/E2b/E2f/E2g 8건이 모두 통과했다.
- **패치 관리**: `patches/*.patch` 는 **직접 편집 금지**(hunk 헤더 불일치로 설치가 실패한다).
  `pnpm patch <pkg>` → 파일 수정 → `pnpm patch-commit` 으로만 재생성한다.
  (M24: 손으로 편집한 패치가 `hunk header integrity check failed` 로 설치를 막은 것을 확인.)
- **테스트 결과(2026-10-20)**: E2 · E2b · E2f · E2g × chromium × repeat-each=2 = **8건 통과**.
  flush 로그: `wb.flush.start{hadSchedule:true}` → `wb.flush.run{bytes:8144/8145}` (직접 저장).

## D46 백엔드는 스스로 대기를 끝낸다 (B0, 2026-10-22)
- 결정(1): **에러 로그는 원인이 보여야 한다.** 링 버퍼(`GET /api/system/logs`)가 Error 를
  `JSON.stringify` 하면 AbortError/TimeoutError(DOMException)가 `{}` 로 찍혀 "타임아웃인지
  단절인지" 구분할 수 없다(무음 실패). ⇒ Error 는 name/message/code/cause 로 펼친다
  (`backend/src/utils/error-detail.ts` + `logger.serializeArg`).
- 결정(2): **턴 종료는 서버가 스스로 감지한다.** opencode 가 턴을 끝냈는데 응답만 오지 않으면
  백단은 600초(`SEND_HEADERS_TIMEOUT_MS`)까지 기다린다. ⇒ 세션 상태 폴러가 이미 관측하는
  busy/idle 을 재사용해 "발송 이후 busy 관측 → idle 관측"이 확인되면 붙어 있는 요청을 abort 한다.
- 안전장치: ① busy 를 한 번도 관측하지 못하면 끊지 않는다(오발 방지) ② 발송 중에는 큐 항목을
  제거하지 않는다(발송 실패 시 메시지 유실 방지) ③ 우리가 끊은 요청은 정상 종료로 기록한다.
- 금지: **클라이언트 단절을 업스트림 fetch 에 전파하지 않는다**(탭을 닫거나 페이지를 옮길 때
  진행 중이던 턴이 죽는다 — 실사용 회귀). 백단 대기는 서버 측 감지로 끝낸다.
- 관련 커밋: 611857a(B0-1 원인 노출), 4070622(B0-2 턴 종료 감지)
- 회귀 검사: 3-2(`backend/test/utils/logger.test.ts`, `error-detail.test.ts`,
  `backend/test/services/chat-queue-turn-end.test.ts` — 수정 전 실패 확인)

## D46 후속 (B0-3 · B0-5 · B0-6, 2026-10-28)
- 결정(3, B0-3): **직접 전송(proxy) 경로에도 턴 종료 감지를 적용한다.**
  큐 경로와 같은 규칙이다. POST `/session/:id/(message|command|shell|summarize)` 발송을
  세션별 AbortController로 추적하고(`proxy-turn-end.ts`), 상태 폴러가 "발송 이후 busy
  관측 → idle 관측"을 확인하면 붙어 있는 업스트림 요청을 끊는다. 발송 전에 헤더가
  나가지 않은 상태면 합성 200(`{ok, turnEnd:'idle-observed'}`)을 돌려준다.
  프론트는 settled refetch로 끝난 턴을 읽는다.
- 결정(4, B0-5): **SSE가 꺼져 있어도 bash 타일은 같은 컴포넌트·같은 모양이다.**
  원인 확정: 폴링 응답은 모드와 무관하게 동일하고(`useMessages`는 SSE 분기가 없다),
  input도 opencode DB에 있다. 안 보인 것은 렌더 분기였다(`MessageThread`가 미완료 툴을
  compact 행으로 그렸다). ⇒ compact 분기 제거, 같은 `ToolCallPart`로 통일한다.
  64KB 초과 capped 경로에서 떨어지던 `state.input`은 32KB 상한으로 보존한다(제목 폴백 유지).
  비교 함수에는 tool part의 `state.status`·`time.end`·`input` 유무를 넣는다. 특히
  last-message 병합 가드는 같은 출력에 상태 뒤집힘(running→completed)이 묻히면
  "변경 없음"으로 버리던 것을 교체로 바꾼다(`lastMessageMerge.ts` 추출).
- 결정(5, B0-6): **1분 reconcile sweep은 안전망으로만 남긴다.**
  전역 `setInterval(60s)` 하나(unref, 재진입 가드, D29 등록). 후보가 0이면 opencode를
  호출하지 않는다. 판정은 세션별·part별로 한다.
  세션 정리(DB busy 행, sending 큐, in-flight)는 idle 2회 연속(60초 간격) 관측 뒤에만 하고,
  큐 항목은 지우지 않고 기존 idle 확정 경로에 맡긴다.
  part 정리는 opencode에서 running으로 남은 tool part만 본다(2분 초과).
  세션이 busy면 건드리지 않는다. opencode idle 2회 연속이면 우리 DB에 고아 표시를 남기고
  `[reconcile] part-orphan`을 기록한다. opencode에서 끝난 part의 표시는 즉시 치우고
  `[reconcile] part-mismatch` 경고를 남긴다(버그 감시용).
  프론트는 기존 상태 폴러 값(`orphanParts`)만 읽어 타일에 "종료됨 · 응답 없음"을 표시한다.
  새 폴링은 만들지 않는다.
- 금지: **자동 abort 금지, opencode 데이터 쓰기 금지, 1회 관측으로 정리 금지.**
  클라이언트 단절 전파 금지(D46 유지). 세션 busy 중 running part는 구분 불가이므로
  경과 시간과 "중단" 버튼만 표시하고 손대지 않는다.
- 관련 커밋: b6a98c4·116a35a(B0-5 렌더·타일) · e552661·9106618(B0-5 capped input)
  · bad3218·d541473·3f03d4e(B0-5 확장 equality·merge가드·인코딩 복원)
  · c51b2c4·09870f9(B0-3) · 63e843f·1c60984·290ee88(B0-6)
- 회귀 검사: 3-2(`toolPartRender.test.ts`, `session-message-part.test.ts`,
  `messageListEquality.test.ts`, `lastMessageMerge.test.ts`,
  `proxy-turn-end.test.ts`, `reconcile-sweep.test.ts` — 수정 전 실패 확인)

## D45 편집 화면은 전체를 덮는다 / 닫기 가드는 넣지 않는다 (2026-10-22)
- 편집 화면은 `fixed inset-0 z-[100] bg-background flex flex-col` 로 뷰포트를 전부 덮고, 그 헤더가
  `aria-label="Close preview"` 버튼을 가로챈다(Playwright call log: `subtree intercepts pointer events`).
  `document.fullscreenElement` 는 `null`. ⇒ **편집 중 이탈 경로는 Done/Escape(`endEditing`)뿐**이다.
- 닫기 가드는 넣지 않는다. M34 의 document capture 클릭 가로채기는 비소유자/보기 모드에서
  미리보기를 닫지 못하게 하는 실사용 회귀였다 ⇒ M36 에서 revert.
- E2f-strict 는 "편집 → Done/Escape(`endEditing` 이 flush 를 await) → 곧바로 닫기" 를 검증한다.
  M31 grace 를 포함한 **언마운트 flush 경로는 미검증 안전망**으로 남는다(사용자가 닿을 수 없는 경로).

## D47 미리보기 닫기 = 탐색기 접기, 편집 액션 = 타이틀바 슬롯 (U1~U3, 2026-10-22)
- 결정(1): **미리보기를 닫는 별도 버튼을 두지 않는다.** 닫기는 탐색기 접기 하나로 일원화한다
  (패널이 언마운트되면 뷰어·Y.Doc·소켓이 함께 정리된다). D45 의 "편집 헤더가 Close preview 를
  가로챈다" 관찰은 이 결정으로 사라졌다 — 편집 중 이탈은 여전히 Done/Escape(`endEditing`)뿐이다.
- 결정(2): **편집 액션은 PPT 타이틀바의 기존 `actions` 슬롯**에 둔다(기능 search 오른쪽 `.end`).
  lib 에 슬롯을 새로 만들지 않는다. PPT 는 `chunk-MCHPNO42.mjs` 의 자체 `PptxTitleBar` 를 쓰므로
  베이스 `office-ui-title-bar`(chunk-O7APCA5N)에 슬롯을 추가해도 PPT 에는 반영되지 않는다.
- 결정(3): **AutoSave 표시는 호스트가 끌 수 있어야 한다** — `autosave.available === false` 면
  라벨/스위치를 숨긴다(앱이 저장을 소유하므로 lib 의 토글은 오해를 만든다).
- 결정(4): XLSX/DOCX 는 아직 타이틀바 슬롯이 없으므로 `DocumentPreview` 헤더를 유지한다.
  PPT 만 편집 중 헤더를 숨긴다. xlsx/docx 슬롯 지원은 v0.13 검토 항목.
- 관련 커밋: 8519875(U1), 7e737da(U2), c13b912(U3), 20281bf(M6b 테스트 보정)
- **패치 범위 확장(D42 기록)**: `actions` 슬롯은 ooxml-ui 에 원래 있었지만, 그 슬롯에 앱 내용을
  넣으려고 pptx-react-viewer 패치에 ① `titleBarSlot` prop ② `<div slot="actions">` 투영
  ③ 타입 선언 2곳(`dist/index.d.ts`, `dist/viewer/index.d.ts`)을 추가했고, ooxml-ui 패치에는
  ④ `autosave.available === false` 일 때 AutoSave 를 숨기는 hunk 를 추가했다. 즉 **lib 패치 2개가
  늘었다**(새 슬롯 정의가 아니라 호스트 주입 통로 추가).
- **패치 키 버전 고정**: `pnpm.patchedDependencies` 키를 `pptx-react-viewer@4.33.0` 으로 바꿨다.
  버전 키는 루트 의존성을 요구하지 않으므로 루트 devDependencies 의 `pptx-react-viewer` 를 제거했다
  (lockfile 에 jszip 3.10.1/3.10.2 두 스냅샷이 생기던 원인). clean install 후에도 런타임 표식
  `ui=M21`, `viewer=M21-esm` 과 `slot: "actions"` 가 설치본에 존재함을 확인했다.
- **Save 경로 확인**: Save 버튼 → `officeSaveRequest` → `PptxViewer.onSave` → `h.getContent()`
  → `persistBytes` → `saveSerializer.request`(`PptxViewer.tsx:735`). M32 의 serializer 우회 경로가 아니다.
- **기준선 대조(2026-10-22)**: `v0.12.70` worktree 와 HEAD 에서 동일 명령
  (`pptx-collab.spec.ts`, chromium, workers=1)으로 전수 실행. 양쪽 모두 **17 failed / 17 passed /
  1 skipped / did-not-run 0**, 실패 테스트 이름 집합이 **완전히 동일**(E3, E4, E7, E8, E9, E12, E15,
  E16b, E18, E19b, E20, E20s, E21, E21b, E11m/E1m·E2m·E3m). ⇒ HEAD-only 회귀 0건.
  전수 실행에서만 보였던 E5 는 재실행에서 통과(플레이크). 17건은 기존 실패로 백로그 처리한다.


## D48 XLSX 동시편집은 lib 가 방을 갖는다 (X0a/X1a/X1b, 2026-10-24)
- **배치**: PPT 는 앱이 Y.Doc/awareness/owner/write-back 를 직접 운영한다(`ycollab.ts` + `externalSession`).
  XLSX 는 ooxml-ui 의 xlsx 편집기가 **자체로** 방(Yjs)·presence·문서 공유를 구현한다
  (`collaboration` 옵션: `roomId` + `serverUrl` + `user`). ⇒ 앱은 **방을 만들고 옵션을 넘기는 배선**만 한다.
  앱 세션(`YCollabSession`)을 그대로 넘길 수 없다 — xlsx 는 ooxml-core `CollabSession` 인터페이스를 요구한다.
- **저장 경로(X1b 정정)**: XLSX 저장은 **`/api/collab/save`(applySave) 하나**로 통일한다.
  `/api/files` 덮어쓰기를 쓰면 방의 `lastHash` 가 갱신되지 않아 뒤에 참가자가 "낡은 방"으로
  판정되고, watcher 가 자기 저장을 외부 변경으로 오인한다.
  - 낙관적 잠금(base hash): 클라이언트는 **방이 알려준 해시**(`session.lastHash`)를 base 로 보낸다.
    방이 앞서 있으면 `conflict_room` → 클라이언트가 **방 상태를 다시 직렬화해 1회 재시도**한다.
    (모두 같은 방 상태를 갖고 있으므로 안전하다.)
  - `conflict_external`: 디스크 해시를 방이 모른다 = **외부 변경**(AI 편집·보기 모드 코멘트).
    재시도하지 않는다(덮어쓰면 조용한 유실). 배너 + "내 사본 다운로드" 로 알린다.
  - **정정**: 이전 문장의 "두 편집자가 저장해도 각자 병합된 방 상태를 쓰므로 실질적으로 같은 내용"은
    **틀렸다**. A 가 t1 에 직렬화한 바이트가 B 의 t2 바이트보다 늦게 도착하면 옛 내용이 이긴다
    (PPT 의 M26~M37 in-flight 역전과 같다). base hash 낙관적 잠금이 이 경합을 막는다.
- **낡은 방 차단은 서버가 판정한다(X1b 정정)**: 클라이언트 해시 비교는 `crypto.subtle` 을 쓴다.
  `http://IP:포트` 로 접속하면 보안 컨텍스트가 아니라 **항상 실패** → fail-closed 로 붙지 않는다.
  그래도 서버가 최종 판정한다: `session(strict)` 가 디스크 해시·`room.lastHash`·`knownHash` 를 비교해
  `stale_room`/`stale_client` 코드를 돌려준다. **클라이언트는 해시를 못 계산하면 방에 붙지 않는다.**
- **저장은 편집을 유지한다(X1b)**: 저장은 편집 모드를 끝내지 않는다(`keepEditing`).
  XLSX 는 lib 이 방 세션을 소유하므로 편집기가 내려가면 방에서 나가고 presence 가 사라진다.
  "Done" 만 편집기를 내리므로 그때 방 세션·소켓도 끝난다(X-M6).
- **코멘트는 동시편집 중 차단**: 코멘트 저장은 파일 바이트를 직접 고쳐 쓰고 뷰어를 재마운트한다.
  방이 살아 있으면 재마운트 뒤 **방의 내용이 이겨** 코멘트가 조용히 사라진다 ⇒ 편집 중에는
  버튼부터 비활성화하고 툴팁으로 알린다.
- **xlsx 방은 type 100 room meta 를 받지 않는다**: lib 클라이언트는 그 메시지 타입을 모른다.
  ⇒ `xlsx` 방은 meta 방송을 하지 않는다. XLSX 의 외부 변경은 **저장 시 서버 판정(409)** 으로 알린다.
- **X1c — 단독 저장도 잠근다(P0)**: 방에 못 붙은 사용자의 `/api/files?overwrite=1` 저장에도 잠금이 있다.
  - raw GET 이 **ETag(따옴표 없는 hex SHA-256)** 를 준다. HTTP 표준처럼 따옴표를 감쌀 수도 있으므로
    서버는 If-Match 비교 시 양쪽 따옴표를 벗겨 비교한다.
  - 단독 저장은 `If-Match` 를 보내고, 디스크가 그 사이 바뀌었으면 서버가 **409 `conflict_external`** 로 거부한다
    (조용한 유실 금지). `crypto.subtle` 이 필요 없어져 http 접속(폰)에서도 잠금이 동작한다.
  - 단독 저장 성공 응답에는 `body.etag`(헤더에도)가 담기고 클라이언트는 이 값으로 ETag 를 갱신한다
    — 방 저장(`applySave`)의 `newHash` 로도 갱신한다(방 저장이 디스크를 바꿨기 때문).
- **X1c — 모든 저장 실패에 다운로드+Done 확인(P0)**: `conflictBytes` 는 실패 분기 전부 room·solo 공통으로
  채워진다(최대 1개, D27). 실패 바이트가 있는 상태에서 Done 을 누르면 확인 대화상자가 먼저 뜬다
  — 그냥 닫히면 편집 내용이 사라진다.
- **X1c — 방 참가 전 편집 차단(P1)**: 참가 판정이 끝날 때까지 `connecting` 상태로 편집을 막는다
  (`collab.joined === true` 가 넘어오면 해제). 마운트 직후 입력이 "방의 문서가 이긴다" 규칙으로
  덮이는 조용한 유실을 막는다(X0a-9).
- **X1c — 서버 강제 규칙**: xlsx 방 저장은 `baseHash` 필수(없으면 400). `session(strict)` 의
  stale 판정은 해시 읽기 실패 시 stale 로 처리(fail-closed).
- **X1d — 잠금 필수 검사는 옵션을 넘긴 호출자에만**: `useOfficeSave` 의 ifMatch 체크 throw 는
  `requireIfMatch: true` 옵션을 넘긴 호출자(XlsxViewer)에만 적용된다. DOCX 등 다른 뷰어는
  If-Match 없이 기존대로 저장한다(서버도 없으면 덮어쓴다). 첫 구현의 무조건 throw 는
  DOCX 저장을 통째로 막았다(X-B2 회귀).
- **X1d — 연결 대기 상한 15초**: lib 의 `active` 는 공유 시작의 뜻일 뿐 소켓이 열렸다는 뜻이
  아니다(WebSocket 차단 테스트 X0a-10 에서 조기 해제 발견). 잠금 해제는
  `active && status==='connected' && synced` 세 조건으로 강화했고, 15초 안에 참가가 안 되면
  단독 편집으로 전환한다(배너 "연결 시간 초과"). 단독 전환이라 If-Match 잠금이 적용되어 안전하다.
- **X1d — Done 확인은 확인 시 닫힌다**: 실패 사본이 있는 상태에서 Done → 확인(OK)을 누르면
  **닫는다**(저장 실패여도 사용자가 확인했다는 뜻).
- **XLSX 는 v1 에서 수동 저장**: U2 의 "항상 자동 저장" 원칙은 이번 v1 의 XLSX 에는 적용하지 않는다
  (방 세션 수명과 편집기 수명이 같아 자동 저장이 바로 뒤엉킨다 — 자동 저장은 v0.13 에서 재검토).
- **v0.13 백로그(X1c·X1d 시점 추가)**: `conflict_external` 이후 복구 경로가 없다(방 리셋 4001과 함께 처리).
  `stale_room` 방은 TTL 이 끝날 때까지 새 참가자가 계속 단독으로 빠진다. 저장 재시도의 재직렬화에는
  아직 전파되지 않은 상대 편집이 빠질 수 있다(자동 저장을 붙일 때 재검토). 서버 로그가 `cid=0` 이라
  누가 저장했는지 추적할 수 없다(lib awareness clientID 로 교체). 폰(http)은 `knownHash` 를 raw ETag 로
  주면 동시편집에 참가할 수 있다 — 본 범위에서는 "참가하거나 409" 중 하나면 충분하다. `/api/files` 의
  If-Match 비교와 실제 쓰기가 원자적이지 않다(같은 경로 저장을 같은 체인으로 직렬화).
- v1 범위 밖(백로그): 보기 모드 참가, 소유자/위임 저장, 외부 파일 변경(AI 편집) 동기화,
  방 리셋(4001) 처리, 방 TTL 후 재접속, 코멘트와 동시편집 공존.
- 관련 커밋: 553fcbe(X0a/X1a) · 0aa90fa(X1b 테스트) · bb8942c(X1b 백엔드) · 0db32c9(X1b 프론트)
  · 31ca9d4(X1c 테스트) · 14c81c2(X1c 백엔드) · b1230ec(X1c 프론트) · 7cd9b56(X1c ETag 동기화)
  · e402d29(X1d 테스트) · e497aa0(X1d 수정)
- **X2a — 서버 participants 는 app/presence 두 키를 읽는다**: XLSX lib 은 `presence` 키로
  알리므로 기존 `app` 키 판정에서 0명으로 나왔다. `shared` 파서(`readLibPresence`)를 재사용하고,
  mode 는 `app.mode` 우선, 없으면 `presence.role==='viewer'`→view, 그 외 edit.
  `connMode`도 같은 판정. xlsx 방은 owner 로직 제외. clientId 가 viewer 인 xlsx 저장은 403 view_only
  (단 clientId 는 클라이언트 보고값이라 UI 차단과 함께 쓰는 보조 장치).
- **X2a — 묶기 키는 브라우저별 id다**: `readCollabUser().id`는 `u-<시간><난수>`로 localStorage에
  저장된다(같은 브라우저 탭은 같은 id, PC·폰은 다른 id). 앱이 이를 `collaboration.user.id`로
  넘기고, lib 패치가 presence `userId`로 싣고, 서버가 같은 `userId`를 하나로 센다.
  lib 은 `userId`를 기본 presence 에 싣지 않으므로 공개 API 로는 묶을 수 없어 패치했다.
- **X2a — viewer 는 방을 seed 하지 않는다**: ooxml-core `dist/collab/index.mjs:440`(`settle`),
  `:460`(`handleLoad`) 모두 `canWrite()`일 때만 쓰고, viewer 는 `canWrite`가 거짓.
- **X2a-③ — viewer 따라가기는 앱에서 처리한다**(lib 패치 없음). viewer-first 는 빈 방에서
  자기 파일을 보여 주고, 나중에 들어온 seed 를 따라가지 못한다(xlsx `bindWorkbookSession` 의
  settle 이 `!settled` 일 때 dirty 를 버린다 — `ooxml-core/dist/xlsx/collab/index.mjs:1115-1147`,
  특히 `:1140-1143`. `peers` 이벤트도 `waiting` 일 때만 settle 한다(`:1161-1163`).
  `synced` 는 변경 시에만 재발행이라 seed 도착을 알리지 않는다(`dist/collab/index.mjs:1145-1149`).
  그래서 공개 이벤트 `collaboration-change` 의 people 에서 편집자 수가 0→1 이상으로 바뀌면
  viewer 에디터를 한 번 리마운트한다(에디터 `key` 의 viewer 세대 번호).
  리마운트 때 방이 아직 비어 있을 수 있으므로(편집자 presence 가 seed 보다 먼저 온다),
  같은 이벤트에서 rooms() 의 `seeded` 를 확인하고, 비었으면 단발 3초 뒤 1회만 다시 확인한다
  (새 폴링/interval 없음). `unsent` 등 바인딩 플래그는 클로저 지역 변수라 리마운트 때 버려진다.
  prop 변경 자체는 lib 가 처리한다(`want()` 가 이전 연결을 정리하고 새로 연결 —
  `ooxml-ui/dist/xlsx.js:15421-15426`, React 래퍼 전달 `index.js:130`).
  X-M6 기대도 바뀌었다: Done 뒤 viewer 로 다시 붙어 방이 유지되므로, 방 해제는 미리보기 닫힘에서
  확인한다(X-M6-ext 가 마지막 viewer 퇴장을 확인).
  관련 커밋: 748b911·d63a501(X2a-① 테스트·수정) · b78a715(합친 mode) · a5cd867·9eed89b(X2a-1 테스트)
  · 0b0e354(ooxml-core 패치) · 1f330ef(ooxml-ui 패치) · 3c1610d(앱 user.id 전달)
  · c0783ad(rooms `seeded`) · 40d2605(X2a-③ 테스트) · d4733ee(X2a-③ 구현) · 9334d5a(X-M6 개정)

## 미결정 (사용자 판단 대기)
- Q01 /handoff 410 스텁을 완전히 삭제할지.
- Q02 v0.13에서 이미지를 part 참조로 전환할지(Y.Doc 크기·전송량 문제, W3 측정 선행).
