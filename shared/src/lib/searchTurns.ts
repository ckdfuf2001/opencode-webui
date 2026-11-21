/**
 * F1-2: 검색 결과 턴 그룹화 (user → 다음 user, 세션별).
 * turnSelection.ts의 체크박스 규칙과 같은 턴 경계를 쓴다.
 * JumpDialog(/search 아님)의 3단계 펼침과 공유한다.
 */

export interface TurnHitLike {
  sessionId: string
  messageId: string
  role?: string
  turnIndex?: number
}

export interface TurnGroup {
  /** "sessionId:turnUserMessageId" (user 없으면 첫 hit id). */
  key: string
  sessionId: string
  hitIndexes: number[]
}

export function isResponseHit(hit: Pick<TurnHitLike, 'role'>): boolean {
  return hit.role !== undefined && hit.role !== 'user'
}

export function groupSearchHits(hits: TurnHitLike[]): TurnGroup[] {
  const groups: TurnGroup[] = []
  let cur: TurnGroup | null = null
  hits.forEach((h, i) => {
    if (h.role === 'user' || cur == null || cur.sessionId !== h.sessionId) {
      cur = { key: `${h.sessionId}:${h.messageId}`, sessionId: h.sessionId, hitIndexes: [] }
      groups.push(cur)
    }
    cur.hitIndexes.push(i)
  })
  return groups
}
