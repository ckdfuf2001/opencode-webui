import { describe, expect, it } from 'vitest'
import { groupSearchHits, isResponseHit } from '@opencode-webui/shared/lib/searchTurns'

/**
 * F1-2: 검색 결과 턴 그룹화 (user → 다음 user, 세션별) + "응답에서 일치" 판정.
 * turnSelection.ts의 체크박스 규칙과 같은 턴 경계를 쓴다.
 */
const H = (sessionId: string, messageId: string, role: string, turnIndex: number) => ({
  sessionId,
  messageId,
  role,
  turnIndex,
})

describe('groupSearchHits', () => {
  it('user부터 다음 user 전까지를 한 턴으로 묶는다', () => {
    const hits = [
      H('s1', 'u1', 'user', 0),
      H('s1', 'a1', 'assistant', 1),
      H('s1', 'a2', 'assistant', 2),
      H('s1', 'u2', 'user', 3),
      H('s1', 'a3', 'assistant', 4),
    ]
    const groups = groupSearchHits(hits)
    expect(groups.map((g) => g.hitIndexes)).toEqual([[0, 1, 2], [3, 4]])
    expect(groups[0]!.key).toBe('s1:u1')
    expect(groups[1]!.key).toBe('s1:u2')
  })
  it('세션이 다르면 따로 묶는다', () => {
    const hits = [H('s1', 'u1', 'user', 0), H('s2', 'u9', 'user', 5), H('s1', 'a1', 'assistant', 1)]
    const groups = groupSearchHits(hits)
    expect(groups.map((g) => g.hitIndexes)).toEqual([[0], [1], [2]])
  })
  it('user 없이 시작하면 앞부분은 따로 묶는다', () => {
    const hits = [H('s1', 'a0', 'assistant', 0), H('s1', 'u1', 'user', 1)]
    const groups = groupSearchHits(hits)
    expect(groups.map((g) => g.hitIndexes)).toEqual([[0], [1]])
  })
})

describe('isResponseHit', () => {
  it('user가 아니면 응답에서 일치', () => {
    expect(isResponseHit({ sessionId: 's', messageId: 'a', role: 'assistant' })).toBe(true)
    expect(isResponseHit({ sessionId: 's', messageId: 'u', role: 'user' })).toBe(false)
    expect(isResponseHit({ sessionId: 's', messageId: 'x' })).toBe(false)
  })
})
