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
    const msgs = searchMessages(db, q, { k: perKind, repoId: opts.repoId, sessionId: opts.sessionId })
    for (const m of msgs) {
      hits.push({
        kind: 'message',
        snippet: m.snippet.replace(/\[|\]/g, ''),
        meta: `${m.role} turn ${m.turnIndex} ${new Date(m.ts).toLocaleDateString()} session ${m.sessionId.slice(0, 8)}`,
      })
    }
  }

  if (opts.includeCommits !== false) {
    const commits = searchCommits(db, q, { k: perKind, repoId: opts.repoId })
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
