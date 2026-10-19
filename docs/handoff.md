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
   "Save failed — staying in edit mode" 후 성공 토스트가 뜬다.

   재현: 상대(owner)가 편집 종료하는 순간 내가 저장.

   원인 (코드 확인됨):
   - `frontend/src/components/file-browser/PptxViewer.tsx:335` — `persistBytes`가 owner 여부를
     클라이언트에서 미리 보지 않고 곧바로 `collabApi.save(...)`를 호출한다.
   - 서버가 non-owner를 `denied`로 돌려보내 `res.ok === false`.
   - `PptxViewer.tsx:377` — `if (!quiet) showToast.error(res.message ?? 'Save failed')` 로
     "Save failed" 토스트가 뜬다.
   - `PptxViewer.tsx:512-513` — 저장 리스너가 `if (!ok) throw new Error('Save rejected')`.
   - `PptxViewer.tsx:528` — catch가 `officeSaveDone { ok: false }`를 뿌려
     DocumentPreview가 "staying in edit mode"을 표시한다.

   수정: owner가 아니고 synced면 API 호출 없이 성공 처리("자동 저장됩니다"). owner가 아직
   null(승계 중)이면 type 100 meta를 최대 3초 대기 후 재판정. owner인데 denied면 meta 1회 대기 후
   1회만 재시도. 수동 저장 1회 = 토스트 1개. 테스트 E21(수정 전 실패 확인).
   ※ 기존 B2("저장되지 않았다" 경고)는 이 증상으로 보고 B3에 통합.

2. **M6 보완** — `e2e/collab/viewer-unmount.spec.ts:135`의 소켓 단언이
   `toBeLessThanOrEqual(1)`이라 느슨하다(닫은 뒤 0이어야 함).
   M6c(시트/다이얼로그 닫기), xlsx/docx 닫기 각 1회 추가.
   사용자 확인: 닫은 뒤 viewer-root 0, sockets 0, GC 후 5분 heap 증가 < 5MB.
   열어 둔 채로도 계속 늘면 M7(lib 내부)로 분리하고 heap snapshot retainers 첨부.

3. **B1** — X-B1(xlsx Edit 20회, 편집 UI 표시 실패 0) 실행 결과 보고. b07b49b 하네스 기준.

4. **XLSX 공동편집** — X0a~X0f(라운드트립, 탭 2개, 30초 무쓰기, room_reset, owner meta 1초) → X1~X9.
   설계 기록은 `docs/collab-xlsx-docx.md`에 신설(아직 없음).

5. **DOCX** — D1~D9 (XLSX 완료 후).

6. **태그** — 검증 묶음 통과 후 버전 bump + exe 빌드.

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
