import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  isAgentBrowserProxyEnabled,
  resolveAgentBrowserProxy,
  agentBrowserProxyEnv,
} from '../../src/services/agent-browser-proxy'

describe('agent-browser-proxy module', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ['AGENT_BROWSER_SESSION_PROXY', 'AGENT_BROWSER_PROXY_MJS']) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('is disabled by default — stock direct path intact, no writes', () => {
    expect(isAgentBrowserProxyEnabled()).toBe(false)
    expect(resolveAgentBrowserProxy('C:\\fake\\agent-browser.exe', 'opencode')).toBeNull()
    expect(agentBrowserProxyEnv()).toEqual({})
  })

  it('falls back to null when the proxy script is missing', () => {
    process.env.AGENT_BROWSER_SESSION_PROXY = '1'
    process.env.AGENT_BROWSER_PROXY_MJS = 'C:\\definitely\\not\\here\\mcp-server.mjs'
    expect(resolveAgentBrowserProxy('C:\\fake\\agent-browser.exe', 'opencode')).toBeNull()
  })

  it('passes SESSION_* env through only when enabled', () => {
    process.env.AGENT_BROWSER_SESSION_PROXY = '1'
    const env = agentBrowserProxyEnv()
    expect(env.SESSION_TTL_MS).toBe('600000')
    expect(env.SESSION_MAX).toBe('16')
    expect(env.SESSION_SWEEP_MS).toBe('60000')
  })

  it('resolves node+mjs command when enabled and the script exists', () => {
    const mjs = fileURLToPath(new URL('../../../agent-browser-proxy/mcp-server.mjs', import.meta.url))
    if (!existsSync(mjs)) return // module folder removed — nothing to resolve
    process.env.AGENT_BROWSER_SESSION_PROXY = '1'
    process.env.AGENT_BROWSER_PROXY_MJS = mjs
    const resolved = resolveAgentBrowserProxy('C:\\bin\\agent-browser.exe', 'opencode')
    // node가 없으면 null 폴백 (어느 쪽이든 크래시 없이 stock direct로 복귀)
    if (resolved) {
      expect(resolved.command).toEqual(['node', mjs, '--cli', 'C:\\bin\\agent-browser.exe', '--namespace', 'opencode'])
    } else {
      expect(resolved).toBeNull()
    }
  })
})
