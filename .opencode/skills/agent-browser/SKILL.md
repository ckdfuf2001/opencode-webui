---
name: agent-browser
description: Browser automation via agent-browser session-proxy MCP. Always ensure a session first and reuse it. Never use session "default".
---

# Agent-Browser Skill (session-proxy)

Backend serves `agent-browser` MCP through `backend/scripts/agent-browser-proxy/mcp-server.mjs`
(vendored from `ckdfuf2001/agent-browser`, release `proxy-v2.2.0`).
One shared daemon (namespace `opencode`), one browser per session.

## Sessions (mandatory)

- Every task needs its own session. First call: `agent_browser_session_ensure`
  with `namespace: "opencode"` and `session: "<task-name>"` (Korean ok).
  Reuse the SAME session for every follow-up call in the task.
- NEVER use `session: "default"` — the proxy rejects it (tab/ref collisions).
- If `ensure` reports EXISTS with open tabs: adopt with `reuse: true` only if it
  is YOUR browser, otherwise pick a different name.
- End with `agent_browser_close` when done. Idle sessions auto-close after 10 min
  (`SESSION_TTL_MS`), daemon after 15 min idle.

## Warmup

- Backend pre-warms the `opencode` daemon after opencode start + every 60s
  (`warmUpAgentBrowserDaemon()` in `backend/src/services/default-mcp.ts`).
- First `open` on a cold daemon can take ~35s; the proxy absorbs it.

## Troubleshooting

- `Unknown pair ... Call agent_browser_session_ensure FIRST` -> ensure the session first.
- `Missing session` / default rejected -> mint a name via `agent_browser_session_ensure`.
- `MCP error -32001: Request timed out` -> daemon cold or died; backend re-warms
  in the background, retry in a few seconds. Status: `GET /api/mcp/agent-browser/status`,
  manual warm: `POST /api/mcp/agent-browser/warm`.
- `Single-daemon proxy: namespace is pinned` -> always use `namespace: "opencode"`.

## Closing

- Always `agent_browser_close` (or `close --all`) when the task is done.
  Explicit close frees the browser context immediately instead of waiting for TTL.
