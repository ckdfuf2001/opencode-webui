---
name: agent-browser
description: Browser automation via stock agent-browser native MCP. Pass namespace opencode and your own session name on every call. Never use session "default".
---

# Agent-Browser Skill (native MCP)

Backend registers the stock `agent-browser mcp` (`--namespace opencode`).
One browser per session; sessions are isolated by name.

## Sessions (mandatory)

- Every task needs its own session. Pass `namespace: "opencode"` and
  `session: "<task-name>"` (Korean ok) on EVERY call.
  Reuse the SAME session for every follow-up call in the task.
- NEVER use `session: "default"` (tab/ref collisions).
- End with `agent_browser_close` when done. Idle sessions auto-close.

## Warmup

- Backend pre-warms after opencode start (`warmUpAgentBrowserDaemon()` in
  `backend/src/services/default-mcp.ts`).
- First `open` on a cold session can take a while; retry once on failure.

## Troubleshooting

- `MCP error -32001: Request timed out` -> browser still launching; retry in
  a few seconds. Status: `GET /api/mcp/agent-browser/status`,
  diagnose: `GET /api/mcp/agent-browser/diagnose`,
  manual warm: `POST /api/mcp/agent-browser/warm`.
- Session acting stale (old errors repeat) -> `agent_browser_close` it and use
  a fresh session name.

## Closing

- Always `agent_browser_close` when the task is done.
  Explicit close frees the browser context immediately instead of waiting for TTL.
