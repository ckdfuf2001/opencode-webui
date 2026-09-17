import type { Database } from 'bun:sqlite'
import { searchMessages } from './fts-indexer'
import { searchCommits } from './git-indexer'

export interface RecallOptions {
  k?: number
  repoId?: number | null
  sessionId?: string
  includeMessages?: boolean
  includeCommits?: boolean
}

export interface RecallPrefs {
  enabled: boolean
  topK: number
}

/**
 * user_preferences의 recall 설정을 읽는다. 행 없음·파싱 실패 시 기본값
 * (enabled, k=4) — 호출부마다 복붙하던 것을 여기로 모았다.
 */
export function readRecallPrefs(db: Database): RecallPrefs {
  try {
    const row = db
      .query('SELECT preferences FROM user_preferences WHERE user_id = ?')
      .get('default') as { preferences: string } | undefined
    if (!row?.preferences) return { enabled: true, topK: 4 }
    const p = JSON.parse(row.preferences) as { autoRecallEnabled?: boolean; recallTopK?: number }
    return {
      enabled: p.autoRecallEnabled !== false,
      topK: typeof p.recallTopK === 'number' && p.recallTopK >= 1 && p.recallTopK <= 10 ? p.recallTopK : 4,
    }
  } catch {
    return { enabled: true, topK: 4 }
  }
}

export interface RecallHit {
  kind: 'message' | 'commit'
  snippet: string
  meta: string
  repoId?: number | null
  sessionId?: string
  messageId?: string
  turnIndex?: number
  ts?: number
  sha?: string
  role?: string
}

/**
 * 종류별 sanity 상한 — offset은 종류별 좌표라 실질 상한은 종류당 1만건이다.
 * 스니펫은 작아 합쳐도 수 MB 수준이다. 이를 넘기면 빈 페이지 +
 * hasMore=false로 루프를 끝낸다.
 */
export const RECALL_KIND_HARD_CAP = 10000

export function buildRecall(
  db: Database,
  q: string,
  opts: RecallOptions & { offset?: number; exactK?: boolean } = {},
): { block: string; hits: RecallHit[]; hasMore: boolean; nextOffset: number | null } {
  // 프롬프트 주입용은 큰 k가 필요하고(전체 루프), 채팅 주입은 작게 쓴다.
  // HTTP /messages 엔드포인트는 zod k≤50으로 별도 제한이라 여길 올려도 안전.
  const k = Math.max(1, Math.min(200, opts.k ?? 5))
  // 종류별 윈도우: 각 종류는 독립 스트림이라 같은 offset으로 타일링해도
  // 정확히 덮는다 (한쪽이 먼저 바닥나도 다른 쪽은 계속 진행).
  // 홀수 k면 한 행 더 나오지만(ceil) 종류 균형이 깨지지 않는 쪽을 택한다.
  const perKind = Math.max(1, Math.ceil(k / 2))
  const offset = Math.max(0, opts.offset ?? 0)
  if (offset >= RECALL_KIND_HARD_CAP) {
    return { block: '', hits: [], hasMore: false, nextOffset: null }
  }
  // union은 prefix만 반환하므로 매번 앞쪽부터 다시 읽는다 (O(offset)).
  // +1씩 더 읽어 잔여 존재를 판정한다. 인덱스가 안정적이라는 전제 —
  // 흔들리면 프론트의 키 dedup이 흡수하고, 0건 진전 시 루프가 멈춘다.
  // (하위 searchMessages/searchCommits의 내부 상한은 20000까지 열려 있어
  //  deep page에서도 잘리지 않는다 — HTTP 엔드포인트는 zod로 별도 상한 유지)
  const want = Math.min(offset + perKind + 1, RECALL_KIND_HARD_CAP + 1)
  const hits: RecallHit[] = []
  let msgMore = false
  let commitMore = false

  if (opts.includeMessages !== false) {
    const msgs = searchMessagesUnion(db, q, want, { repoId: opts.repoId })
    msgMore = msgs.length > offset + perKind
    for (const m of msgs.slice(offset, offset + perKind)) {
      hits.push({
        kind: 'message',
        snippet: m.snippet.replace(/\[|\]/g, ''),
        meta: `${m.role} turn ${m.turnIndex} ${new Date(m.ts).toLocaleDateString()} repo ${m.repoId ?? ''} session ${m.sessionId.slice(0, 8)}`,
        repoId: m.repoId,
        sessionId: m.sessionId,
        messageId: m.messageId,
        turnIndex: m.turnIndex,
        ts: m.ts,
        role: m.role,
      })
    }
  }

  if (opts.includeCommits !== false) {
    const commits = searchCommitsUnion(db, q, want, opts)
    commitMore = commits.length > offset + perKind
    for (const c of commits.slice(offset, offset + perKind)) {
      hits.push({
        kind: 'commit',
        snippet: `${c.sha.slice(0, 7)} ${c.subject}`,
        meta: `${c.author ?? ''} ${new Date(c.committedAt).toLocaleDateString()} ${c.repoId === 0 ? 'host' : `repo ${c.repoId}`}`.trim(),
        repoId: c.repoId,
        sha: c.sha,
        ts: c.committedAt,
      })
    }
  }

  if (hits.length === 0) return { block: '', hits, hasMore: false, nextOffset: null }
  const hasMore = msgMore || commitMore
  // 주입 경로는 topK를 상한으로 신뢰하므로 정확히 k개까지만 내보낸다.
  // (홀수 k면 perKind 윈도우가 1행 더 나오기 때문. 페이징 호출자는 exactK를
  //  쓰지 않아 타일링에 영향 없음)
  const out = opts.exactK ? hits.slice(0, k) : hits
  const lines = ['<memory-recall>']
  lines.push(`query: "${q}"`)
  for (const h of out) {
    lines.push(`- [${h.kind}] ${h.snippet} — ${h.meta}`)
  }
  lines.push('</memory-recall>')
  return {
    block: lines.join('\n'),
    hits: out,
    hasMore,
    nextOffset: hasMore ? offset + perKind : null,
  }
}

function searchMessagesUnion(db: Database, q: string, k: number, opts: RecallOptions) {
  const tokens = tokenize(q)
  if (tokens.length === 0) return []
  if (tokens.length === 1) return searchMessages(db, q, { k, repoId: opts.repoId })
  const seen = new Set<string>()
  const out: ReturnType<typeof searchMessages> = []
  for (const tok of tokens) {
    const hits = searchMessages(db, tok, { k, repoId: opts.repoId })
    for (const h of hits) {
      if (seen.has(h.messageId)) continue
      seen.add(h.messageId)
      out.push(h)
      if (out.length >= k) return out
    }
  }
  if (out.length > 0) return out.slice(0, k)
  return searchMessages(db, q, { k, repoId: opts.repoId })
}

function searchCommitsUnion(db: Database, q: string, k: number, opts: RecallOptions) {
  const doSearch = (repoId: number | null | undefined) => {
    const tokens = tokenize(q)
    if (tokens.length === 0) return [] as ReturnType<typeof searchCommits>
    if (tokens.length === 1) return searchCommits(db, q, { k, repoId })
    const seenLocal = new Set<string>()
    const outLocal: ReturnType<typeof searchCommits> = []
    for (const tok of tokens) {
      const hits = searchCommits(db, tok, { k, repoId })
      for (const h of hits) {
        const key = `${h.repoId}:${h.sha}`
        if (seenLocal.has(key)) continue
        seenLocal.add(key)
        outLocal.push(h)
        if (outLocal.length >= k) return outLocal
      }
    }
    if (outLocal.length > 0) return outLocal.slice(0, k)
    return searchCommits(db, q, { k, repoId })
  }

  const primary = doSearch(opts.repoId)
  return primary
}

function tokenize(q: string): string[] {
  return q
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => {
      if (t === '*') return t
      if (t.includes('*')) return t
      return t.replace(/[^\p{L}\p{N}_\-]/gu, '').trim()
    })
    .filter((t) => t === '*' || t.length >= 2)
}
