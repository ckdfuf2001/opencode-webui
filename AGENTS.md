# OpenCode WebUI - Agent Guidelines

공동편집(collab) 작업 시작 시 읽는 순서:
이 파일 → `docs/handoff.md` → `docs/decisions.md` → 해당 영역 문서
(`docs/collab-e2e.md`, `docs/memory-notes.md`, `docs/architecture.md`).

## Commands

- `npm run dev` - Start both backend (5001) and frontend (5173)
- `npm run dev:backend` - Backend only: `bun --watch backend/src/index.ts`
- `npm run dev:frontend` - Frontend only: `cd frontend && vite`
- `npm run build` - Build both backend and frontend
- `npm run test` - Run backend tests: `cd backend && bun test`
- `cd backend && bun test <filename>` - Run single test file
- `cd backend && vitest --ui` - Test UI with coverage
- `cd backend && vitest --coverage` - Coverage report
- `cd frontend && npm run lint` - Frontend linting

## Code Style

- No comments, self-documenting code only
- Strict TypeScript everywhere, proper typing required
- Named imports only: `import { Hono } from 'hono'`, `import { useState } from 'react'`

### Backend (Bun + Hono)

- Hono framework with Zod validation
- Error handling with try/catch and logging
- Follow existing route/service/utility structure
- Use async/await consistently, avoid .then() chains

### Frontend (React + Vite)

- @/ alias for components: `import { Button } from '@/components/ui/button'`
- Radix UI + Tailwind CSS, React Hook Form + Zod
- React Query for state management
- ESLint TypeScript rules enforced
- **Lint 기준 명령 (고정)**: `pnpm -C frontend exec eslint .` → 현재 **330 problems (272 errors, 58 warnings)**.
  이 값을 늘리지 않는 것이 목표이며, "신규 0" 판정은 **이 명령 하나**로만 한다.
  보조(PPT 동결 파일만): `pnpm -C frontend exec eslint src/components/file-browser/PptxViewer.tsx`
  → **9 problems (1 error, 8 warnings)**. 두 숫자는 범위가 달라 섞지 말 것.
  루트의 `pnpm exec eslint .` 는 flat config 마이그레이션 오류로 카운트가 나오지 않는다.
  (M8-0에서 정정. 이전 보고의 "9"는 파일 스코프, "330"은 frontend 전체 스코프였다.)
- Use React hooks properly, no direct state mutations

### General

- DRY principles, follow existing patterns
- ./opencode-src/ is reference only, never commit
- Use shared types from workspace package
- OpenCode server runs on port 5552, backend API on port 5001

## Operational Notes (avoid recurring mistakes)

- `workspace/` is fully gitignored. Anything under `workspace/.config/opencode/`
  (agents/commands/skills/plugins) and `workspace/repos/` is NOT versioned. Never
  rely on git to restore those files; keep canonical copies tracked in the repo.
- `workspace/.config/opencode/opencode.json` is regenerated from the DB default
  config at backend startup (`syncDefaultConfigToDisk()`). Default MCP servers
  (doc-reader, agent-browser) are handled via
  `backend/src/services/default-mcp.ts` (`mergeDefaultMcpEntries`): missing
  entries are added, and existing entries are **repaired** — command (doc-reader
  must point at `vendor/office-mcp/server.py` (legacy `backend/scripts/doc_reader_mcp.py`
  also accepted), never a relative
   `..\backend\...` path that breaks in per-repo sessions; agent-browser must
   point at the stock native `mcp` entry `[bin, 'mcp', '--namespace', 'opencode']`),
  env vars ( `AGENT_BROWSER_NAMESPACE=opencode` +
  `AGENT_BROWSER_IDLE_TIMEOUT_MS=900000` + `SESSION_TTL_MS/SESSION_MAX/SESSION_SWEEP_MS`;
  stale direct-mode keys `AGENT_BROWSER_SESSION`/`AGENT_BROWSER_AUTO_SESSION`
  are removed). The user's `enabled` choice is
  PRESERVED (never force `enabled: true`) so the MCP Manager toggle works. Do
  not hand-edit MCPs in `workspace/.config/opencode/opencode.json`; use the app
  UI.
- **Agent-browser MCP is the stock native `mcp`** (upstream
  `vercel-labs/agent-browser`, vendored binary + Chromium in `bin/`): the
  `agent-browser` MCP entry spawns `[bin, 'mcp', '--namespace', 'opencode']`.
  No session proxy — every `agent_browser_*` call passes `namespace` + `session`
  directly and each session owns its daemon+browser (upstream model).
  Opencode does NOT forward the `env` field of an MCP entry to the spawned
  child (verified 2026-08), so all behavior must come from CLI args, not env —
  EXCEPT the daemon identity env below, which the backend injects into the
  opencode server spawn env so the whole tree inherits it.
- **Daemon identity comes from server env, not MCP env**: the backend injects
  `AGENT_BROWSER_NAMESPACE=opencode` + `AGENT_BROWSER_EXECUTABLE_PATH` (vendored
  Chromium) + `AGENT_BROWSER_IDLE_TIMEOUT_MS=900000` into the opencode server
  child env (`agentBrowserEnv()` in `backend/src/services/default-mcp.ts`).
  Server → proxy → short-lived CLI → daemon all inherit it, so every caller
  shares ONE daemon/Chrome with ONE config fingerprint. Without this each
  session forks its own daemon+Chrome and fingerprint drift causes
  restart wars (10060s) and leaks (dozens of `chrome for testing` → OOM).
- **Warm-up matches the real MCP spawn**: on a cold start the daemon inherits the
  MCP server's stdout pipe and `tools/call` hangs until the browser launches → the
  "first open fails" / `MCP error -32001: Request timed out` (~60s) symptom.
  agent-browser 0.37.1 fixes this class in-binary (temp-file MCP output, reuse
  live daemon PID unconditionally), but the backend still pre-warms so the
  first real `open` is fast. Each session owns its daemon+browser (upstream model, sidecars keyed by session),
  so the backend warms ONCE via warmUpAllAgentBrowserDaemons()
  (after opencode server start) - never per-repo in parallel:
  parallel warmups contend on first launch and leak Chrome trees
  (dozens of chrome for testing processes = OOM). The warm-up spawns
  a throwaway native MCP child and runs
  agent_browser_open about:blank on a throwaway warmup-opencode session to force
  the browser launch, then kills the MCP child (the session daemon survives).
  Same-key calls attach to the in-flight warmup, so the 60s tick never piles on.
  The 60s tick runs superviseAgentBrowserDaemon(): it deletes sidecars of
  dead pids (zombie port 10060 방지) and of deaf-but-alive daemons, warms when
  no daemon is alive (5-min retry backoff on failure), and NEVER kills a live
  process - kill wars were the flicker/10061 source. Stale session targets
  self-heal on next call instead of 10060ing. A browser is pre-warmed (startup + when
  cold), never force-launched per call.
- Socket dir is install-scoped (`.agent-browser-home` under the install root,
  `AGENT_BROWSER_SOCKET_DIR`): portable/other installs never share the daemon. Live daemon list is at
  `GET /api/mcp/agent-browser/status` (`daemons` array); manual reconcile is
  `POST /api/mcp/agent-browser/supervise`.
  Do NOT warm with `open --headed false`: that produces a different daemon profile and
  the MCP restarts it on first use (measured ~45s instead of <300ms). When
  debugging MCP/browser issues, check `AGENT_BROWSER_NAMESPACE=opencode
  agent-browser session info --json` for `active`/`browserLaunched` before blaming the config.
  Live status is also at `GET /api/mcp/agent-browser/status`.
- If `bin/agent-browser/.meta.json` or `bin/agent-browser/bin/…` is missing,
  `resolveAgentBrowser()` returns null and the agent-browser MCP entry is not
  registered — run `npm run agent-browser:install` (auto-run by predev).
- MCP servers can briefly report `disabled` in the opencode web UI while connecting;
  they switch to `connected` after a few seconds. Not an error.
- opencode scans **plural** directories (`agents/`, `commands/`, `skills/`,
  `plugins/`) as canonical; singular (`agent/`, `command/`, `skill/`) is legacy.
  The app registry writes plural paths.
- backend/src/index.ts startup sync: `ensureDefaultConfigExists` → `syncDefaultConfigToDisk`
  → `ensureGlobalRulesFile` (copies `docs/agent-domain-guide.md` to config AGENTS.md if missing).
- Backend API docs served at runtime (works in exe deployments):
  - `GET /api/openapi.json` — OpenAPI 3.1 spec for all backend routes
  - `GET /api/docs` — Swagger UI (loads from `/api/openapi.json`)
- Backend logs: `GET /api/system/logs?limit=&level=` (in-memory ring, last 500).
  Build fingerprint: UI footer `BUILD_LABEL` + `GET /api/system/info` version
  (exe embeds `PACKAGE_VERSION` via bun `--define`; cwd package.json fallback).

## 버그 재발 방지 절차 (0.11.0~)

수정보다 절차 준수가 먼저다. 상세 워크플로는 `.opencode/skills/rework/SKILL.md`.

### 1. 작업 단위

- 1 수정 = 1 커밋. 영역 prefix (`fix(chat):`, `fix(permission):`, `feat(...)`, `docs:`, `chore:`).
- 추측 수정 금지. 재현 없이 코드 손대지 않는다.

### 2. 필수 진행 순서 (증거 → 수정 → 증명 → 기록)

1. **재현**: live면 watcher/probe 스크립트로 형태 포착. 재현 안 되면 손대지 않는다.
2. **원인 확정**: 코드 경로 추적 + 실측 (DB 읽기·API GET·e2e probe). "아마"로 수정 금지.
3. **수정**: 최소 diff. 판단 분기마다 로그를 남긴다 (무음 `return`/무음 catch 금지).
4. **검증 4종** (전부 통과해야 커밋):
   - `tsc -b` (frontend) — 건드린 파일 무관 에러 0개
   - backend `vitest run` — 신규/수정 테스트 포함. 기존 환경실패(`bun:sqlite` 2파일) 외 실패 금지
   - 신규·수정 로직 unit 테스트 (순수 함수는 필수)
   - live probe: 수정 전/후 대조 실측
5. **기록**: 커밋 메시지에 원인 1줄. probe 스크립트는 `scripts/verify-*`로 repo 편입.

### 3. 절대 금칙

- PowerShell `Get-Content`/`Set-Content`로 파일 편집 금지 (한글 파괴 전적). `edit`/`write` 도구만 사용.
- 실행 중 서버 kill, 실행 중 exe 덮어쓰기 금지.
- 합의 없는 히스토리 rewrite 금지 (force-push는 명시 지시 때만).
- 파괴적 부팅 동작 금지: DB-workspace 매칭 안 되면 삭제 대신 로그만.
- 버전 추정 금지: 실행 바이너리 판정은 `rank`·지문 등 실측으로만.
- 무음 실패 금지: 판단 불능 시 무응답/무로그 패턴을 새로 만들지 않는다.

### 4. 릴리즈 절차 (portable)

1. `tag` → build (`scripts/package-portable.ps1`)
2. `rank` 200 + 빌드 지문(푸터·`/api/system/info`) 확인
3. `data/opencode.db` 백업
4. 구 exe 종료 확인 후 교체 → 재시작
5. smoke 3종: doc-reader 상대경로 1건 · permission ask 1건 · 세션 생성 1건
6. 태그 푸시

### 5. 버전 규칙

- 새 라인부터 `0.11.x`. 지문 확인을 절차에 고정.
- 롤백은 바이너리 교체로만 (DB는 유지). 히스토리 수술 아님.

### 6. Live 버그 포착 프로토콜

- ask/팝업류: living-list 폴링으로 형태 확보 후 판정.
- 팝업이 뜨면 바로 누르지 말고 보고 — 승인 주체(백엔드/사용자)부터 가른다.
- 고착류(UI 멈춤): 건드리지 말고 보고 — 세션 상태·큐·마지막 메시지 플래그를 그 순간에 읽는다.

## 공동편집 개발 규칙 (0.12.x)

### C1. 브랜치·푸시·버전

- 작업 브랜치: `release-0.12`. 푸시는 항상 `release-0.12`와 `main` 둘 다.
- 푸시 후 `git ls-remote origin main release-0.12` 출력으로 두 해시 일치 확인 후 보고.
- 태그/버전 bump는 브라우저 검증(E2E + 사용자 수동 확인) 후에만.
- 커밋은 작업 단위(가이드 항목 ID)로 분리. 메시지에 ID 포함: `fix(collab): ... (B3)`.

### C2. 보고 규칙

- 보고는 명령 출력과 근거 줄 번호(`파일:줄`)로만. 추정은 "(추정)"으로 명시.
- "이미 처리됨"이면 근거 코드 줄 번호 첨부.
- 이전 보고가 틀렸으면 먼저 정정하고 진행.
- 네트워크 실패(git fetch/push)는 출력 그대로 기재. 성공처럼 쓰지 않는다.
- 브라우저 조작이 필요한 검증은 "사용자 확인 필요"로 분리하고 절차를 적는다.

### C3. 수정 원칙

- 측정·근거 먼저, 수정은 근거가 지목한 곳만. 추측 수정 금지.
- 버그 수정에는 회귀 테스트를 붙인다. 수정 전 코드에서 실패하는 것을 확인한다
  (stash → 실행 → 실패 출력 첨부 → 복구).
- lib(node_modules) 직접 패치 금지. 필요하면 patch-package + 근거 주석.
  globalThis 덮어쓰기 금지.
- lib 동작에 의존하는 코드에는 lib 근거 줄(`chunk-xxx.js:줄`) 주석을 단다.
- 문자열 상수 복붙 금지. lib이 export하는 상수를 import한다(YDOC_SLIDES_KEY, SHEETS 등).

### C4. 동결 구역

- PPT 동결(c638efa 이후): `PptxViewer.tsx`, `slideLocationGate.ts`, PPT 전용 E2E는 수정 금지.
  예외: 데이터 손실, 메모리 누수, 저장 실패 표시 오류(B3). 예외 적용 시 커밋 메시지에
  `PPT freeze exception` 명시.
- 공통 코드(`ycollab.ts`, `collab-rooms.ts`, `collabSessionRegistry.ts`) 변경 시
  PPT E2E 전체 회귀 필수.

### C5. 공동편집 불변 규칙 (상세: docs/decisions.md)

- 디스크 파일이 원본. 서버는 Yjs 상태를 영구 저장하지 않는다.
- 디스크 저장은 owner 1명만, 서버가 강제한다.
- 외부 변경은 자동 병합하지 않고 배너만 띄운다.
- 저장 실패 시 토스트 + "내 사본 다운로드". 조용한 유실 금지.
- BroadcastChannel을 transport로 쓰지 않는다.
- awareness는 `setLocalStateField('app', ...)`로만 쓴다. `setLocalState()` 금지.
- 세션 해제는 lease 토큰으로만. path 기반 release 금지.
- 뷰어 "닫기" = 언마운트. 숨겨서 유지 금지.

### C6. 테스트·환경 (2026-10-19 실측 기준선)

- **이 환경은 `NODE_ENV=production`으로 설정돼 있다.** `pnpm install` 전에
  `$env:NODE_ENV='development'`로 바꿔야 devDependencies가 설치된다.
  그러지 않으면 vitest/typescript 등 dev 도구가 조용히 빠져 테스트가 "not found"로 죽는다.
- 단위+프론트 테스트: `pnpm -C backend test -- run` — 프론트 테스트도 이 경로로 돈다
  (`backend/vitest.config.ts`의 `include`가 `../frontend/test/**`를 포함).
  `pnpm -C frontend test` 스크립트는 **존재하지 않는다**.
  기준선: **469 passed / 2 failed suites** (`config-migration.test.ts`,
  `repo-tracking.test.ts` — 둘 다 `bun:sqlite` 부재라는 기존 환경 실패).
  프론트 테스트는 `../frontend/test` 7파일 61건.
  이 2개 외 실패가 생기면 회귀다.
- 메모리 규칙: `pnpm check:memory` (scripts/check-memory-rules.mjs) — 폴링·interval·EventSource
  추가 시 실패한다. `pnpm test`가 이 검사를 먼저 돌린다. 허용 목록은 scripts/memory-allowlist.json.
- 타입: `pnpm -C frontend exec tsc -b` (별도 스크립트 없음). 기준선: **에러 0**.
- 린트: `pnpm -C frontend exec eslint .`. 기준선: **330 problems (272 errors, 58 warnings)** —
  `no-explicit-any`·`no-empty` 중심의 기존 누적값. 새 문제를 늘리지 않는 것이 목표.
  (PPT 파일만 볼 때는 `pnpm -C frontend exec eslint src/components/file-browser/PptxViewer.tsx` = 9 problems.)
- E2E: `bun run test:e2e:collab --repeat-each=3` (chromium + msedge, workers 1, retries 0).
  VPN 끄고 실행. 실패 시 `test-results/`의 trace.zip 첨부.
- Playwright: trace 'retain-on-failure', video 'off', screenshot 'only-on-failure'.
- 디스크: 파일 삭제 금지(`release/`, `node_modules`, `.git` 손대지 않음). 테스트 전 여유 공간 확인.
- 디버그 훅: `?collabDebug=1` → `window.__collabDebug`, `?memDebug=1` → `__memProbe`/`__memFloor`/
  `__openSockets`/`__openEventSources`/`__moduleMapSizes`. 제거 금지(회귀 시 재사용).

### C7. 메모리 판정

- heapMB(performance.memory) 단독 판정 금지. GC 버튼 직후 값 또는 `__memFloor()` 바닥선으로만.
- 상세: `docs/memory-notes.md`

### C8. 메모리 규칙 (M8)

- 폴링·interval·EventSource를 새로 추가하면 `pnpm check:memory`가 실패한다. 허용 목록에 넣으려면
  `docs/decisions.md`의 D29 근거와 측정값이 필요하다.
- 검사 출력은 `허용 N / 미허용 M / 전체 T` 형식이고, **같은 query key에 폴링이 2곳** 있어도 실패한다.
  허용 목록 항목에는 근거(reason)가 반드시 있어야 한다.
- 뷰어는 닫을 때 언마운트한다(D32). 세션 해제는 lease 토큰으로만 한다(D30·D31).
- 메모리 측정은 `docs/memory-notes.md`의 규칙(10초 프로브, 벽시계, GC 후 JS heap 병기)만 따른다.
- 성능·메모리 변경 보고에는 전/후 표(interval run/s, MB/s, JS heap floor)를 반드시 넣는다.
- 린트 기준: `pnpm -C frontend exec eslint .` = 330 problems(신규 0). 상세는 C6절.

