#!/usr/bin/env bash
# clear opencode-webui portable runtime state (logs, data, config cache)
# pass "all" to also wipe workspace/ (repos included!)
cd "$(dirname "$0")"

bash "$(dirname "$0")/stop_opencode_webui_exe.sh"

if [ "${1:-}" = "all" ]; then
  echo "[CLEAR] removing workspace ENTIRELY - repos and unpushed work will be LOST!"
  rm -rf workspace
else
  echo "[CLEAR] removing runtime state: logs, data, config cache..."
  rm -rf logs data workspace/.config
  echo "[CLEAR] workspace/repos preserved. Use 'clear all' to wipe repos too."
fi
echo "[CLEAR] done."
