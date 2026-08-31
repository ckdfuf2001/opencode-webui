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

export interface RecallHit {
  kind: 'message' | 'commit'
  snippet: string
  meta: string
}

export function buildRecall(db: Database, q: string, opts: RecallOptions = {}): { block: string; hits: RecallHit[] } {
  const k = Math.max(1, Math.min(10, opts.k ?? 5))
  const perKind = Math.max(1, Math.ceil(k / 2))
  const hits: RecallHit[] = []

  if (opts.includeMessages !== false) {
    const msgs = searchMessagesUnion(db, q, perKind, opts)
    for (const m of msgs) {
      hits.push({
        kind: 'message',
        snippet: m.snippet.replace(/\[|\]/g, ''),
        meta: `${m.role} turn ${m.turnIndex} ${new Date(m.ts).toLocaleDateString()} session ${m.sessionId.slice(0, 8)}`,
      })
    }
  }

  if (opts.includeCommits !== false) {
    const commits = searchCommitsUnion(db, q, perKind, opts)
    for (const c of commits) {
      hits.push({
        kind: 'commit',
        snippet: `${c.sha.slice(0, 7)} ${c.subject}`,
        meta: `${c.author ?? ''} ${new Date(c.committedAt).toLocaleDateString()} ${c.repoId === 0 ? 'host' : `repo ${c.repoId}`}`.trim(),
      })
    }
  }

  if (hits.length === 0) return { block: '', hits }

  const lines = ['<memory-recall>']
  lines.push(`query: "${q}"`)
  for (const h of hits) {
    lines.push(`- [${h.kind}] ${h.snippet} — ${h.meta}`)
  }
  lines.push('</memory-recall>')
  return { block: lines.join('\n'), hits }
}

function searchMessagesUnion(db: Database, q: string, k: number, opts: RecallOptions) {
  const tokens = tokenize(q)
  if (tokens.length === 0) return []
  if (tokens.length === 1) return searchMessages(db, q, { k, repoId: opts.repoId, sessionId: opts.sessionId })
  const seen = new Set<string>()
  const out: ReturnType<typeof searchMessages> = []
  for (const tok of tokens) {
    const hits = searchMessages(db, tok, { k, repoId: opts.repoId, sessionId: opts.sessionId })
    for (const h of hits) {
      if (seen.has(h.messageId)) continue
      seen.add(h.messageId)
      out.push(h)
      if (out.length >= k) return out
    }
  }
  if (out.length > 0) return out.slice(0, k)
  return searchMessages(db, q, { k, repoId: opts.repoId, sessionId: opts.sessionId })
}

function searchCommitsUnion(db: Database, q: string, k: number, opts: RecallOptions) {
  const tokens = tokenize(q)
  if (tokens.length === 0) return []
  if (tokens.length === 1) return searchCommits(db, q, { k, repoId: opts.repoId })
  const seen = new Set<string>()
  const out: ReturnType<typeof searchCommits> = []
  for (const tok of tokens) {
    const hits = searchCommits(db, tok, { k, repoId: opts.repoId })
    for (const h of hits) {
      const key = `${h.repoId}:${h.sha}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(h)
      if (out.length >= k) return out
    }
  }
  if (out.length > 0) return out.slice(0, k)
  return searchCommits(db, q, { k, repoId: opts.repoId })
}

function tokenize(q: string): string[] {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_\-]/gu, '').trim())
    .filter((t) => t.length > 1)
}
