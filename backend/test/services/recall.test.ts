import { describe, it, expect, vi } from 'vitest'

// bun:sqlite를 직접 import하는 체인(opencode-db 경유)을 피한다.
// buildRecall이 쓰는 searchMessages/searchCommits는 db.query stub으로 충분하다.
vi.mock('../../src/services/opencode-db', () => ({
  getOpenCodeDbPath: vi.fn(async () => null),
}))

import { buildRecall, readRecallPrefs } from '../../src/services/recall'

function msgRow(i: number) {
  return { s: 'ses-1', m: `msg-${i}`, r: 'assistant', rid: 1, ti: i, t: 1000 + i, snip: `deploy snippet ${i}` }
}

function commitRow(i: number) {
  return { sha: `abc123${i}`, repoId: 1, subject: `deploy commit ${i}`, author: 'dev', committedAt: 2000 + i }
}

function stubDb() {
  const msgRows = [1, 2, 3, 4, 5].map(msgRow)
  const commitRows = [1, 2, 3, 4, 5].map(commitRow)
  return {
    query: (sql: string) => ({
      all: () => {
        if (sql.includes('session_messages_fts')) return msgRows
        if (sql.includes('git_commits_fts')) return commitRows
        return []
      },
      get: () => undefined,
    }),
  }
}

describe('buildRecall', () => {
  it('returns per-kind windows (k=5 → 3+3, 종류 균형 유지)', () => {
    const { block, hits, hasMore, nextOffset } = buildRecall(stubDb() as never, 'deploy prod', { k: 5 })
    expect(hits).toHaveLength(6)
    expect(block).toContain('deploy snippet 1')
    expect(block).toContain('deploy commit 3')
    const itemLines = block.split('\n').filter((l) => l.startsWith('- ['))
    expect(itemLines).toHaveLength(6)
    // stub은 종류별 5건씩 → 3건씩 보여주고 잔여 있음
    expect(hasMore).toBe(true)
    expect(nextOffset).toBe(3)
  })

  it('pages with offset and terminates (타일링 정확성)', () => {
    const p0 = buildRecall(stubDb() as never, 'deploy prod', { k: 4, offset: 0 })
    expect(p0.hits.map((h) => h.kind === 'message' ? h.messageId : h.sha)).toEqual([
      'msg-1', 'msg-2', 'abc1231', 'abc1232',
    ])
    expect(p0.hasMore).toBe(true)
    expect(p0.nextOffset).toBe(2)
    const p1 = buildRecall(stubDb() as never, 'deploy prod', { k: 4, offset: p0.nextOffset! })
    expect(p1.hits.map((h) => h.kind === 'message' ? h.messageId : h.sha)).toEqual([
      'msg-3', 'msg-4', 'abc1233', 'abc1234',
    ])
    expect(p1.hasMore).toBe(true)
    const p2 = buildRecall(stubDb() as never, 'deploy prod', { k: 4, offset: p1.nextOffset! })
    expect(p2.hits.map((h) => h.kind === 'message' ? h.messageId : h.sha)).toEqual([
      'msg-5', 'abc1235',
    ])
    expect(p2.hasMore).toBe(false)
    expect(p2.nextOffset).toBeNull()
  })

  it('exactK trims to exactly k for injection paths (topK honored)', () => {
    const { block, hits, hasMore } = buildRecall(stubDb() as never, 'deploy prod', { k: 5, exactK: true })
    expect(hits).toHaveLength(5)
    expect(block).toContain('deploy commit 2')
    expect(block).not.toContain('deploy commit 3')
    // 잘라냈어도 잔여 판정은 윈도우 기준이라 루프 호출자는 영향 없음
    expect(hasMore).toBe(true)
  })

  it('returns empty block when nothing matches', () => {
    const emptyDb = { query: () => ({ all: () => [], get: () => undefined }) }
    const { block, hits, hasMore, nextOffset } = buildRecall(emptyDb as never, 'deploy prod', { k: 5 })
    expect(hits).toHaveLength(0)
    expect(block).toBe('')
    expect(hasMore).toBe(false)
    expect(nextOffset).toBeNull()
  })
})

describe('readRecallPrefs', () => {
  const prefsDb = (preferences: string | null) => ({
    query: () => ({ all: () => [], get: () => (preferences == null ? undefined : { preferences }) }),
  })
  it('returns defaults when no row exists', () => {
    expect(readRecallPrefs(prefsDb(null) as never)).toEqual({ enabled: true, topK: 4 })
  })
  it('respects stored values', () => {
    expect(
      readRecallPrefs(prefsDb(JSON.stringify({ autoRecallEnabled: false, recallTopK: 7 })) as never),
    ).toEqual({ enabled: false, topK: 7 })
  })
  it('falls back to defaults on malformed JSON or out-of-range topK', () => {
    expect(readRecallPrefs(prefsDb('{{{') as never)).toEqual({ enabled: true, topK: 4 })
    expect(readRecallPrefs(prefsDb(JSON.stringify({ recallTopK: 99 })) as never)).toEqual({
      enabled: true,
      topK: 4,
    })
  })
})
