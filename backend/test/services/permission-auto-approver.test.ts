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

  it('ignores case for path-like rules (Windows)', () => {
    expect(
      ruleMatches(rule({ permission: 'edit', pattern: 'c:\\work' }), { id: 'x', sessionID: 's', permission: 'edit', pattern: 'C:\\Work\\a.txt' }),
    ).toBe(true)
  })

  it('trims trailing separators from rules and candidates', () => {
    expect(
      ruleMatches(rule({ permission: 'edit', pattern: 'C:/work/' }), { id: 'x', sessionID: 's', permission: 'edit', pattern: 'C:/work/a.txt' }),
    ).toBe(true)
    expect(
      ruleMatches(rule({ permission: 'edit', pattern: 'C:\\work\\' }), { id: 'x', sessionID: 's', permission: 'edit', pattern: 'C:\\work\\a.txt' }),
    ).toBe(true)
    expect(
      ruleMatches(rule({ permission: 'edit', pattern: 'C:/work' }), { id: 'x', sessionID: 's', permission: 'edit', pattern: 'C:/work/' }),
    ).toBe(true)
  })

  it('strips extended-length \\\\?\\ prefix', () => {
    expect(
      ruleMatches(rule({ permission: 'read', pattern: 'C:\\work' }), { id: 'x', sessionID: 's', permission: 'read', pattern: '\\\\?\\C:\\work\\a.txt' }),
    ).toBe(true)
  })

  it('trailing star covers base and subtree (slash or space before star)', () => {
    const deep = { id: 'x', sessionID: 's', permission: 'edit', pattern: 'C:\\work\\a\\b.txt' }
    expect(ruleMatches(rule({ permission: 'edit', pattern: 'C:\\work\\*' }), deep)).toBe(true)
    expect(ruleMatches(rule({ permission: 'edit', pattern: 'C:/work/*' }), deep)).toBe(true)
    expect(
      ruleMatches(rule({ permission: 'edit', pattern: 'C:/work/*' }), { id: 'x', sessionID: 's', permission: 'edit', pattern: 'C:/work' }),
    ).toBe(true)
    expect(
      ruleMatches(rule({ permission: 'bash', pattern: 'git status *' }), { id: 'x', sessionID: 's', permission: 'bash', pattern: 'git status' }),
    ).toBe(true)
    expect(
      ruleMatches(rule({ permission: 'bash', pattern: 'git status *' }), { id: 'x', sessionID: 's', permission: 'bash', pattern: 'git status --short' }),
    ).toBe(true)
  })

  it('does not leak siblings or glob-extensions via prefix', () => {
    expect(
      ruleMatches(rule({ permission: 'edit', pattern: 'C:/work' }), { id: 'x', sessionID: 's', permission: 'edit', pattern: 'C:/work2/a.txt' }),
    ).toBe(false)
    // '*.ts'는 직계만 허용 — 하위 디렉터리로 번지지 않는다
    expect(
      ruleMatches(rule({ permission: 'edit', pattern: 'C:/work/*.ts' }), { id: 'x', sessionID: 's', permission: 'edit', pattern: 'C:/work/sub/a.ts' }),
    ).toBe(false)
    expect(
      ruleMatches(rule({ permission: 'edit', pattern: 'C:/work/*.ts' }), { id: 'x', sessionID: 's', permission: 'edit', pattern: 'C:/work/a.ts' }),
    ).toBe(true)
  })

  it('treats ? as single-char wildcard', () => {
    expect(
      ruleMatches(rule({ permission: 'read', pattern: 'file?.txt' }), { id: 'x', sessionID: 's', permission: 'read', pattern: 'file1.txt' }),
    ).toBe(true)
    expect(
      ruleMatches(rule({ permission: 'read', pattern: 'file?.txt' }), { id: 'x', sessionID: 's', permission: 'read', pattern: 'file.txt' }),
    ).toBe(false)
  })
})
