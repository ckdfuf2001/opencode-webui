# OpenCode WebUI - Architecture

This document describes the runtime architecture of this fork of
[opencode-webui](https://github.com/threehymns/opencode-webui), with emphasis
on the workspace, configuration and rules layout that differs from upstream.

## Process Topology

```
Browser (React/PWA, :5173) → Backend (Bun + Hono, :5001 dev / :5003 docker) → OpenCode server (opencode serve, :5552)
                                     ↑                                 ↑
                               SSE proxy                          SSE source
                            REST proxy (:5001 → :5552)          REST API
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
│   └── <repo>/opencode.json    # per-repo project config (agent-browser namespace override)
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
4. Repo directories under `workspace/repos/` do NOT get their own browser
   MCP entry — the single global entry applies to all repos. Per-repo duplicates
   are removed by `removeRepoAgentBrowserEntry` (`backend/src/services/default-mcp.ts`).

## Default MCP Servers (2026-09: Playwright)

`backend/src/services/default-mcp.ts` owns the built-in MCP servers (v0.7.8+):

- `doc-reader` — office-mcp fork (`vendor/office-mcp/server.py`, upstream
  https://github.com/JulianPoleszczuk/office-mcp + our `msg_*`/`embedded_*` and
  `read_document`/`edit_document`/`download_attachment` compat; Bridge port 8766,
  or portable `scripts/office-mcp.exe`) with `OPCODE_WEBUI_BACKEND` /
  `OPCODE_WEBUI_WORKSPACE` env. Legacy fallback `backend/scripts/doc_reader_mcp.py`
  (`scripts/doc-reader.exe`) is kept until preview/converter fully migrate.
- `playwright` — `npx --yes @playwright/mcp@latest --headless --isolated`
  (no daemon, `--isolated` gives per-call browser contexts, safe for concurrent
  sessions). First use auto-installs via npx cache.

`agent-browser` (native binary + vendored Chromium, `bin/agent-browser/`,
`agent-browser-proxy/`, daemon socket `~/.agent-browser/…`, `warmUpAgentBrowserDaemon`)
was removed in v0.7.8 and migrated to Playwright. Remaining references in
`default-mcp.ts` / `opencode-single-server.ts` are no-ops kept for rollback safety
(`warmUpAgentBrowserDaemon()` now returns `true`, `superviseAgentBrowserDaemon()`
is no-op, `buildAgentBrowserMcp()` returns the Playwright entry). On upgrade,
`writeActiveOpenCodeConfigFile()` and `mergeDefaultMcpEntries()` delete any stale
`mcp.agent-browser` entry from `workspace/.config/opencode/opencode.json` and
from `opencode_configs` DB (`is_default=1`), replacing it with `playwright`.
Portable start/stop scripts (`scripts/start_opencode_webui_exe.*`,
`scripts/stop_opencode_webui_exe.*`) no longer mention `agent-browser`.

`mergeDefaultMcpEntries(content)` (called from `ensureDefaultConfigExists()` and
`syncDefaultConfigToDisk()`, `backend/src/index.ts`) guarantees the **global**
config entries exist and **repairs** them on every sync:

1. `command` — replaced with the canonical absolute paths when they differ
   (doc-reader must point at `scripts/office-mcp.exe` or
   `vendor/office-mcp/server.py`, never a relative `..\backend\...` path).
2. `enabled: true` — forced on (except `playwright` user-disabled is respected).
3. `env` — each default key/value is merged in when missing or stale
   (e.g. `NO_PROXY` loopback bypass for Playwright).

Do **not** hand-edit the MCP entries in
`workspace/.config/opencode/opencode.json` — the backend regenerates the file
from the DB default config and repairs the entries at every startup
(`mergeDefaultMcpEntries` → `syncDefaultConfigToDisk()`), then spawns OpenCode
with the resulting config so the default MCP servers (`doc-reader`, `playwright`)
come up together. Use the app UI (Settings → MCP Servers) to change them beyond
the defaults.

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

## Chat File Uploads & Mentions

Files dropped on the page or pasted (Ctrl+V) while a chat session is open are
uploaded to the repo's `<repo>/chat_uploads/` folder via `POST /api/files`
(`frontend/src/pages/SessionDetail.tsx` `handleGlobalDrop`,
`frontend/src/components/message/PromptInput.tsx` `handlePaste`). The prompt
then carries a single-quoted mention (`@'chat_uploads/<name>'`) plus an entry
in the prompt input's attached-files map.

`parsePromptToParts` (`frontend/src/lib/promptParser.ts`) turns quoted or
unquoted `@mention` tokens into `file` parts when the mention matches the
attached-files map, otherwise keeps them as text. On send
(`frontend/src/hooks/useOpenCode.ts`):

- Supported MIME types (from `mimeForFilename`, e.g. images, text, PDF, Office)
  are sent as `file` parts with a Windows-absolute `file:///C:/...` URL
  (backslash-normalized, spaces encoded).
- Unsupported types (`application/octet-stream`) are sent as a quoted **text**
  mention instead, because opencode rejects `file` parts for MIME types it
  cannot handle and would abort the session with "functionality not supported".
  The mention stays clickable in history (see below).
- The optimistic user message applies the same rules so the UI pre-renders what
  the server will store.

Mentions render as clickable chips in chat history
(`frontend/src/components/message/MessagePart.tsx`): `file` parts resolve their
click target from the part URL (base64 `data:` URLs map back to
`chat_uploads/<filename>`, `file://` prefixes are stripped), and text mentions
are matched with `MENTION_PATTERN`. Clicking a chip opens the file browser at
the resolved path.

Clicking a chip whose path was collapsed to a bare filename by opencode (it
normalizes a `@'chat_uploads/...'` mention to `@<basename>` on store) falls
back to `<repo>/chat_uploads/<name>` when that file exists
(`SessionDetail.tsx` `handleFileClick`).

Editing a sent message rebuilds the prompt with
`MessageThread.getEditablePrompt()`: `file` parts become `@'filename'`,
unquoted text mentions are re-quoted, and "Called the ... tool" artifacts are
stripped, so edit-and-resend re-attaches the files.

Because `/api/files/*` receives an encoded path (spaces, Korean, parens),
`backend/src/routes/files.ts` decodes every path segment (`decodePath`,
`decodeURIComponent` per segment) before resolving it against the workspace.

## Key Components

**Frontend**
- `useOpenCode` hooks — React Query wrappers for all API calls; `useSendPrompt`
  converts attached files to opencode `file` parts (or quoted text mentions for
  unsupported MIME types). `useAbortSession` now POSTs `/api/session-status/:id/cancelled`
  so the Cancel badge persists until the next send (works for `workspace` sessions too).
- `MessagePart` / `MessageThread` — render `@mention` chips and offer
  edit-and-resend that restores quoted mentions
- `SessionDetail.tsx` / `SessionList.tsx` — Working/Cancelled badges from `GET /api/session-status`
  (busy/idle + `isCancelled` + `isCancelledUntilNextSend` fallback)
- `ScheduleManager` / `ScheduleCalendar` — calendar view merges `GET /api/command-runs/view` + `GET /api/schedules`
- `useSSE` — global SSE connection for real-time events; fallback is `session-status` poll (1.2s)
- `CreateCommandDialog` — registers command/skill/plugin/agent/MCP files

**Backend**
- `proxy.ts` — forwards `/api/opencode/*` to the OpenCode server, enriches
  `/command` with scope, injects `<memory-recall>` / `[run-context]` / `<skill-memory-check>`,
  and persists `isCancelled` on `POST /session/:id/abort`.
- `registry.ts` — resolves scope/target paths and writes opencode files
- `opencode-single-server.ts` — manages the OpenCode server process lifecycle
  and injects `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR`
- `scheduler.ts` — scheduled prompt runner
- `session-status.ts` — polls `GET /session/status` + `/permission|/question` per directory
  (1s) and upserts `session_status`; `upsertSessionStatus` preserves `is_cancelled`
  when `isCancelled` is not supplied so the poller never clears the Cancel badge.
- `recall.ts` / `fts-indexer.ts` / `git-indexer.ts` — `<memory-recall>` / `session_messages_fts`
  (trigram) / `git_commits` search stack
- `html-view.ts` — `GET|POST|DELETE /api/html-view/pages` backing the HTML view manager panel
- `routes/files.ts` — file browser + upload endpoints; `decodePath` percent-decodes
  each path segment so non-ASCII filenames resolve

## Verification

Reusable 5-check script: `scripts/verify-five-checks.ps1`

```
powershell -ExecutionPolicy Bypass -File scripts/verify-five-checks.ps1                # dev (5001)
powershell -ExecutionPolicy Bypass -File scripts/verify-five-checks.ps1 -BaseUrl http://localhost:5002 -TestRepoLocalPath aaa  # portable
```

Covers: (1) session create/model(delete)/delete, (2) Cancel badge (`isCancelled` persists through poller + abort), (3) calendar (`command-runs/view` + `schedules`), (4) memory recall (`/search/recall|messages|commits`), (5) HTML view (`/html-view/pages` CRUD + `/preview/extract`). See the script header for details.
