This repository is a clone of threehymns/opencode-webui, not related to the
upstream opencode project. Some architecture is changed — see
[`docs/architecture.md`](docs/architecture.md) for the workspace, config and
rules layout.

https://github.com/threehymns/opencode-webui

# OpenCode Web Manager

A full-stack web application for running [OpenCode](https://github.com/sst/opencode) in local processes, controllable via a modern web interface. Designed to allow users to run and control OpenCode from their phone or any device with a web browser.  

## Features

### Repository Management
- **Multi-Repository Support** - Clone and manage multiple git repos/worktrees in local workspaces
- **Private Repository Support** - GitHub PAT configuration for cloning private repos
- **Worktree Support** - Create and manage Git worktrees for working on multiple branches

### Git Integration
- **Git Diff Viewer** - View file changes with unified diff, line numbers, and addition/deletion counts
- **Git Status Panel** - See all uncommitted changes (modified, added, deleted, renamed, untracked)
- **Branch Switching** - Switch between branches via dropdown
- **Branch/Worktree Creation** - Create new branch workspaces from any repository
- **Ahead/Behind Tracking** - Shows commits ahead/behind remote
- **Push PRs to GitHub** - Create and push pull requests directly from your phone

### File Browser
- **Directory Navigation** - Browse files and folders with tree view
- **File Search** - Search files within directories
- **Syntax Highlighting** - Code preview with syntax highlighting
- **File Operations** - Create files/folders, rename, delete
- **Drag-and-Drop Upload** - Upload files by dragging into the browser
- **Large File Support** - Virtualization for large files
- **Upload Notifications** - Success/error toasts after upload (shows the actual saved name when a filename collision is auto-renamed, or the blocked extension on rejection)
- **Safe Type Allowance** - Uploads accept most file types (Office, PDF, images, archives, etc.); only a small blacklist of executable/script types (`.exe`, `.bat`, `.cmd`, `.com`, `.scr`, `.vbs`, `.ps1`, `.msi`, `.dll`, `.lnk`) is rejected
- **Auto-Rename on Collision** - If a file with the same name already exists, the upload is saved as `name (1).ext`, `name (2).ext`, etc.
- **Session Drag-and-Drop** - With a chat session open, dropping files anywhere on the page uploads them to the repo's `chat_uploads/` folder and inserts their `@'path'` mention into the prompt for the assistant
- **Clipboard Paste Upload** - With a chat session open, pasting files/images (Ctrl+V) uploads them to `chat_uploads/` and inserts an `@'path'` mention into the prompt
- **Clickable File Mentions** - `@'path'` mentions render as clickable chips in chat history; clicking opens the file in the file browser (handles `chat_uploads/` files, `file://` URLs and base64 data-URL parts alike)
- **Edit & Resend Restores Mentions** - Editing a sent message rebuilds the prompt with quoted `@'filename'` mentions (and drops the "Called the ... tool" artifacts), so resending keeps the file attachments

### Chat & Session Features
- **Slash Commands** - Built-in commands (`/help`, `/new`, `/models`, `/export`, `/compact`, etc.)
- **Custom Commands** - Create custom slash commands with templates
- **File Mentions** - Reference files with `@filename` autocomplete
- **Plan/Build Mode Toggle** - Switch between read-only and file-change modes
- **Session Management** - Create, search, delete, and bulk delete sessions
- **Real-time Streaming** - Live message streaming with SSE
- **Session Activity Indicator** - "Working" badge shows when LLM is actively processing in a session
- **Safe Slash Commands** - Only executes commands available on the OpenCode server; unknown commands show a toast warning instead of failing

### AI Model & Provider Configuration
- **Model Selection** - Browse and select from available AI models with filtering
- **Provider Management** - Configure multiple AI providers with API keys
- **Context Usage Indicator** - Visual progress bar showing token usage
- **Agent Configuration** - Create custom agents with system prompts and tool permissions
- **Per-Session Model Switching** - Change the active model mid-session via the model selector dialog

### MCP Server Management
- **MCP Server Configuration** - Add local (command-based) or remote (HTTP) MCP servers
- **Server Templates** - Pre-built templates for common MCP servers
- **Enable/Disable Servers** - Toggle servers on/off with auto-restart

### Settings & Customization
- **Theme Selection** - Dark, Light, or System theme
- **Keyboard Shortcuts** - Customizable keyboard shortcuts
- **OpenCode Config Editor** - Raw JSON editor for advanced configuration

### Mobile & PWA
- **Mobile-First Design** - Responsive UI optimized for mobile use
- **PWA Support** - Installable as Progressive Web App
- **iOS Keyboard Support** - Proper keyboard handling on iOS

### Text-to-Speech (TTS)
- **AI Message Playback** - Listen to assistant responses with TTS
- **OpenAI-Compatible** - Works with any OpenAI-compatible TTS endpoint
- **Voice & Speed Controls** - Configurable voice selection and playback speed
- **Custom Endpoints** - Connect to local or self-hosted TTS services

## Added Features

### Chat File Uploads
- **`chat_uploads/` upload folder** - Files dropped or pasted into a chat session are uploaded to `<repo>/chat_uploads/`, keeping them separate from the repo source; the folder is git-ignored along with the rest of the workspace
- **Quoted mentions** - Attachments are always referenced as `@'chat_uploads/<name>'` (single-quoted), so Korean/spaced filenames survive mention parsing on both the send and edit paths
- **Unsupported-file fallback** - Files whose MIME type opencode cannot handle (`application/octet-stream`, e.g. `.xls`) are sent as a quoted text mention instead of a `file` part, so the session never aborts with "functionality not supported"; the mention stays clickable in history
- **File URL resolution** - Attached files are sent to opencode as `file:///C:/...` URLs (Windows-absolute, backslash-normalized, space-encoded), which opencode resolves reliably
- **Optimistic history** - The optimistic user message mirrors the above rules so the UI matches what the server stores
- **Edit round-trip** - `MessageThread.getEditablePrompt()` rebuilds the edit prompt from the stored parts: file parts become `@'filename'`, unquoted text mentions are re-quoted, and "Called the ... tool" artifacts are stripped

### File Browser
- **Path decoding** - `backend/src/routes/files.ts` now percent-decodes each path segment (`decodePath`), so filenames with Korean characters, spaces, or parens load correctly instead of 404
- **Mention click resolution** - Clicking a `@filename` chip whose path was stripped to a bare name by opencode falls back to `<repo>/chat_uploads/<name>` when that file exists

### Document Viewer (DRM Office/PDF)
- **DRM-Protected Document Preview** - Preview DRM-protected Office documents directly in the browser by converting them through the local desktop Microsoft Office COM (doc, docx, xls, xlsx, ppt, pptx -> PDF), then rendering with pdf.js
- **Client-Side Fallback Viewers** - Inline viewers for PDF (pdf.js), Word (mammoth), Excel (xlsx + sticky row/column headers), and PowerPoint (JSZip XML parsing) when the conversion service is unavailable
- **Zoom Controls** - Zoom in/out (50% - 300%) and reset buttons in the document preview header; PDF pages re-render at higher resolution for crisp zoom, HTML viewers scale natively
- **Excel Fit-to-Page** - Wide spreadsheets are fit to a single page using `FitToPagesWide` so columns are not split across pages
- **Excel Row/Column Headers** - Print headings and gridlines in COM-generated PDFs so A/B/C column labels and row numbers appear
- **PDF Conversion Cache + Refresh** - Converted PDFs are cached by file mtime; a "refresh" button re-converts on demand

### Document Text Extraction API
- **`POST /api/preview/extract`** - Extracts readable text from DRM-protected Office documents and PDFs (docx/doc, xlsx/xls, ppt/pptx, pdf) for downstream use by LLMs
- **Format-Aware Extraction** - PDF via pypdf, Word via COM text, Excel via tab-separated used-range, PowerPoint per-slide text frames; results cached under `%TEMP%`

### Document Editing API
- **`POST /api/preview/edit`** - Edits Office documents in place (docx/doc, xlsx/xls, ppt/pptx), preserving formatting
- **Edit Operations** - `replace` (all or nth occurrence), `insert_after`/`insert_before` a matched paragraph/cell, `append`/`prepend` text, and `delete` matched text
- **Format Backends** - OOXML files edited with python-docx / openpyxl / python-pptx (run-preserving text replacement); encrypted/legacy files fall back to desktop Office COM editing so DRM-protected documents remain editable
- **Mark-of-the-Web Handling** - The converter strips the `Zone.Identifier` alternate data stream before opening a file with Office COM, so files downloaded from the internet are not blocked in read-only Protected View when previewing/editing
- **Safe COM Automation** - Each conversion/extraction/edit spins up an isolated Office application (via `DispatchEx`) and always quits it, so the backend does not leave lingering Excel/Word/PowerPoint processes
- **File-Lock Requirement** - In-place editing needs the target file to not be open/locked in Office; a busy workbook returns a clear permission error until the owning app is closed

### MCP Document Tools
- **`doc-reader` MCP server** (FastMCP/stdio) - Registers `read_document(path)` and `edit_document(path, operations)` so the assistant can read and modify DRM-protected Office/PDF files in chat

### Remote Access
- **Relative API Base** - The frontend resolves `VITE_API_URL` as an empty default so the client always talks to the web server origin it was loaded from, enabling access from other PCs on the network

### OpenCode File Registration (Command Panel)
- **Register new opencode file** - The command panel dialog (`POST /api/registry`) writes opencode config files directly into the correct discovery locations, with a `Global` scope targeting the workspace config dir
- **Four file types** - Command (`command/<name>.md`), Skill (`skill/<name>/SKILL.md`), Plugin/tool (`plugin/<name>.ts`), and Agent (`agent/<name>.md`)
- **Agent registration** - New Agent tab with a mode selector (`all` / `subagent` / `primary`) and system-prompt textarea; frontmatter `description`/`mode` is generated automatically, matching opencode's agent discovery format
- **Workspace-scoped global config** - Global files are written to `workspace/.config/opencode/` (via `getConfigPath()`) instead of `~/.config/opencode`, so all app-managed config stays inside the git-ignored workspace; the OpenCode server is spawned with both `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` pointing at it
- **Plugin path fix** - Tools are saved under `plugin/` (opencode v1.18.11 discovery rule `{plugin,plugins}/*.{ts,js}`), not `tools/`
- **Robust scope detection** - `proxy.ts` resolves slash-command scope across both singular/plural directory spellings (`command`/`commands`, `skill`/`skills`) in the project `.opencode/` and the global config dir
- **Scrollable dialog** - The register dialog scrolls (`max-h-[90vh]`) so long plugin/agent content stays reachable on small screens

## Demo Videos

### Demo
![Demo](https://github.com/chriswritescode-dev/opencode-web/releases/download/0.3.0/Chat.gif)

### Demo Project
![Demo Project](demo.mp4)

**Demo Project**: A simple web-based demo project featuring:
- Web server accessible from mobile/desktop
- Schedule-based automatic task processing

### File Editing
![File Editing](https://github.com/chriswritescode-dev/opencode-web/releases/download/0.3.0/git-file-edit.gif)

### File Context
![File Context](https://github.com/chriswritescode-dev/opencode-web/releases/download/0.2.5/file-context.gif)

## Mobile Screenshots

<img width="250" alt="Mobile Repository List" src="https://github.com/user-attachments/assets/4a854373-9e4d-41ac-9a6c-c0eb37b0ac42" /> <img width="250" alt="Mobile Chat Interface" src="https://github.com/user-attachments/assets/57fe81c1-b169-43eb-b95f-6e027d7bea10" /> <img width="250" alt="Mobile OpenCode Configuration" src="https://github.com/user-attachments/assets/fcb16958-3134-434f-8c78-fb07259f5ce1" />

## Coming Soon

-  **Authentication** - User authentication and session management

## Installation

### Option 1: Docker (Recommended for Production)

```bash
# Clone the repository
git clone https://github.com/yourusername/opencode-webui.git
cd opencode-webui

# Start with Docker Compose (single container)
docker-compose up -d

# Access the application at http://localhost:5003
```

The Docker setup automatically:
- Installs OpenCode if not present
- Builds and serves frontend from backend
- Sets up persistent volumes for workspace and database
- Includes health checks and auto-restart

**Docker Commands:**
```bash
# Start container
docker-compose up -d

# Stop and remove container
docker-compose down

# Rebuild image
docker-compose build

# View logs
docker-compose logs -f

# Restart container
docker-compose restart

# Access container shell
docker exec -it opencode-web sh
```

### Option 2: Local Development

#### Prerequisites

| Tool     | Purpose                                        | Install (Windows) |
|----------|------------------------------------------------|-------------------|
| Node.js  | Runtime for the build tooling                  | [nodejs.org](https://nodejs.org) |
| Bun      | Backend runtime (`bun --watch`)                | `npm install -g bun` |
| pnpm     | Workspace package manager                      | `npm install -g pnpm` |
| OpenCode | The AI agent CLI (`opencode serve`)            | bundled — copied from `vendor/` (see below) |
| Git      | Repository cloning / worktrees                 | [git-scm.com](https://git-scm.com) |
| Git LFS  | Materializes the vendored binaries in `bin/`      | [git-lfs.com](https://git-lfs.com) |

> **OpenCode, agent-browser and Chromium are vendored under `bin/`** and tracked
> through Git LFS, so an air-gapped machine needs **no downloads**: a clone
> pulls the real binaries (`bin/opencode.exe`, `bin/agent-browser/…`) once Git
> LFS is installed. `vendor/` is an optional, **git-ignored offline fallback**:
> the installers check it first and copy your files from there (no download),
> and only fall back to a download when `vendor/` is empty. After cloning, run
> `git lfs install` once so the binary files are checked out:
>
> ```
> git lfs install
> ```
>
> The backend **auto-detects `<project>/bin/opencode.exe`, `<workspace>/bin/opencode.exe`,
> the npm-global copy (`%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe`),
> `~/.bun/bin`, `~/.opencode/bin`, and the PATH**, launching whichever it finds for
> `opencode serve`. Only one is required.
>
> **Current bundled version:** `bin/opencode.exe` is **v1.18.18**. Check the
> installed one anytime with:
> ```
> bin\opencode.exe --version
> ```
> The automation watcher requires **opencode ≥ 1.18** (per-directory instance
> reload via `POST /instance/dispose` — see `docs/architecture.md`). If you
> vendor a newer binary, update the version string above.
>
> **Manual placement (alternative):** drop any `opencode.exe` into the project's
> `bin/` folder:
> ```
> opencode-webui\
>   bin\
>     opencode.exe
> ```
> Get it from the [opencode releases page](https://github.com/sst/opencode/releases)
> (`opencode-windows-x64.zip`). No runtime internet access is needed — the server
> is just a single local executable.
>
> **Automated download (no `vendor/` files):** `npm run opencode:install`
> downloads the matching binary into `bin/` automatically. On networks behind a
> TLS-intercepting proxy, run it once with `OPENCODE_INSECURE=1`:
> ```powershell
> $env:OPENCODE_INSECURE="1"; npm run opencode:install
> ```
> or pin a version with `OPENCODE_VERSION=<x.y.z>`. Alternatively set the backend
> env `OPENCODE_BIN` to the full path of any `opencode(.exe)` you already have.
>
> The dev workflow uses `.cmd` shims automatically, so a strict PowerShell
> execution policy that blocks `.ps1` wrappers is not an issue.

```bash
# Clone the repository
git clone https://github.com/yourusername/opencode-webui.git
cd opencode-webui

# Pull the vendored binaries (opencode/agent-browser/chromium) from Git LFS
git lfs install && git lfs pull

# Install dependencies (pnpm workspaces)
pnpm install

# Copy environment configuration
cp .env.example .env

# Start development servers (backend + frontend)
npm run dev
```

`npm run dev` runs a `predev` step that automatically checks that **Bun, pnpm,
OpenCode and Git** are installed, creates the `workspace/` directory, installs
dependencies with `pnpm`, copies the vendored **opencode, agent-browser and
Chromium** from `vendor/` into `bin/` when present (no download), and sets up
`.env` if missing. The setup is
**OS-aware**: it uses `scripts/setup-dev.bat` (cmd) on Windows and
`scripts/setup-dev.sh` on macOS/Linux.

> **Domain guide (AGENTS.md):** the setup also checks that the assistant's
> domain guide is present. `docs/agent-domain-guide.md` is installed in two
> places (when missing):
> - `workspace/AGENTS.md` — project rules for sessions opened in `workspace/`.
> - `workspace/.config/opencode/AGENTS.md` — **global rules file** that applies
>   to every session, including repos cloned under `workspace/repos/` (project
>   rules stop at the git worktree root, so the global copy is what actually
>   reaches repo sessions).
>
> The guide defines the business concepts the assistant works with — 업무(project)
> = 하나의 담당자(agent)가 전담, command = 작업 시작 명령어, skill = 업무
> 스텝 — and the agent approval types (일반 대화 / 슈퍼 배치 / 알림). Delete the
> file(s) to re-run this install step, or edit them directly to tune your
> assistant.

#### (Optional) Register the Document MCP tools

The `doc-reader` MCP server (`read_document` / `edit_document`) lets the
assistant read and edit Office/PDF files (including DRM-protected ones) in
chat. The backend registers the server automatically at startup: every time the
server boots, `syncDefaultConfigToDisk()` merges it into the git-ignored
workspace config (`workspace/.config/opencode/opencode.json`) if it is not
already there. To use these tools in chat:

1. **Requirements** — the dev Python env must have the conversion libs and
   `fastmcp`. The dev setup scripts (`setup-dev.bat` / `setup-dev.sh` /
   `docker-entrypoint.sh`) install them automatically from
   `backend/requirements.txt`. To install by hand:
   ```bash
   pip install -r backend/requirements.txt
   ```
   (your copy of `opencode-webui` uses the same machine/`python` to run
   `backend/scripts/doc_converter.py`.)

2. **Server registration is automatic** — the backend merges `doc-reader` into
   `workspace/.config/opencode/opencode.json` at every startup, so a fresh clone
   gets it on the first boot. To register manually instead — via the Web UI
   **Settings → MCP Servers → Add Local Server**, or by appending to
   `workspace/.config/opencode/opencode.json`:
   ```json
   "mcp": {
     "doc-reader": {
       "type": "local",
       "command": [
         "python",
         "D:\\path\\to\\opencode_web\\backend\\scripts\\doc_reader_mcp.py"
],
        "env": {
          "OPCODE_WEBUI_BACKEND": "http://127.0.0.1:5002",
          "OPCODE_WEBUI_WORKSPACE": "D:\\path\\to\\opencode_web\\workspace"
       }
     }
   }
   ```
   Point `command[1]` and `OPCODE_WEBUI_WORKSPACE` at **your** checkout (the
   values above are machine-specific). After saving, the OpenCode server
   restarts and `read_document`/`edit_document` become available in chat.

   > Registration lives in the git-ignored workspace database, so a fresh clone
   > gets it automatically on the first backend boot. A
   > ready-made snippet is also tracked in the repo at
   > `config-templates/opencode.mcp.doc-reader.json` for manual merges.

3. **Verify** — the OpenCode server exposes the tools only after registration.
   In the UI you can confirm the new tools appear for `/mcp` (`doc-reader` shows
   `connected`).

> Once registered, the assistant reads documents with
> `read_document("D:\\...\\file.docx")` and edits them in place with
> `edit_document(path, [operations])` (replace / insert_after / insert_before /
> append / prepend / delete).

#### (Optional) Register the Browser Automation MCP tools

The `agent-browser` MCP server exposes `agent_browser_*` tools (open, snapshot,
click, fill, type, screenshot, …) so the assistant can drive a real browser in
chat. Unlike `doc-reader`, agent-browser is a self-contained native binary plus
a Chromium build, both vendored by this repo so **no separate download or global
install is required**:

- `npm run agent-browser:install` — downloads the `agent-browser` release binary
  (from the npm package) and a matching Chromium (Chrome for Testing) into the
  git-ignored `bin/agent-browser/`, then records their paths in `.meta.json`.
- `npm run agent-browser:update` — re-runs the install with `--force` to fetch
  the latest releases (a dedicated update command).
- The dev setup scripts (`setup-dev.bat` / `setup-dev.sh` / `docker-entrypoint.sh`)
  call the installer automatically (idempotent — skips when already installed).
  MCP registration itself needs no separate step: the backend merges the
  `agent-browser` entry into the git-ignored workspace config
  (`workspace/.config/opencode/opencode.json`) at startup using the vendored
  binary (`mergeDefaultMcpEntries` → `syncDefaultConfigToDisk`).

The entry pins the namespace and a 24h idle timeout so the MCP server talks to
the same daemon the backend pre-warms (see below). Note that opencode **does not
forward the `env` field** to the spawned MCP child — the env values below are
informational and the session is always resolved as `default`; the `--namespace`
flag is what actually matters:

```json
"mcp": {
  "agent-browser": {
    "type": "local",
    "command": [
      "D:\\path\\to\\opencode_web\\bin\\agent-browser\\bin\\agent-browser.exe",
      "mcp",
      "--namespace",
      "opencode"
    ],
    "env": {
      "AGENT_BROWSER_EXECUTABLE_PATH": "D:\\path\\to\\opencode_web\\bin\\agent-browser\\chromium\\chrome-win64\\chrome.exe",
      "AGENT_BROWSER_NAMESPACE": "opencode",
      "AGENT_BROWSER_SESSION": "opencode",
      "AGENT_BROWSER_IDLE_TIMEOUT_MS": "86400000"
    }
  }
}
```

`AGENT_BROWSER_NAMESPACE=opencode` must match the `--namespace opencode` flag —
the MCP server and the daemon only talk to each other when both use the same
namespace. `AGENT_BROWSER_IDLE_TIMEOUT_MS=86400000` (24h) stops the daemon from
being evicted between tool calls.

> **Browser sessions are a singleton:** opencode strips the MCP entry's `env`
> field when spawning the local MCP, and agent-browser ignores
> `--session`/`--executable-path` in MCP mode — so every session resolves to the
> same `default` session in the `opencode` namespace. All repos and the global
> session therefore share ONE daemon and ONE Chrome tree
> (`writeRepoOpenCodeConfig()` still writes a per-repo `opencode.json`, but the
> session it carries is not honored by opencode). An existing `enabled: false`
> on the agent-browser entry is preserved so a repo can opt out of the MCP. See
> [`docs/architecture.md`](docs/architecture.md).

> **Daemon warm-up (why the first `agent_browser_open` no longer hangs):**
> the agent-browser MCP server talks to a long-lived background daemon over a
> local socket. On a cold start the daemon inherits the MCP server's stdout
> pipe, so the MCP server never sees EOF and a `tools/call` waits ~60s then
> times out (`MCP error -32001: Request timed out`). The backend pre-warms the
> daemon so the first tool call is fast:
> - `backend/src/services/default-mcp.ts` → `warmUpAgentBrowserDaemon()` spawns
>   `agent-browser.exe mcp --namespace opencode` with all `AGENT_BROWSER_*` env
>   vars stripped — identical to how opencode itself spawns the MCP — and
>   performs a real JSON-RPC `agent_browser_open about:blank` to force the
>   browser launch, then kills the MCP client (the background daemon survives).
>   `backend/src/index.ts` runs this after the opencode server starts and every
>   60s (self-heals a dead daemon), skipping when `agent-browser session info`
>   already reports an active browser.
> - Warming the daemon with `open --headed false` or `AGENT_BROWSER_IDLE_TIMEOUT_MS`
>   produces a different daemon profile, so the MCP restarts it on first use
>   (~45s) — do not do that.
> - `mergeDefaultMcpEntries` also **repairs env vars** (namespace + idle
>   timeout) on sync, so a config regenerated from the DB keeps them even if a
>   previous version was missing them.

Options:

- Pin a specific agent-browser release with `AGENT_BROWSER_VERSION=x.y.z` before
  running the installer.
- Corporate/proxy networks that intercept TLS: run with
  `AGENT_BROWSER_INSECURE=1` (one-time trust for the download).
- Unsupported platforms are detected and reported before anything is downloaded.

Verify in the UI: the OpenCode server exposes the `agent_browser_*` tools after
registration (`/mcp` shows `agent-browser` as `connected`).

#### Offline installs (no internet)

The installers check the git-tracked `vendor/` folder **first** and copy your
files (no download); they only download when `vendor/` is empty. To make the
repo work on an air-gapped machine, put the binaries there and commit them:

- `vendor/opencode/` — the opencode CLI archive or binary.
- `vendor/agent-browser/` — the platform `agent-browser` binary.
- `vendor/chromium/` — a `chrome-<platform>.zip` or the extracted Chromium.

Prepare on a connected machine with
`node scripts/install-opencode.js` + `node scripts/install-agent-browser.js`,
then copy `bin/` results back into `vendor/`. Full layout and per-platform file
names are in `vendor/README.md`.

## Architecture

### Tech Stack

**Frontend** (React 19 + Vite 7)
- React Query (TanStack Query) for server state
- Radix UI + Tailwind CSS for components
- React Hook Form + Zod for forms
- TypeScript strict mode

**Backend** (Bun + Hono)
- SQLite database (better-sqlite3)
- OpenCode server proxy (`/api/opencode/*`)
- SSE event streaming proxy (`/api/opencode/event`, `/api/opencode/global/event`)
- File upload/download endpoints

**OpenCode Server** (separate process, port 5552)
- Provides AI agent execution via REST API + SSE
- Manages sessions, messages, permissions, MCP servers
- Spawned with `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` pointing at
  `workspace/.config/opencode` so all app-managed config stays in the workspace

### Workspace Configuration & Rules

Everything the app manages lives under the workspace root (`./workspace`, or
`WORKSPACE_PATH`). The config dir is
`workspace/.config/opencode/` — `getConfigPath()` derives it from the workspace
path, it is *not* the user's `~/.config/opencode`. The OpenCode server is
launched with `OPENCODE_CONFIG_DIR` set to that dir, and the domain guide is
installed there as a **global rules file** (`AGENTS.md`) so it applies to every
session, including repos under `workspace/repos/` (project rules stop at the
git worktree root). The register dialog writes commands, skills, plugins
(`plugin/`) and agents (`agent/`) into it. See
[`docs/architecture.md`](docs/architecture.md) for details.

### Data Flow

```
Browser (React) → Backend (Hono, :5002) → OpenCode Server (Bun, :5552)
     ↑                  ↑                        ↑
  SSE client        SSE proxy              SSE source
  React Query       REST proxy             REST API
```

### Key Components

**Frontend**
- `useOpenCode` hooks - React Query wrappers for all API calls
- `useSSE` - Global SSE connection for real-time events (messages, permissions, session lifecycle)
- `useSessionActivity` - Tracks per-session "Working" state from SSE events
- `usePermissionRequests` - Global permission request polling + store
- `ModelSelectDialog` - Switches session model via `POST /api/session/{id}/model`

**Backend**
- `proxy.ts` - Forwards `/api/opencode/*` to OpenCode server, enriches `/command` with scope
- `registry.ts` - Resolves scope/target paths and writes opencode files (command/skill/plugin/agent)
- `scheduler.ts` - Runs scheduled prompts, creates sessions, sends prompts in background
- `opencode-single-server.ts` - Manages OpenCode server process lifecycle, injects config env

### Session Model Switching

The OpenCode server (v1.18.11) does not support `POST /session/{id}/command {command: "model"}`. Instead, use:

```
POST /api/session/{id}/model
Content-Type: application/json

{ "model": { "id": "deepseek-v4-flash-free", "providerID": "opencode" } }
```

Returns `204 No Content`. The frontend calls this via `OpenCodeClient.switchModel()` and invalidates the session/sessions queries to refresh the UI.

### Slash Commands

Only commands that exist on the OpenCode server are sent via `POST /session/{id}/command`:
- Built-in: `init`, `review`
- MCP prompts (dynamically registered)
- Skills (from `~/.config/opencode/skills/` and project `.opencode/skills/`)

UI-only commands (`models`, `themes`, `new`, `clear`, `help`, `sessions`, `resume`, `continue`, `share`, `unshare`, `export`, `compact`, `summarize`, `undo`, `redo`, `details`, `editor`) are handled client-side with toasts or dialogs.

### Session Activity Tracking

The `useSessionActivity` hook maintains a global store of active sessions:
- `active` → emitted on `part.updated` or `message.updated` (assistant role)
- `completing` → emitted when assistant message has `time.completed` (3s grace period)
- `idle` → emitted on `session.idle`, `session.error`
- `remove` → emitted on `session.deleted`
Components use `useActiveSessions()` (Record<sessionId, boolean>) and `useSessionActive(sessionId)` for
badges.

---

## Uninstall

### Remove a project install

Stop the dev servers (Ctrl+C), then clean the generated project artifacts:

```bash
# Delete runtime/generated data (repos, opencode config, sqlite database)
rm -rf workspace data .env

# Remove installed dependencies
rm -rf node_modules backend/node_modules frontend/node_modules shared/node_modules

# Reinstall from scratch later with:
#   pnpm install && cp .env.example .env && npm run dev
```

On Windows (cmd):

```bat
rmdir /s /q workspace data
del .env
rmdir /s /q node_modules backend\node_modules frontend\node_modules shared\node_modules
```

### Remove global prerequisites (optional)

Only removes the globally-installed tools this project uses. Node.js/Git must be
uninstalled separately via your Windows Settings or package manager if desired.

```bash
npm uninstall -g opencode-ai pnpm bun
```

> The OpenCode config that this app registers lives in the workspace
> (`workspace/.config/opencode/opencode.json`), not in your user profile, so the
> global tools can be added/removed freely without affecting app settings.

### Reinstall

The fastest way back is to just launch it again — the `predev` step recreates
`workspace/` and `.env` and installs deps automatically:

```bash
npm run dev
```

To start completely clean: follow **Remove local project install** above, then
re-clone (optional) and run `npm run dev` again.


