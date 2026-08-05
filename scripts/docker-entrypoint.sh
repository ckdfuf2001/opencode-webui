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

exec "$@"
