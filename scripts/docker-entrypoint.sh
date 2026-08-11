#!/bin/bash
set -e

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$HOME/.opencode/bin:$HOME/.local/bin:$PATH"

echo "🔍 Checking Bun installation..."

if ! command -v bun >/dev/null 2>&1; then
  echo "❌ Bun not found. Installing..."
  curl -fsSL https://bun.sh/install | bash
  
  if ! command -v bun >/dev/null 2>&1; then
    echo "❌ Failed to install Bun. Exiting."
    exit 1
  fi
  
  echo "✅ Bun installed successfully"
else
  BUN_VERSION=$(bun --version 2>&1 || echo "unknown")
  echo "✅ Bun is installed (version: $BUN_VERSION)"
fi

echo "🔍 Checking OpenCode installation..."

if ! command -v opencode >/dev/null 2>&1; then
  echo "⚠️  OpenCode not found in PATH"
else
  OPENCODE_VERSION=$(opencode --version 2>&1 || echo "unknown")
  echo "✅ OpenCode is installed (version: $OPENCODE_VERSION)"
fi

echo "🚀 Starting OpenCode WebUI Backend..."

# Place the domain guide into the workspace if missing
if [ -n "$WORKSPACE_PATH" ]; then
  mkdir -p "$WORKSPACE_PATH"
  if [ -f "/app/docs/agent-domain-guide.md" ] && [ ! -f "$WORKSPACE_PATH/AGENTS.md" ]; then
    cp /app/docs/agent-domain-guide.md "$WORKSPACE_PATH/AGENTS.md"
    echo "✅ Installed workspace AGENTS.md (domain guide)"
  else
    echo "✅ workspace AGENTS.md already present"
  fi
fi

# Install the agent-browser binary (MCP config is handled by the backend at startup)
if [ -f "/app/scripts/install-agent-browser.js" ]; then
  echo "  [+] Installing agent-browser (binary + Chromium)..."
  node /app/scripts/install-agent-browser.js || echo "  [.] agent-browser install skipped"
fi

# Place the domain guide as a global rules file (applies to every session)
if [ -n "$WORKSPACE_PATH" ]; then
  mkdir -p "$WORKSPACE_PATH/.config/opencode"
  if [ -f "/app/docs/agent-domain-guide.md" ] && [ ! -f "$WORKSPACE_PATH/.config/opencode/AGENTS.md" ]; then
    cp /app/docs/agent-domain-guide.md "$WORKSPACE_PATH/.config/opencode/AGENTS.md"
    echo "✅ Installed global rules AGENTS.md (domain guide)"
  else
    echo "✅ global rules AGENTS.md already present"
  fi
fi

# Install the Python document conversion dependencies
if [ -f "/app/backend/requirements.txt" ]; then
  echo "  [+] Installing Python conversion dependencies..."
  pip install -r /app/backend/requirements.txt || echo "  [.] pip install skipped/failed (document preview/MCP unavailable)"
fi

exec "$@"
