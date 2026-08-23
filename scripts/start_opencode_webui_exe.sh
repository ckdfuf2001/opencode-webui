#!/usr/bin/env bash
# opencode-webui portable launcher: prerequisite checks + background start
set -u
cd "$(dirname "$0")"

# .env 가 없으면 기본값으로 생성 (PORT / HOST / NODE_ENV)
if [ ! -f .env ]; then
  printf 'PORT=5002\nHOST=0.0.0.0\nNODE_ENV=production\n' > .env
  printf '%s\n' "[START] created default .env"
fi

PORT="${PORT:-5002}"

# .env 키 로드 (이미 환경변수로 설정된 값은 유지)
if [ -f .env ]; then
  while IFS='=' read -r key value; do
    case "$key" in ''|\#*) continue ;; esac
    value="${value%\"}"; value="${value#\"}"
    case "$key" in
      PORT) [ -n "${PORT:-}" ] || PORT="$value" ;;
      HOST) [ -n "${HOST:-}" ] || export HOST="$value" ;;
      OPENCODE_SERVER_PORT) [ -n "${OPENCODE_SERVER_PORT:-}" ] || export OPENCODE_SERVER_PORT="$value" ;;
    esac
  done < .env
fi

LOG_DIR="logs"
LOG="$LOG_DIR/webui.log"
mkdir -p "$LOG_DIR"

say()  { printf '%s\n' "[START] $*"; }
fail() { say "ERROR: $*"; exit 1; }
warn() { say "WARN: $*"; }

BIN=./opencode-webui.exe
[ -f "$BIN" ] || BIN=./opencode-webui
[ -f "$BIN" ] || fail "opencode-webui executable not found in $(pwd)"

say "checking prerequisites..."
if [ -f ./bin/opencode.exe ] || [ -f ./bin/opencode ]; then
  say "ok: opencode binary"
else
  warn "bin/opencode missing — AI sessions unavailable (will also probe PATH at runtime)"
fi
if [ -d ./bin/agent-browser ]; then
  say "ok: agent-browser"
else
  warn "bin/agent-browser missing — browser automation MCP disabled"
fi
if [ -f ./scripts/doc-reader.exe ]; then
  say "ok: doc-reader.exe"
elif command -v python >/dev/null 2>&1; then
  say "ok: doc-reader via python fallback"
else
  warn "doc-reader.exe missing and python not found — doc-reader MCP cannot start"
fi
if command -v git >/dev/null 2>&1; then
  say "ok: git ($(git --version 2>/dev/null))"
else
  warn "git not found — clone/pull/branch features unavailable"
fi

if command -v curl >/dev/null 2>&1 && curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  say "already running on port $PORT — nothing to do"
  exit 0
fi

export NODE_ENV=production
say "launching $BIN on port $PORT (log: $LOG)"
nohup "$BIN" >>"$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 30); do
  sleep 1
  if command -v curl >/dev/null 2>&1 && curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    say "healthy → http://127.0.0.1:$PORT (pid $PID)"
    exit 0
  fi
done

say "launched (pid $PID) — health not confirmed yet; check $LOG"
