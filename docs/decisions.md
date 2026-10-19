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
- D26 원격 마우스 커서는 게시·표시하지 않음. 참가자 바, 도형 선택 외곽선, 슬라이드 위치만 유지.
  awareness 송신은 최대 4회/초. 이유: 마우스 이동마다 상태 전체를 JSON으로 송수신하고 리렌더하는 할당 부담, 기능 가치 낮음. (M7)
- D27 문서 뷰어의 네이티브 리소스(canvas, 디코드 이미지, ImageBitmap)는 원칙적으로 재사용(풀/LRU)한다.
  단, 순서가 있다: **먼저 유휴 상태의 다시 그리기 자체를 0회로 만든다.** 실제로 버려지는 객체가 측정될 때만 풀링한다.
  React가 소유한 DOM은 풀링하지 않고 key 안정화·prop 참조 고정으로 리마운트를 막는다.
  이유: 이 네이티브 메모리는 JS heap 밖이라 V8 GC가 늦게 돌고 레이아웃 객체가 고원까지 쌓인다.
  M7-2 실측 결과 canvas/OffscreenCanvas/getContext/size 재설정/img.src 대입/data URL/ImageBitmap/blob URL
  생성은 편집 3분간 **전부 0회**였다. 원인은 유휴 재렌더 2종(슬라이드 점 paint 자기 루프, usePeers 1Hz tick)이었다.
  → 풀링 대상 0건. 풀링보다 먼저 "다시 그리기 0회"가 정답이었다. (M7-2)

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

## 세션·메모리
- D30 탭당 파일당 세션 1개(registry). release는 acquire가 준 lease 토큰으로만(1회성, entry 소유 확인).
  path 기반 release API는 삭제. (8604b47, 28bf811)
- D31 4001 reset은 dropCollabSession 필수. drop 시 같은 세션을 쓰던 다른 보유자에게 통지. (342035c, 28bf811)
- D32 뷰어 닫기 = 언마운트. 숨겨서 유지 금지. (d95f8e7)
- D33 저장은 octet-stream 바이너리로 보내고 base64는 만들지 않음.
  같은 바이트는 재전송 생략(sha256, room 20개 상한). (0.12.64)
- D34 React Query 전역 gcTime 10초. 숨김 탭 30초 후 messages/message-list/last-message 캐시를
  type:'inactive'로 정리. (8607716)

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
