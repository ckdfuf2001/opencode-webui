# OpenCode WebUI - Agent Guidelines

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
  must point at `backend/scripts/doc_reader_mcp.py`, never a relative
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
