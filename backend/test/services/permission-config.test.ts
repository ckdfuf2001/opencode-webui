import { describe, it, expect } from 'vitest'
import {
  toOpencodePatterns,
  renderPermissionConfig,
  mergePermissionConfigInto,
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
