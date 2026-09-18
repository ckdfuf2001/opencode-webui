import { describe, it, expect } from 'vitest'
import { globToRegex, ruleMatches } from '../../src/services/permission-auto-approver'
import type { PermissionRule } from '../../src/types/permission-rule'

function rule(partial: Partial<PermissionRule> = {}): PermissionRule {
  return { id: 1, repoId: 1, permission: 'bash', pattern: '*', createdAt: 0, ...partial }
}

describe('globToRegex', () => {
  it('matches exact and * wildcards', () => {
    expect(globToRegex('git *').test('git status')).toBe(true)
    expect(globToRegex('git *').test('gitstatus')).toBe(false)
    expect(globToRegex('*').test('anything at all')).toBe(true)
  })

  it('supports ** across separators', () => {
    expect(globToRegex('/tmp/**').test('/tmp/a/b/c')).toBe(true)
    expect(globToRegex('/tmp/*').test('/tmp/a/b')).toBe(false)
  })

  it('escapes regex metacharacters', () => {
    expect(globToRegex('a+b').test('a+b')).toBe(true)
    expect(globToRegex('a+b').test('aab')).toBe(false)
  })
})

describe('ruleMatches', () => {
  it('matches by type, * matches all types', () => {
    expect(ruleMatches(rule({ permission: 'bash' }), { id: 'x', sessionID: 's', permission: 'bash', pattern: 'ls' })).toBe(true)
    expect(ruleMatches(rule({ permission: 'edit' }), { id: 'x', sessionID: 's', permission: 'bash', pattern: 'ls' })).toBe(false)
    expect(ruleMatches(rule({ permission: '*' }), { id: 'x', sessionID: 's', permission: 'edit', pattern: '/a/b' })).toBe(true)
  })

  it('matches patterns array and metadata command/path/url', () => {
    expect(
      ruleMatches(rule({ pattern: 'npm run *' }), {
        id: 'x',
        sessionID: 's',
        permission: 'bash',
        metadata: { command: 'npm run build' },
      }),
    ).toBe(true)
    expect(
      ruleMatches(rule({ permission: 'read', pattern: '/tmp/foo' }), {
        id: 'x',
        sessionID: 's',
        permission: 'read',
        metadata: { path: '/tmp/foo/bar/baz.txt' },
      }),
    ).toBe(true)
    expect(
      ruleMatches(rule({ pattern: 'https://a.com/*', permission: 'webfetch' }), {
        id: 'x',
        sessionID: 's',
        permission: 'webfetch',
        metadata: { url: 'https://a.com/x' },
      }),
    ).toBe(true)
  })

  it('matches prefix with space separator (commands)', () => {
    expect(
      ruleMatches(rule({ pattern: 'npm run' }), { id: 'x', sessionID: 's', permission: 'bash', pattern: 'npm run build' }),
    ).toBe(true)
    expect(
      ruleMatches(rule({ pattern: 'npm run' }), { id: 'x', sessionID: 's', permission: 'bash', pattern: 'npm runner' }),
    ).toBe(false)
  })

  it('rejects empty candidates and normalizes windows separators for prefix rules', () => {
    expect(ruleMatches(rule({ pattern: '/x' }), { id: 'x', sessionID: 's', permission: 'bash' })).toBe(false)
    expect(
      ruleMatches(rule({ permission: 'read', pattern: 'C:/work' }), { id: 'x', sessionID: 's', permission: 'read', pattern: 'C:\\work\\a.txt' }),
    ).toBe(true)
  })
})
