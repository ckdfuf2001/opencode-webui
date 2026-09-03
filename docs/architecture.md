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
4. Each repo directory under `workspace/repos/` gets its own project-level
   `opencode.json` (written/merged by `writeRepoOpenCodeConfig`,
   `backend/src/services/default-mcp.ts`). By default it carries the same `agent-browser`
   MCP as the global config (`namespace=opencode`, `session=opencode`/`default`) so all repos share ONE browser instance. With `AGENT_BROWSER_AUTO_SESSION=1` (patched `ckdfuf2001/agent-browser`), `default`/`opencode` is auto-hashed to `auto-<cwd-hash>` per repo, so `open`/`read` without an explicit `session` no longer returns blank. The global `opencode.json` keeps the bare
   `doc-reader` + `agent-browser` entries for sessions that run outside a repo.

## Default MCP Servers & agent-browser daemon warm-up

`backend/src/services/default-mcp.ts` owns the two built-in MCP servers:

- `doc-reader` — FastMCP/stdio Python server
  (`backend/scripts/doc_reader_mcp.py`) with `OPCODE_WEBUI_BACKEND` /
  `OPCODE_WEBUI_WORKSPACE` env.
- `agent-browser` — native binary + vendored Chromium
  (`bin/agent-browser/`, paths from `.meta.json`). Its command is
  `<bin> mcp --namespace opencode` and its env pins
  `AGENT_BROWSER_NAMESPACE=opencode`, `AGENT_BROWSER_SESSION=<session>` and
  `AGENT_BROWSER_IDLE_TIMEOUT_MS=86400000` (24h).

Namespaces isolate the agent-browser daemon socket
(`~/.agent-browser/namespaces/<ns>/run`). The global config and all repos use `opencode` namespace. **By default** `AGENT_BROWSER_SESSION` is `opencode`/`default` for everyone, so `agent_browser_*` calls without an explicit `session` go to the same `default` browser — `read` on a fresh `default` returns blank, so you must pass `session` (e.g. `session: "repo-Test"`) or enable `AGENT_BROWSER_AUTO_SESSION=1` in the patched `ckdfuf2001/agent-browser` (`auto-<cwd-hash>` per repo, see `cli/src/flags.rs`). `writeRepoOpenCodeConfig()` still writes a per-repo `opencode.json` but, in default mode, it carries the same `default` session as the global config; per-repo `repo-*` isolation is only active when the env `AGENT_BROWSER_AUTO_SESSION` or an explicit `session` param is used. Sessions, when isolated, share ONE Chrome tree in the `opencode` namespace via CDP browser contexts.

`mergeDefaultMcpEntries(content)` (called from `ensureDefaultConfigExists()` and
`syncDefaultConfigToDisk()`, `backend/src/index.ts`) guarantees the **global**
config entries exist and **repairs** them on every sync:

1. `command` — replaced with the canonical absolute paths when they differ
   (doc-reader must point at `backend/scripts/doc_reader_mcp.py`, never a
   relative `..\backend\...` path that breaks in per-repo sessions).
2. `enabled: true` — forced on.
3. `env` — each default key/value is merged in when missing or stale (this is
   what keeps `AGENT_BROWSER_NAMESPACE` and `AGENT_BROWSER_IDLE_TIMEOUT_MS`
   present in a config regenerated from the DB).

Per-repo `opencode.json` files are written directly by `writeRepoOpenCodeConfig`
and are **not** re-merged by `syncDefaultConfigToDisk` — the repo root config is
untouched by the global sync so a repo keeps its own namespace.

The agent-browser MCP server spawns the CLI per tool call; that CLI talks to a
long-lived background **daemon** over a local socket (namespace-scoped under
`~/.agent-browser/namespaces/<ns>/run`). On a cold start the freshly-spawned
daemon inherits the MCP server's stdout pipe, so the MCP server never receives
EOF and `tools/call` waits ~40-75s then times out — the "first open hangs"
failure mode. `warmUpAgentBrowserDaemon(namespace, session)` prevents it:

- Called right after the opencode server starts
  (`opencodeServerManager.start().then(...)`, `backend/src/index.ts`) and
  re-called every 60s on a self-healing interval. `warmUpAllAgentBrowserDaemons()`
  warms the `opencode:default` daemon only (single, `v0.3.10` behavior), so the first `agent_browser_open` is fast; per-repo `auto-*` sessions are created lazily on first `open`/`read` with `AGENT_BROWSER_AUTO_SESSION=1`.
- Runs `<bin> --headed false open about:blank --json` (stdio discarded), which
  spawns + connects the daemon and launches a headless browser.
- Skips (fast no-op) when `agent-browser session info --json` already reports
  `active` with `browserLaunched: true`, so the periodic re-check is cheap.
- `AGENT_BROWSER_IDLE_TIMEOUT_MS=86400000` keeps that warm daemon alive between
  tool calls; a warm daemon answers `agent_browser_open` in <1s.

Do **not** hand-edit the MCP entries in
`workspace/.config/opencode/opencode.json` — the backend regenerates the file
from the DB default config and repairs the entries at every startup
(`mergeDefaultMcpEntries` → `syncDefaultConfigToDisk()`), then spawns OpenCode
with the resulting config so the default MCP servers (doc-reader, agent-browser)
come up together. Use the app UI (Settings → MCP Servers) to change them beyond
the defaults. Repo-root `opencode.json` files are written
by the backend per repo; only the `agent-browser` key is managed there, so a
repo's own config keys are preserved when re-written.

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
  unsupported MIME types)
- `MessagePart` / `MessageThread` — render `@mention` chips and offer
  edit-and-resend that restores quoted mentions
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
- `routes/files.ts` — file browser + upload endpoints; `decodePath` percent-decodes
  each path segment so non-ASCII filenames resolve
