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
  point at the session proxy, never a stale direct `mcp --namespace` entry),
  env vars (proxy mode: `AGENT_BROWSER_NAMESPACE=opencode` +
  `AGENT_BROWSER_IDLE_TIMEOUT_MS=900000` + `SESSION_TTL_MS/SESSION_MAX/SESSION_SWEEP_MS`;
  stale direct-mode keys `AGENT_BROWSER_SESSION`/`AGENT_BROWSER_AUTO_SESSION`
  are removed). The user's `enabled` choice is
  PRESERVED (never force `enabled: true`) so the MCP Manager toggle works. Do
  not hand-edit MCPs in `workspace/.config/opencode/opencode.json`; use the app
  UI.
- **Agent-browser MCP runs through the session proxy by default**: the
  `agent-browser` MCP entry spawns `backend/scripts/agent-browser-proxy/mcp-server.mjs`
  (vendored from `ckdfuf2001/agent-browser` `proxy-v2.2.0`; compiled to
  `bin/agent-browser-proxy/agent-browser-proxy.exe` at package time, built by
  `scripts/build-agent-browser-proxy.ps1`). One shared daemon (namespace
  `opencode`), one browser per session. Every `agent_browser_*` call MUST pass
  an explicit `session` (first mint via `agent_browser_session_ensure`);
  `default` is rejected by the proxy. If the proxy is unavailable the backend
  falls back to the direct binary (`agent-browser mcp --namespace opencode`).
  Opencode does NOT forward the `env` field of an MCP entry to the spawned
  child (verified 2026-08), so all behavior must come from CLI args, not env.
- **Warm-up matches the real MCP spawn**: on a cold start the daemon inherits the
  MCP server's stdout pipe and `tools/call` hangs until the browser launches → the
  "first open fails" / `MCP error -32001: Request timed out` (~60s) symptom. The
  backend pre-warms per-repo sessions via `warmUpAllAgentBrowserDaemons()`
  (after opencode server start + every 60s). In proxy mode the warm-up spawns
  the proxy and runs `agent_browser_session_ensure` (reuse) +
  `agent_browser_open about:blank` on a throwaway `warmup-*` session to force
  the browser launch, then kills the MCP child (the background daemon survives).
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
