#!/bin/sh
set -e

echo "=========================================="
echo "  OpenCode Writer UI - Dev Environment Setup"
echo "=========================================="
echo

echo "[1/5] Checking prerequisites..."

# Bun
if command -v bun >/dev/null 2>&1; then
  echo "  [+] Bun is installed"
else
  echo "  [x] Bun is NOT installed. Install it from: https://bun.sh"
  exit 1
fi

# pnpm
if command -v pnpm >/dev/null 2>&1; then
  echo "  [+] pnpm is installed"
else
  echo "  [x] pnpm is NOT installed. Install it with: npm install -g pnpm"
  exit 1
fi

# OpenCode (optional; start without a connection if not installed)
if command -v opencode >/dev/null 2>&1; then
  echo "  [+] OpenCode is installed"
else
  echo "  [.] OpenCode TUI is NOT installed - starting without an OpenCode connection."
  echo "      Set the binary path later under Settings -> OpenCode, then restart the server."
fi

# Git
if command -v git >/dev/null 2>&1; then
  echo "  [+] Git is installed"
else
  echo "  [x] Git is NOT installed. Install it from: https://git-scm.com"
  exit 1
fi

WORKSPACE_PATH="./workspace"

echo
echo "[2/5] Creating workspace directories..."
mkdir -p "$WORKSPACE_PATH/repos"
mkdir -p "$WORKSPACE_PATH/.config/opencode"

# Install the domain guide (AGENTS.md) into the workspace if missing
if [ -f "docs/agent-domain-guide.md" ] && [ ! -f "$WORKSPACE_PATH/AGENTS.md" ]; then
  cp docs/agent-domain-guide.md "$WORKSPACE_PATH/AGENTS.md"
  echo "  [+] Installed domain guide (docs/agent-domain-guide.md) as workspace/AGENTS.md"
else
  if [ -f "$WORKSPACE_PATH/AGENTS.md" ]; then
    echo "  [+] workspace/AGENTS.md already present"
  fi
fi

# Install the domain guide as a global rules file (applies to every session)
if [ -f "docs/agent-domain-guide.md" ] && [ ! -f "$WORKSPACE_PATH/.config/opencode/AGENTS.md" ]; then
  cp docs/agent-domain-guide.md "$WORKSPACE_PATH/.config/opencode/AGENTS.md"
  echo "  [+] Installed domain guide as global rules (workspace/.config/opencode/AGENTS.md)"
else
  if [ -f "$WORKSPACE_PATH/.config/opencode/AGENTS.md" ]; then
    echo "  [+] workspace/.config/opencode/AGENTS.md already present"
  fi
fi

echo
echo "[3/5] Installing dependencies (pnpm install)..."
pnpm install

echo
echo "[4/5] Creating environment file if missing..."
if [ ! -f ".env" ]; then
  cp .env.example .env
  echo "  [+] Created .env from .env.example"
else
  echo "  [+] .env already exists"
fi

echo
echo "[5/5] Verifying bun..."
bun --version >/dev/null 2>&1

echo
echo "Registering default MCP servers..."
node scripts/install-agent-browser.js || echo "  [.] agent-browser setup skipped - run: npm run agent-browser:install"
node scripts/register-default-mcp.js

echo
echo "=========================================="
echo "  Dev environment ready!"
echo "=========================================="
echo
echo "Available commands:"
echo "  npm run dev              Start both backend and frontend"
echo "  npm run dev:backend      Start backend only"
echo "  npm run dev:frontend     Start frontend only"
echo