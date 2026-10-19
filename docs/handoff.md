# Handoff — 2026-10-19 기준

## 원격 상태 (2026-10-19 로컬에서 실측)
- `git ls-remote origin main release-0.12` → 양쪽 모두 `d95f8e7be37eeb67bbff4fa62a887ca2308166c9`.
  `fix(viewer): unmount the document viewer on close (M6)`.
- 로컬 `release-0.12`은 `f66f2b6`에서 **118커밋 뒤처져 있었으나** fast-forward로 `d95f8e7`에 정렬했다.
- 작업 트리 클린, `git stash list` 비어 있음. 푸시 안 된 로컬 작업은 없었음.
- 마지막 exe: 0.12.68(보고 기준). 그 이후 브랜치에 태그 없음(브라우저 검증 대기).

## 검증 대기 묶음 (태그 전 필수)
53a0c9d · 3c8e89c · 7e0633b · c5c6b72 · 3e12b25 · b0ab4f7 · 603d511 · cbd69cd · aa47a9f ·
c638efa · e0a901d · 71bb069 · 342035c · 28bf811 · bc80ca1 · 8607716 · b07b49b · d95f8e7

- E2E: `bun run test:e2e:collab --repeat-each=3` (PPT E1–E20s + M6 + X-B1), chromium + msedge
- 사용자 수동 확인:
  ① Chrome 3→1 이동 시 Edge에 슬라이드 1 표시
  ② Edge 이미지 3장
  ③ 혼자 "파일 기준으로 다시 열기"
  ④ PPT 닫은 뒤 viewer-root 0 / `__openSockets()` 0
  ⑤ 10분 방치 `__memFloor` 바닥선 상승 없음

## 기준선 (2026-10-19 실측 — 이전 문서의 "22/22, lint 9"는 오기였음)
| 항목 | 명령 | 실측값 |
|---|---|---|
| 단위+프론트 | `pnpm -C backend test -- run` | **430 passed**, 2 failed suites |
| 타입 | `pnpm -C frontend exec tsc -b` | **에러 0** (exit 0) |
| 린트 | `pnpm -C frontend lint` | **330 problems (272 errors, 58 warnings)** |

- 실패하는 2개는 `backend/test/services/config-migration.test.ts`,
  `backend/test/services/repo-tracking.test.ts` — 둘 다 `bun:sqlite` 미설치 탓이다.
  기존 AGENTS.md 4절이 이미 "기존 환경실패(`bun:sqlite` 2파일) 외 실패 금지"로 명시한 그대로다.
  **이 2개 외에 실패가 생기면 회귀다.**
- `pnpm -C frontend test` 스크립트는 존재하지 않는다. 프론트 테스트는 백엔드 vitest가
  `backend/vitest.config.ts:23`의 `include: [... '../frontend/test/**/*.{test,spec}.ts']`로 돌린다.
- 이 PC의 `NODE_ENV=production` 때문에 `pnpm install`이 devDependencies를 건너뛴다.
  `$env:NODE_ENV='development'`로 설정하고 설치해야 vitest/tsc가 생긴다.

## 진행 순서

1. **B3 (P0, PPT freeze exception)** — 공동편집 중 owner가 아닌 사람이 수동 저장하면
   "Save failed — staying in edit mode" 후 성공 토스트가 뜬다. **→ 수정 완료 (커밋 아래 참조)**

   재현: 상대(owner)가 편집 종료하는 순간 내가 저장.

   원인 (코드 확인됨):
   - `frontend/src/components/file-browser/PptxViewer.tsx` — `persistBytes`가 owner 여부를
     클라이언트에서 미리 보지 않고 곧바로 `collabApi.save(...)`를 호출한다.
   - 서버가 non-owner를 `denied`로 돌려보내 `res.ok === false`.
   - `PptxViewer.tsx:377` — `if (!quiet) showToast.error(res.message ?? 'Save failed')` 로
     "Save failed" 토스트가 뜬다.
   - `PptxViewer.tsx:512-513` — 저장 리스너가 `if (!ok) throw new Error('Save rejected')`.
     수동 저장은 `quiet: true`로 들어오므로 377의 토스트는 막히고 이 경로로만 번진다.
   - `PptxViewer.tsx:528` — catch가 `officeSaveDone { ok: false }`를 뿌려
     `DocumentPreview.tsx:500`의 'Save failed — staying in edit mode'이 표시된다.

   수정: `decideSaveIntent`(신규 `frontend/src/lib/collabSaveIntent.ts`)로 저장 전에 판정한다.
   owner 미확정은 meta를 최대 3초 대기해 재판정하고, owner가 아니면 API를 부르지 않고
   위임 성공으로 처리한다(토스트 1개). owner인데 denied면 meta 1회 대기 후 1회만 재시도한다.

   검증: `frontend/test/collabSaveIntent.test.ts` 5케이스.
   수정 전 게이트(항상 persist)로 돌리면 **3 failed / 2 passed**로 실패함을 확인했다.
   수정 후 **5 passed**. 전체 단위 435 passed(기준선 430 + 5), tsc 에러 0, lint 330 유지.

   ⚠ E21 E2E(`e2e/collab/pptx-collab.spec.ts`)는 추가했지만 **이 PC에서 실행 확인하지 못했다** —
   아래 "E2E 하네스 장애" 참조.

2. **M6 보완** — `e2e/collab/viewer-unmount.spec.ts:135`의 소켓 단언이
   `toBeLessThanOrEqual(1)`이라 느슨하다(닫은 뒤 0이어야 함).
   M6c(시트/다이얼로그 닫기), xlsx/docx 닫기 각 1회 추가.
   사용자 확인: 닫은 뒤 viewer-root 0, sockets 0, GC 후 5분 heap 증가 < 5MB.
   열어 둔 채로도 계속 늘면 M7(lib 내부)로 분리하고 heap snapshot retainers 첨부.

3. **B1** — X-B1(xlsx Edit 20회, 편집 UI 표시 실패 0) 실행 결과 보고. b07b49b 하네스 기준.
   2026-10-19 chromium 기준 **1 passed (1.5m)** 로 재현 확인했다. msedge는 미확인.

4. **XLSX 공동편집** — X0a~X0f(라운드트립, 탭 2개, 30초 무쓰기, room_reset, owner meta 1초) → X1~X9.
   설계 기록은 `docs/collab-xlsx-docx.md`에 신설(아직 없음).

5. **DOCX** — D1~D9 (XLSX 완료 후).

6. **태그** — 검증 묶음 통과 후 버전 bump + exe 빌드.

## E2E 하네스 장애 (2026-10-19 실측) — PPT 스펙 전체가 이 환경에서 실행 불가

`e2e/collab/pptx-collab.spec.ts`의 **모든 테스트**가 `openFile`에서 실패한다.
E21만의 문제가 아니다. 근거:

- `E1: participants` (수정 전 코드 그대로) → `locator.click: Timeout`으로 실패.
- `X-B1` (xlsx-solo) → **1 passed (1.5m)**.

차이는 fixture 생성 시점이다. `playwright.config.ts:12-16`이 이미 경고하고 있는 그대로다.

> 백엔드는 시작 시 저장소 트리를 스캔해 children 을 채운다. children 이 `[]` 로 스캔된 폴더는
> needFetch=false 이므로 이후에 파일을 심어도 절대 다시 조회되지 않는다.

- X-B1은 서버 뜨기 **전에** 심은 `probe-seeded-before-server.xlsx`를 연다 → 통과.
- `pptx-collab.spec.ts`의 `freshFile()`은 **테스트 실행 중**에 파일을 만든다
  (`helpers/env.ts:11-14` → `repos/collab-e2e/<slug>-<stamp>-<i>.pptx`) → 트리에 안 뜬다.

추가로 이 PC의 저장소 경로에 공백이 있어(`C:\Users\oh\Documents\Default Project\...`)
`bun run test:e2e:collab` 스크립트가 깨진다:
`'C:\Users\oh\Documents\Default' is not recognized as an internal or external command`.
`npx playwright test -c e2e/collab/playwright.config.ts`로 직접 호출해야 한다.

→ E2E는 공백 없는 경로의 PC에서 돌리거나, `freshFile`을 서버 기동 전 시딩으로 바꾸고
   재실행해야 한다. 그전까지 E2E 통과로 보고하지 말 것.


## 정리 대상 (작음, 별도 커밋)
- `frontend/src/api/collab.ts:191-192`의 `resetRoom` 제거. `/api/collab/reset-room` 라우트는
  백엔드에 없다 — `backend/src/routes/collab.ts`가 `/session`·`/save`·`/handoff`·`/lock`·`/rooms`·
  `/suggest-name`만 등록한다(스키마도 `collab.ts:40`에서 이미 제거됨). **죽은 코드.**
- 세션 effect의 `if (!user) return` 경로에 cleanup(dead=true) 추가.

## v0.13 목록
- 이미지 part 참조 전환(Y.Doc 이중 저장, 이미지 이동 시 update 바이트 측정 W3 선행)
- usePeers의 legacy userName/userColor fallback 제거
- docx/xlsx 코멘트 저장 이름이 collab 개명을 따라가지 않는 문제(TODO(v0.13))
- P2-4 base64 경로 잔재 정리
- `/handoff` 410 스텁 처리(Q01)
- backfilledIds 상한(retainers가 지목할 때만)
