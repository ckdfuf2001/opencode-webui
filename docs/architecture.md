# OpenCode WebUI - Architecture

This document describes the runtime architecture of this fork of
[opencode-webui](https://github.com/threehymns/opencode-webui), with emphasis
on the workspace, configuration and rules layout that differs from upstream.

## Process Topology

```
Browser (React/PWA, :5173) → Backend (Bun + Hono, :5001) → OpenCode server (opencode serve, :5551)
                                    ↑                                 ↑
                              SSE proxy                          SSE source
                           REST proxy (:5001 → :5551)          REST API
```

- **Backend** owns the workspace directory, the SQLite database, the git
  repo/worktree lifecycle, the document conversion service, and the OpenCode
  server child process.
- **OpenCode server** is a single long-lived `opencode serve` child process
  spawned by `backend/src/services/opencode-single-server.ts`. All chat
  traffic is proxied through the backend.

## Workspace Layout

The workspace root defaults to `./workspace` (overridable with the
`WORKSPACE_PATH` env var; see `shared/src/config/env.ts`). Everything
application-owned lives inside it:

```
workspace/
├── repos/                      # cloned repos & worktrees (git-ignored)
├── AGENTS.md                   # project rules for sessions opened in workspace/ itself
└── .config/opencode/           # the app's OpenCode config dir ("global" scope)
    ├── opencode.json           # merged config (mcp, provider, etc.)
    ├── AGENTS.md               # global rules file (installed from docs/agent-domain-guide.md)
    ├── auth.json               # saved provider credentials
    ├── command/                # custom slash commands (<name>.md)
    ├── skill/                  # skills (<name>/SKILL.md)
    ├── agent/                  # custom agents (<name>.md)
    └── plugin/                 # custom tools/plugins (<name>.ts)
```

`getConfigPath()` (`shared/src/config/env.ts:85`) resolves the config dir from
`WORKSPACE_PATH` — it is **not** read from `OPENCODE_CONFIG_DIR` and is **not**
the user's `~/.config/opencode`.

## Configuration Flow

1. The backend merges the DB-stored default config and any configured MCP
   servers into `workspace/.config/opencode/opencode.json`
   (`syncDefaultConfigToDisk`, `backend/src/index.ts`).
2. When spawning the OpenCode server, the backend sets both:
   - `OPENCODE_CONFIG` → `workspace/.config/opencode/opencode.json`
   - `OPENCODE_CONFIG_DIR` → `workspace/.config/opencode`
   (`backend/src/services/opencode-single-server.ts`). This overrides opencode's
   default XDG path (`~/.config/opencode`), keeping every file the app manages
   inside the workspace.
3. `proxy.ts` patches the fetched config before forwarding it to the UI and
   resolves the scope of slash commands (`global` vs `project` vs `builtin`).

## Rules (AGENTS.md)

OpenCode applies two kinds of rules files:

- **Project rules** — `AGENTS.md` discovered by walking up from the session
  directory. `findUp` stops at the **git worktree root**, so
  `workspace/AGENTS.md` only applies to sessions opened directly in
  `workspace/`; sessions opened inside a repo under `workspace/repos/` never
  see it.
- **Global rules** — `AGENTS.md` at the config dir root (here
  `workspace/.config/opencode/AGENTS.md`). It applies to **every** session.

Because most sessions run inside a cloned repo (worktree), the domain guide is
installed as the **global rules file** so it always applies:

- `backend/src/index.ts` — `ensureGlobalRulesFile()` copies
  `docs/agent-domain-guide.md` → `workspace/.config/opencode/AGENTS.md` when
  missing.
- `scripts/setup-dev.sh`, `scripts/setup-dev.bat`,
  `scripts/docker-entrypoint.sh` — same install step during provisioning.

`docs/agent-domain-guide.md` defines the business concepts the assistant works
with (업무 = project handled by a dedicated agent, command = 작업 시작 명령어,
skill = 업무 스텝) and the agent approval types (일반 대화 / 슈퍼 배치 / 알림).

## OpenCode File Registry

The **Register new opencode file** dialog (command panel)
(`frontend/src/components/command/CreateCommandDialog.tsx`) writes opencode
config files via `POST /api/registry` (`backend/src/routes/registry.ts`).

**Scopes** (`scopeRoot`):

| Scope   | Root path                              |
|---------|----------------------------------------|
| global  | `getConfigPath()` → `workspace/.config/opencode` |
| project | `<repo-directory>/.opencode`           |

> Upstream/earlier builds wrote global files to `~/.config/opencode`; this fork
> writes to the workspace config dir so everything stays portable and
> git-ignored.

**Types** (`resolveTarget` / `buildContent`), matched to opencode v1.18.11
discovery rules:

| Type    | File                              | Content format |
|---------|-----------------------------------|----------------|
| command | `command/<name>.md`               | body only |
| skill   | `skill/<name>/SKILL.md`           | frontmatter `name`/`description` + body |
| tool    | `plugin/<name>.ts`                | raw TypeScript (uses `@opencode-ai/plugin`'s `tool()` helper) |
| agent   | `agent/<name>.md`                 | frontmatter `description`/`mode` + body (system prompt) |

Agent frontmatter:

```md
---
description: <description or name>
mode: all | subagent | primary
---
<system prompt>
```

### Scope detection (`backend/src/services/proxy.ts`)

`resolveCommandScope` decides whether a slash command is `global`, `project`,
or `builtin`. It checks both singular and plural directory spellings
(`command`/`commands`, `skill`/`skills`) because discovery and registry layouts
differ across opencode versions:

1. Project `.opencode/<dir>/` for the given repo directory → `project`
2. Global config dir `<dir>/` (both spellings) → `global`
3. Otherwise `builtin`

Config-defined and registry commands have no `.md` file on disk and are never
treated as `builtin`.

## Key Components

**Frontend**
- `useOpenCode` hooks — React Query wrappers for all API calls
- `useSSE` — global SSE connection for real-time events
- `useSessionActivity` — per-session "Working" state
- `usePermissionRequests` — global permission request polling + store
- `CreateCommandDialog` — registers command/skill/plugin/agent/MCP files

**Backend**
- `proxy.ts` — forwards `/api/opencode/*` to the OpenCode server, enriches
  `/command` with scope
- `registry.ts` — resolves scope/target paths and writes opencode files
- `opencode-single-server.ts` — manages the OpenCode server process lifecycle
  and injects `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR`
- `scheduler.ts` — scheduled prompt runner
- `file-operations.ts` — file read/write helpers used by the registry and the
  global-rules installer
