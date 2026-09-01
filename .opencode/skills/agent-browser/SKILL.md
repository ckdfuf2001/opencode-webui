---
name: agent-browser
description: Browser automation via agent-browser MCP. Use when opening pages, taking snapshots, clicking, filling, reading page text, or debugging blank read. Always pass session or enable AGENT_BROWSER_AUTO_SESSION.
---

# Agent-Browser Skill

## Sessions

- **Default is singleton:** agent_browser_* without session goes to opencode:default - first read returns blank.
- **Fix 1 - explicit session:** Pass session: 'repo-<name>' (e.g. 'repo-Test') on every open/read/snapshot/click.
- **Fix 2 - auto hash (patched ckdfuf2001/agent-browser):** Set AGENT_BROWSER_AUTO_SESSION=1 in mcp.env. Then default/opencode is auto-hashed to auto-<cwd-hash> per repo, so read without explicit session works and is isolated per repo.

## Warmup

- Backend pre-warms opencode:default after opencode start + every 60s via warmUpAgentBrowserDaemon(). Per-repo auto-* sessions are created lazily on first open.

## Troubleshooting

- blank on read -> add session or enable AGENT_BROWSER_AUTO_SESSION=1.
- **No session specified (English):** If you call `agent_browser_*` without `session` and multiple sessions are open, the daemon now returns `No session specified. Open sessions: <list>. Please specify session, e.g. session: "<name>"` in English and lists `auto-*`/`repo-*` sessions. Pass the shown `session` on the next call.
- MCP error -32001 Request timed out on first open -> daemon cold start, backend warmup should have prevented; check AGENT_BROWSER_SESSION=default agent-browser session info --json for active/browserLaunched.
