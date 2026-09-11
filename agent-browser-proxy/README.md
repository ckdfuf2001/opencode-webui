# agent-browser-proxy (optional module, 0.7.0+)

Session-isolation MCP proxy in front of the stock `agent-browser` native MCP.
Concurrent-session safe: every tool call runs `agent-browser --namespace NS
--session S ...` as a short-lived CLI subprocess, so different sessions drive
different browsers and never steal each other's tabs/refs. Small tool surface,
stateless per call, sweeper + LRU close idle sessions only.

Restored from the pre-removal revision (proxy-v2.2.0 + 2.3.0 daemon-supervision
fixes). No external dependencies — just `node mcp-server.mjs`.

## Status: OFF by default (stock direct is active)

Nothing changes unless you opt in. The stock native MCP path is untouched.

## Enable

```powershell
$env:AGENT_BROWSER_SESSION_PROXY = "1"
```

(or set `AGENT_BROWSER_SESSION_PROXY=1` in `.env` / service env) and restart the
backend. The backend then registers the MCP entry as
`node agent-browser-proxy/mcp-server.mjs --cli <agent-browser.exe> --namespace opencode`
instead of the binary-direct command. Revert to stock by unsetting the flag.

> Do NOT use `AGENT_BROWSER_PROXY` as the flag name: that is agent-browser's
> own proxy-server URL variable, and a value like `1` routes all of Chrome's
> traffic through proxy "1" (`ERR_PROXY_CONNECTION_FAILED`).

Optional tuning (defaults shown):

```powershell
$env:SESSION_TTL_MS = "600000"    # idle close after 10m
$env:SESSION_MAX = "16"           # registry cap (idle only)
$env:SESSION_SWEEP_MS = "60000"   # sweeper interval
```

Advanced: `AGENT_BROWSER_PROXY_MJS` overrides the proxy script path.

## Wiring (all marked BEGIN/END agent-browser-proxy)

1. `backend/src/services/agent-browser-proxy.ts` — the only integration file:
   flag check, mjs resolution, command builder, proxy env.
2. `backend/src/services/default-mcp.ts` — one block in `buildAgentBrowserMcp`
   (proxy entry first) + one block in `agentBrowserEnv` (SESSION_* passthrough).
   Warmup intentionally stays on the direct path: it wakes the same shared
   daemon the proxy's CLI subprocesses use.
3. `scripts/package-portable.ps1` — one block copying this folder into portable.
4. `.env.example` — one commented flag line.

## Removal (complete, no leftovers)

1. Delete this folder (`agent-browser-proxy/`).
2. Revert the marked blocks in `default-mcp.ts`, `package-portable.ps1`,
   `.env.example` (search `agent-browser-proxy`).
3. Delete `backend/src/services/agent-browser-proxy.ts` and
   `backend/test/services/agent-browser-proxy.test.ts`.

With the flag unset (default) the backend behaves exactly like stock 0.6.x
even if this folder is present.

## Hard constraint

This module MUST NEVER write to `bin/agent-browser/agent-browser.exe` or
`bin/agent-browser/.meta.json`. It only reads the binary path (resolved by
the backend from the meta file) and spawns it with `--cli`. The installer
(`scripts/install-agent-browser.js`) and registration
(`scripts/register-default-mcp.js`) are outside this module and unchanged.
