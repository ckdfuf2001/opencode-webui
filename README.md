This repository is clone of threehymns/opencode-webui. not related with opencode.
Some architecture are changed. (later upload with md file)

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

### Chat & Session Features
- **Slash Commands** - Built-in commands (`/help`, `/new`, `/models`, `/export`, `/compact`, etc.)
- **Custom Commands** - Create custom slash commands with templates
- **File Mentions** - Reference files with `@filename` autocomplete
- **Plan/Build Mode Toggle** - Switch between read-only and file-change modes
- **Session Management** - Create, search, delete, and bulk delete sessions
- **Real-time Streaming** - Live message streaming with SSE

### AI Model & Provider Configuration
- **Model Selection** - Browse and select from available AI models with filtering
- **Provider Management** - Configure multiple AI providers with API keys
- **Context Usage Indicator** - Visual progress bar showing token usage
- **Agent Configuration** - Create custom agents with system prompts and tool permissions

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

## Demo Videos

### Demo
![Demo](https://github.com/chriswritescode-dev/opencode-web/releases/download/0.3.0/Chat.gif)

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

# Access the application at http://localhost:5001
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
| OpenCode | The AI agent CLI (`opencode serve`)            | drop `opencode.exe` into `bin/` (see below) |
| Git      | Repository cloning / worktrees                 | [git-scm.com](https://git-scm.com) |

> **OpenCode on Windows (offline-friendly, recommended):** the simplest way is to
> drop the standalone `opencode.exe` into the project's `bin/` folder:
>
> ```
> opencode-webui\
>   bin\
>     opencode.exe
> ```
>
> The backend **auto-detects `<project>/bin/opencode.exe`, `<workspace>/bin/opencode.exe`,
> the npm-global copy (`%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe`),
> `~/.bun/bin`, `~/.opencode/bin`, and the PATH**, launching whichever it finds for
> `opencode serve`. Only one is required.
>
> Get the binary from the [opencode releases page](https://github.com/sst/opencode/releases)
> (`opencode-windows-x64.zip`) and extract `opencode.exe` into `bin\`. No runtime
> internet access is needed — the server is just a single local executable.
>
> **Automated download:** `npm run opencode:install` downloads the matching binary
> into `bin/` automatically. On networks behind a TLS-intercepting proxy, run it
> once with `OPENCODE_INSECURE=1`:
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

# Install dependencies (pnpm workspaces)
pnpm install

# Copy environment configuration
cp .env.example .env

# Start development servers (backend + frontend)
npm run dev
```

`npm run dev` runs a `predev` step that automatically checks that **Bun, pnpm,
OpenCode and Git** are installed, creates the `workspace/` directory, installs
dependencies with `pnpm`, and sets up `.env` if missing. The setup is
**OS-aware**: it uses `scripts/setup-dev.bat` (cmd) on Windows and
`scripts/setup-dev.sh` on macOS/Linux.

#### (Optional) Register the Document MCP tools

The `doc-reader` MCP server (`read_document` / `edit_document`) lets the
assistant read and edit Office/PDF files (including DRM-protected ones) in
chat. **It is installed with the repo but not registered automatically** —
registration lives in the git-ignored workspace database
(`workspace/.config/opencode/opencode.json`), so a fresh clone must register it
once. To use these tools in chat:

1. **Requirements** — the dev Python env must have the conversion libs and
   `fastmcp`:
   ```bash
   pip install python-docx openpyxl python-pptx fastmcp pypdf pywin32
   ```
   (your copy of `opencode-webui` uses the same machine/`python` to run
   `backend/scripts/doc_converter.py`.)

2. **Register the server** — via the Web UI **Settings → MCP Servers → Add
   Local Server**, or by appending to `workspace/.config/opencode/opencode.json`:
   ```json
   "mcp": {
     "doc-reader": {
       "type": "local",
       "command": [
         "python",
         "D:\\path\\to\\opencode_web\\backend\\scripts\\doc_reader_mcp.py"
       ],
       "env": {
         "OPCODE_WEBUI_BACKEND": "http://127.0.0.1:5001",
         "OPCODE_WEBUI_WORKSPACE": "D:\\path\\to\\opencode_web\\workspace"
       }
     }
   }
   ```
   Point `command[1]` and `OPCODE_WEBUI_WORKSPACE` at **your** checkout (the
   values above are machine-specific). After saving, the OpenCode server
   restarts and `read_document`/`edit_document` become available in chat.

3. **Verify** — the OpenCode server exposes the tools only after registration.
   In the UI you can confirm the new tools appear for `/mcp` (`doc-reader` shows
   `connected`).

> Once registered, the assistant reads documents with
> `read_document("D:\\...\\file.docx")` and edits them in place with
> `edit_document(path, [operations])` (replace / insert_after / insert_before /
> append / prepend / delete).

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


