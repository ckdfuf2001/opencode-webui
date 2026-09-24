import { describe, it, expect } from 'vitest'
import { buildPlaywrightCommand, defaultMcpEntries, mergeDefaultMcpEntries, repairStalePathEnv } from '../../src/services/default-mcp'

describe('buildPlaywrightCommand', () => {
  it('pins bundled chromium when present', () => {
    expect(buildPlaywrightCommand('C:\\bundle\\chrome.exe')).toEqual([
      'npx',
      '--yes',
      '@playwright/mcp@latest',
      '--headless',
      '--isolated',
      '--executable-path',
      'C:\\bundle\\chrome.exe',
    ])
  })
  it('falls back to system resolution without bundled chromium', () => {
    expect(buildPlaywrightCommand('')).toEqual([
      'npx',
      '--yes',
      '@playwright/mcp@latest',
      '--headless',
      '--isolated',
    ])
  })
})

describe('doc-reader install root env', () => {
  it('passes OPCODE_WEBUI_ROOT to the MCP entry', () => {
    const entries = defaultMcpEntries() as Record<string, { env?: Record<string, string> }>
    expect(entries['doc-reader']?.env?.OPCODE_WEBUI_ROOT).toBe(process.cwd())
  })
  it('backfills OPCODE_WEBUI_ROOT into existing entries on merge', () => {
    const merged = mergeDefaultMcpEntries({
      mcp: {
        'doc-reader': {
          type: 'local',
          command: ['python', 'vendor/office-mcp/server.py'],
          env: { OPCODE_WEBUI_BACKEND: 'http://127.0.0.1:5001' },
        },
      },
    }) as { mcp: Record<string, { env?: Record<string, string> }> }
    expect(merged.mcp['doc-reader']?.env?.OPCODE_WEBUI_ROOT).toBe(process.cwd())
    // 기존 키는 유지된다
    expect(merged.mcp['doc-reader']?.env?.OPCODE_WEBUI_BACKEND).toBe('http://127.0.0.1:5001')
  })
})

describe('repairStalePathEnv', () => {
  const noExist = () => false
  const yesExist = () => true
  it('replaces a stale path with the computed default (repo-suffixed REPOS case)', () => {
    const r = repairStalePathEnv(
      { OPCODE_WEBUI_REPOS: '/ws/repos/doc-reader' },
      { OPCODE_WEBUI_REPOS: '/ws/repos' },
      (p) => p === '/ws/repos',
    )
    expect(r.changed).toBe(true)
    expect(r.env.OPCODE_WEBUI_REPOS).toBe('/ws/repos')
    expect(r.repaired).toEqual(['OPCODE_WEBUI_REPOS'])
  })
  it('keeps a valid custom path', () => {
    const r = repairStalePathEnv(
      { OPCODE_WEBUI_REPOS: '/custom/repos' },
      { OPCODE_WEBUI_REPOS: '/ws/repos' },
      yesExist,
    )
    expect(r.changed).toBe(false)
  })
  it('leaves untouched when neither exists (transient unmount)', () => {
    const r = repairStalePathEnv(
      { OPCODE_WEBUI_REPOS: '/gone/repos' },
      { OPCODE_WEBUI_REPOS: '/ws/repos' },
      noExist,
    )
    expect(r.changed).toBe(false)
    expect(r.env.OPCODE_WEBUI_REPOS).toBe('/gone/repos')
  })
  it('ignores non-path keys', () => {
    const r = repairStalePathEnv(
      { OPCODE_WEBUI_BACKEND: 'http://x', OTHER: 'y' },
      { OPCODE_WEBUI_BACKEND: 'http://y' },
      noExist,
    )
    expect(r.changed).toBe(false)
  })
})
