/**
 * agent-browser-proxy integration (optional module, 0.7.0+).
 * See agent-browser-proxy/README.md.
 *
 * Single integration point for the session-isolation MCP proxy.
 * - Default OFF: every function below is a no-op unless AGENT_BROWSER_PROXY=1.
 * - This file only READS the agent-browser binary path handed in by the
 *   caller. It NEVER writes bin/agent-browser/*.exe or .meta.json.
 * - Removal: delete this file + agent-browser-proxy/ + the marked blocks
 *   in default-mcp.ts / package-portable.ps1 / .env.example.
 */
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { logger } from '../utils/logger'

export const AGENT_BROWSER_PROXY_SESSION_TTL_MS = '600000'
export const AGENT_BROWSER_PROXY_SESSION_MAX = '16'
export const AGENT_BROWSER_PROXY_SESSION_SWEEP_MS = '60000'

export function isAgentBrowserProxyEnabled(): boolean {
  // NOTE: 반드시 전용 이름 사용. `AGENT_BROWSER_PROXY`는 agent-browser 본체의
  // 프록시 서버 URL 변수라서 값 `1`이 들어가면 Chrome 전체가 프록시 "1"을 타서
  // 모든 내비게이션이 ERR_PROXY_CONNECTION_FAILED로 죽는다.
  return process.env.AGENT_BROWSER_SESSION_PROXY === '1'
}

function resolveProxyMjs(): string | null {
  const override = process.env.AGENT_BROWSER_PROXY_MJS
  if (override && existsSync(override)) return override
  const roots: string[] = []
  try {
    roots.push(process.cwd())
  } catch {}
  try {
    roots.push(path.dirname(process.execPath))
  } catch {}
  for (const root of roots) {
    try {
      const candidate = path.join(root, 'agent-browser-proxy', 'mcp-server.mjs')
      if (existsSync(candidate)) return candidate
    } catch {}
  }
  return null
}

function hasNodeRuntime(): boolean {
  try {
    execFileSync('node', ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

/**
 * Proxy MCP command (`node mcp-server.mjs --cli <exe> --namespace <ns>`),
 * or null to fall back to the stock direct binary path.
 * `binPath` is used read-only as the proxy's `--cli` target.
 */
export function resolveAgentBrowserProxy(
  binPath: string,
  namespace: string,
): { command: string[] } | null {
  if (!isAgentBrowserProxyEnabled()) return null
  const mjs = resolveProxyMjs()
  if (!mjs) {
    logger.warn('AGENT_BROWSER_PROXY=1 but agent-browser-proxy/mcp-server.mjs not found — using stock direct MCP')
    return null
  }
  if (!hasNodeRuntime()) {
    logger.warn('AGENT_BROWSER_PROXY=1 but no node runtime — using stock direct MCP')
    return null
  }
  return { command: ['node', mjs, '--cli', binPath, '--namespace', namespace] }
}

/** SESSION_* passthrough for the proxy process. Empty unless enabled. */
export function agentBrowserProxyEnv(): Record<string, string> {
  if (!isAgentBrowserProxyEnabled()) return {}
  return {
    SESSION_TTL_MS: process.env.SESSION_TTL_MS ?? AGENT_BROWSER_PROXY_SESSION_TTL_MS,
    SESSION_MAX: process.env.SESSION_MAX ?? AGENT_BROWSER_PROXY_SESSION_MAX,
    SESSION_SWEEP_MS: process.env.SESSION_SWEEP_MS ?? AGENT_BROWSER_PROXY_SESSION_SWEEP_MS,
  }
}
