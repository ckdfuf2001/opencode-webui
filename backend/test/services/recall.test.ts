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
  it('caps total hits at k across message+commit kinds', () => {
    // k=5 → perKind=3 → 메시지 3 + 커밋 3 = 6건이 모이므로 최종 5건으로 잘라야 한다.
    const { block, hits } = buildRecall(stubDb() as never, 'deploy prod', { k: 5 })
    expect(hits).toHaveLength(5)
    expect(block).toContain('deploy snippet 1')
    expect(block).toContain('deploy commit 2')
    expect(block).not.toContain('deploy commit 3')
    const itemLines = block.split('\n').filter((l) => l.startsWith('- ['))
    expect(itemLines).toHaveLength(5)
  })

  it('returns empty block when nothing matches', () => {
    const emptyDb = { query: () => ({ all: () => [], get: () => undefined }) }
    const { block, hits } = buildRecall(emptyDb as never, 'deploy prod', { k: 5 })
    expect(hits).toHaveLength(0)
    expect(block).toBe('')
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
