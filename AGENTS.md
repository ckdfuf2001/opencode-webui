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
- OpenCode server runs on port 5551, backend API on port 5001

## Operational Notes (avoid recurring mistakes)

- `workspace/` is fully gitignored. Anything under `workspace/.config/opencode/`
  (agents/commands/skills/plugins) and `workspace/repos/` is NOT versioned. Never
  rely on git to restore those files; keep canonical copies tracked in the repo.
- `workspace/.config/opencode/opencode.json` is regenerated from the DB default
  config at backend startup (`syncDefaultConfigToDisk()`). Default MCP servers
  (doc-reader, agent-browser) are handled via
  `backend/src/services/default-mcp.ts` (`mergeDefaultMcpEntries`): missing
  entries are added, and existing entries are **repaired** to the canonical
  absolute-path command (doc-reader must point at
  `backend/scripts/doc_reader_mcp.py`, never a relative `..\backend\...` path that
  breaks in per-repo sessions) with `enabled: true`. Do not hand-edit MCPs in
  that file; use the app UI.
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
