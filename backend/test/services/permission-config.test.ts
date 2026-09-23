import { describe, it, expect } from 'vitest'
import {
  toOpencodePatterns,
  renderPermissionConfig,
  renderPermissionConfigV2,
  mergePermissionConfigInto,
  mergePermissionConfigV2Into,
  isPermissionFileSyncEnabled,
  getPermissionSchema,
  queueConfigWrite,
} from '../../src/services/permission-config'
import type { PermissionRule } from '../../src/types/permission-rule'

function rule(partial: Partial<PermissionRule> = {}): PermissionRule {
  return { id: 1, repoId: null, permission: 'bash', pattern: '*', createdAt: 0, ...partial }
}

describe('toOpencodePatterns', () => {
  it('adds ** companion to /* (new semantics: * is single level)', () => {
    expect(toOpencodePatterns('C:/work/*')).toEqual(['C:/work/*', 'C:/work/**'])
  })
  it('adds * companion to /** (old-version compat)', () => {
    expect(toOpencodePatterns('C:/work/**')).toEqual(['C:/work/**', 'C:/work/*'])
  })
  it('expands bare paths to subtree variants (backend prefix semantics)', () => {
    expect(toOpencodePatterns('C:/work')).toEqual(['C:/work', 'C:/work/*', 'C:/work/**'])
  })
  it('leaves non-path commands alone', () => {
    expect(toOpencodePatterns('npm run *')).toEqual(['npm run *'])
  })
})

describe('renderPermissionConfig', () => {
  it('renders global rules only (with subtree variants)', () => {
    const out = renderPermissionConfig([
      rule({ id: 1, permission: 'external_directory', pattern: 'C:/data/*' }),
      rule({ id: 2, repoId: 7, permission: 'edit', pattern: 'C:/repo/*' }),
    ])
    expect(out).toEqual({ external_directory: { 'C:/data/*': 'allow', 'C:/data/**': 'allow' } })
  })
  it('expands * permission to all keys (incl. external_directory, excl. doom_loop)', () => {
    const out = renderPermissionConfig([rule({ id: 1, permission: '*', pattern: 'C:/safe/*' })])
    expect(out['bash']).toEqual({ 'C:/safe/*': 'allow', 'C:/safe/**': 'allow' })
    expect(out['external_directory']).toEqual({ 'C:/safe/*': 'allow', 'C:/safe/**': 'allow' })
    expect(out['doom_loop']).toBeUndefined()
  })
  it('passes explicit doom_loop through (no expansion)', () => {
    const out = renderPermissionConfig([rule({ id: 1, permission: 'doom_loop', pattern: 'repeat *' })])
    expect(out).toEqual({ doom_loop: { 'repeat *': 'allow' } })
  })
  it('skips bare catch-all patterns', () => {
    expect(renderPermissionConfig([rule({ id: 1, permission: 'bash', pattern: '*' })])).toEqual({})
    expect(renderPermissionConfig([rule({ id: 2, permission: '*', pattern: '**' })])).toEqual({})
  })
  it('later rules win (last match wins)', () => {
    const out = renderPermissionConfig([
      rule({ id: 1, createdAt: 10, permission: 'read', pattern: 'C:/a/*' }),
      rule({ id: 2, createdAt: 20, permission: 'read', pattern: 'C:/a/b/*' }),
    ])
    expect(Object.keys(out['read'] ?? {})).toEqual(['C:/a/*', 'C:/a/**', 'C:/a/b/*', 'C:/a/b/**'])
  })
  it('skips empty patterns', () => {
    expect(renderPermissionConfig([rule({ pattern: '   ' })])).toEqual({})
  })
})

describe('mergePermissionConfigInto', () => {
  it('keeps hand-written entries and lets DB win on conflict', () => {
    const merged = mergePermissionConfigInto(
      { permission: { edit: { 'C:/x/*': 'deny' } }, other: 1 },
      { edit: { 'C:/x/*': 'allow', 'C:/y/*': 'allow' } }
    ) as { permission: Record<string, Record<string, string>>; other: number }
    expect(merged.permission['edit']).toEqual({ 'C:/x/*': 'allow', 'C:/y/*': 'allow' })
    expect(merged.other).toBe(1)
  })
  it('creates permission block when absent', () => {
    const merged = mergePermissionConfigInto({}, { bash: { '*': 'allow' } }) as {
      permission: Record<string, Record<string, string>>
    }
    expect(merged.permission).toEqual({ bash: { '*': 'allow' } })
  })
  it('removes entries gone from render (rule deleted), keeps hand entries', () => {
    const merged = mergePermissionConfigInto(
      { permission: { webfetch: { 'https://gone/*': 'allow', 'https://hand/*': 'allow' } } },
      {},
      { webfetch: { 'https://gone/*': 'allow' } }
    ) as { permission: Record<string, Record<string, string>> }
    expect(merged.permission['webfetch']).toEqual({ 'https://hand/*': 'allow' })
  })
  it('drops tool key left empty', () => {
    const merged = mergePermissionConfigInto(
      { permission: { webfetch: { 'https://gone/*': 'allow' } } },
      {},
      { webfetch: { 'https://gone/*': 'allow' } }
    ) as { permission: Record<string, Record<string, string>> }
    expect(merged.permission).toEqual({})
  })
})

describe('v0.12.0: file-sync gate and schema env', () => {
  it('file sync is off by default', () => {
    delete process.env.WEBUI_PERMISSION_FILE_SYNC
    expect(isPermissionFileSyncEnabled()).toBe(false)
    process.env.WEBUI_PERMISSION_FILE_SYNC = '1'
    expect(isPermissionFileSyncEnabled()).toBe(true)
    delete process.env.WEBUI_PERMISSION_FILE_SYNC
  })
  it('schema defaults to v1', () => {
    delete process.env.OPENCODE_PERMISSION_SCHEMA
    expect(getPermissionSchema()).toBe('v1')
    process.env.OPENCODE_PERMISSION_SCHEMA = 'v2'
    expect(getPermissionSchema()).toBe('v2')
    delete process.env.OPENCODE_PERMISSION_SCHEMA
  })
})

describe('renderPermissionConfigV2', () => {
  it('renders global rules as action/resource/effect entries', () => {
    const out = renderPermissionConfigV2([
      rule({ id: 1, permission: 'bash', pattern: 'git status *' }),
      rule({ id: 2, repoId: 7, permission: 'edit', pattern: 'C:/repo/*' }),
    ])
    expect(out).toEqual([{ action: 'shell', resource: 'git status *', effect: 'allow' }])
  })
  it('maps task to subagent and expands * to v2 actions', () => {
    const out = renderPermissionConfigV2([rule({ id: 1, permission: 'task', pattern: 'reviewer' })])
    expect(out).toEqual([{ action: 'subagent', resource: 'reviewer', effect: 'allow' }])
    const star = renderPermissionConfigV2([rule({ id: 2, permission: '*', pattern: 'C:/safe/*' })])
    const actions = new Set(star.map((e) => e.action))
    expect(actions.has('shell')).toBe(true)
    expect(actions.has('subagent')).toBe(true)
    expect(actions.has('doom_loop')).toBe(false)
    expect(actions.has('bash')).toBe(false)
    expect(actions.has('task')).toBe(false)
  })
  it('skips catch-all and doom_loop', () => {
    expect(renderPermissionConfigV2([rule({ id: 1, permission: 'bash', pattern: '*' })])).toEqual([])
    expect(renderPermissionConfigV2([rule({ id: 2, permission: 'doom_loop', pattern: 'repeat *' })])).toEqual([])
  })
})

describe('mergePermissionConfigV2Into', () => {
  it('replaces previously rendered entries, keeps hand entries', () => {
    const merged = mergePermissionConfigV2Into(
      {
        permissions: [
          { action: 'shell', resource: 'old *', effect: 'allow' },
          { action: 'read', resource: 'hand/*', effect: 'allow' },
        ],
      },
      [{ action: 'shell', resource: 'new *', effect: 'allow' }],
      [{ action: 'shell', resource: 'old *', effect: 'allow' }],
    ) as { permissions: Array<{ action: string; resource: string; effect: string }> }
    expect(merged.permissions).toEqual([
      { action: 'read', resource: 'hand/*', effect: 'allow' },
      { action: 'shell', resource: 'new *', effect: 'allow' },
    ])
  })
  it('drops the permissions key when nothing remains', () => {
    const merged = mergePermissionConfigV2Into(
      { permissions: [{ action: 'shell', resource: 'old *', effect: 'allow' }], other: 1 },
      [],
      [{ action: 'shell', resource: 'old *', effect: 'allow' }],
    ) as { other: number; permissions?: unknown }
    expect(merged).toEqual({ other: 1 })
  })
  it('leaves hand entries alone when both lists are empty', () => {
    const content = { permissions: [{ action: 'read', resource: 'hand/*', effect: 'deny' }] }
    expect(mergePermissionConfigV2Into(content, [], [])).toEqual(content)
  })
})

describe('queueConfigWrite', () => {
  it('runs tasks in call order and returns results', async () => {
    const order: number[] = []
    const slow = queueConfigWrite(async () => {
      await new Promise((r) => setTimeout(r, 30))
      order.push(1)
      return 'a'
    })
    const fast = queueConfigWrite(async () => {
      order.push(2)
      return 'b'
    })
    expect(await slow).toBe('a')
    expect(await fast).toBe('b')
    expect(order).toEqual([1, 2])
  })
  it('keeps chain alive after a failure', async () => {
    const bad = queueConfigWrite(async () => {
      throw new Error('boom')
    })
    await expect(bad).rejects.toThrow('boom')
    expect(await queueConfigWrite(async () => 'ok')).toBe('ok')
  })
})
