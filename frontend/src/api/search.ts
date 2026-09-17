import { API_BASE_URL } from '@/config'

export interface MessageSearchHit {
  sessionId: string
  messageId: string
  role: string
  repoId: number | null
  turnIndex: number
  ts: number
  snippet: string
}

export interface MessageExpandRow {
  messageId: string
  role: string
  turnIndex: number
  ts: number
  text: string
}

export interface MessageExpandResult {
  center: MessageExpandRow
  rows: MessageExpandRow[]
}

export interface CommitSearchHit {
  sha: string
  repoId: number | null
  subject: string
  author: string | null
  committedAt: number
}

export interface CommitDetail {
  sha: string
  repoId: number | null
  subject: string
  body: string | null
  author: string | null
  branch: string | null
  committedAt: number
  files: string[]
  insertions: number | null
  deletions: number | null
}

export interface MessageSearchPage {
  hits: MessageSearchHit[]
  total: number
  hasMore: boolean
}

export async function searchMessages(params: {
  q: string
  k?: number
  offset?: number
  repoId?: number
  sessionId?: string
  signal?: AbortSignal
}): Promise<MessageSearchPage> {
  const sp = new URLSearchParams()
  if (params.q) sp.set('q', params.q)
  if (params.k != null) sp.set('k', String(params.k))
  if (params.offset != null) sp.set('offset', String(params.offset))
  if (params.repoId != null) sp.set('repoId', String(params.repoId))
  if (params.sessionId) sp.set('sessionId', params.sessionId)
  const res = await fetch(`${API_BASE_URL}/api/search/messages?${sp.toString()}`, params.signal ? { signal: params.signal } : undefined)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { error?: string }).error || 'Failed to search messages')
  }
  const data = (await res.json()) as { hits: MessageSearchHit[]; total: number; hasMore: boolean }
  return { hits: data.hits, total: data.total ?? data.hits.length, hasMore: data.hasMore ?? false }
}

export async function expandMessage(messageId: string, n = 3): Promise<MessageExpandResult> {
  const res = await fetch(
    `${API_BASE_URL}/api/search/messages/expand?messageId=${encodeURIComponent(messageId)}&n=${n}`,
  )
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { error?: string }).error || 'Failed to expand message')
  }
  return res.json() as Promise<MessageExpandResult>
}

export async function searchCommits(params: {
  q: string
  k?: number
  repoId?: number
}): Promise<CommitSearchHit[]> {
  const sp = new URLSearchParams()
  if (params.q) sp.set('q', params.q)
  if (params.k != null) sp.set('k', String(params.k))
  if (params.repoId != null) sp.set('repoId', String(params.repoId))
  const res = await fetch(`${API_BASE_URL}/api/search/commits?${sp.toString()}`)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { error?: string }).error || 'Failed to search commits')
  }
  const data = (await res.json()) as { hits: CommitSearchHit[] }
  return data.hits
}

export async function getCommitDetail(sha: string, repoId: number): Promise<CommitDetail> {
  const res = await fetch(
    `${API_BASE_URL}/api/search/commits/${encodeURIComponent(sha)}?repoId=${repoId}`,
  )
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { error?: string }).error || 'Failed to get commit detail')
  }
  return res.json() as Promise<CommitDetail>
}

export async function syncRecentSessions(limit = 25): Promise<{ synced: number; indexed: number }> {
  const res = await fetch(`${API_BASE_URL}/api/search/messages/sync-recent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit }),
  })
  if (!res.ok) throw new Error('Failed to sync recent sessions')
  return res.json()
}

export async function reindexMessages(sessionId?: string): Promise<{ indexed: number }> {
  const res = await fetch(`${API_BASE_URL}/api/search/messages/reindex`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sessionId ? { sessionId } : {}),
  })
  if (!res.ok) throw new Error('Failed to reindex messages')
  return res.json()
}

export async function reindexCommits(repoId?: number): Promise<unknown> {
  const res = await fetch(`${API_BASE_URL}/api/search/commits/reindex`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(repoId != null ? { repoId } : {}),
  })
  if (!res.ok) throw new Error('Failed to reindex commits')
  return res.json()
}

export interface RecallHit {
  kind: string
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

export interface RecallPage {
  block: string
  hits: RecallHit[]
  hasMore: boolean
  nextOffset: number | null
}

export async function recall(
  q: string,
  opts: { k?: number; repoId?: number; sessionId?: string; offset?: number; signal?: AbortSignal } = {},
): Promise<RecallPage> {
  const sp = new URLSearchParams({ q })
  if (opts.k != null) sp.set('k', String(opts.k))
  if (opts.offset != null) sp.set('offset', String(opts.offset))
  if (opts.repoId != null) sp.set('repoId', String(opts.repoId))
  if (opts.sessionId) sp.set('sessionId', opts.sessionId)
  const res = await fetch(`${API_BASE_URL}/api/search/recall?${sp.toString()}`, opts.signal ? { signal: opts.signal } : undefined)
  if (!res.ok) throw new Error('Failed to recall')
  const data = (await res.json()) as Partial<RecallPage>
  return {
    block: data.block ?? '',
    hits: data.hits ?? [],
    hasMore: data.hasMore ?? false,
    nextOffset: data.nextOffset ?? null,
  }
}

export async function deleteMessageIndexes(messageIds: string[]): Promise<{ deleted: number }> {
  const res = await fetch(`${API_BASE_URL}/api/search/messages/index`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageIds }),
  })
  if (!res.ok) throw new Error('Failed to delete message indexes')
  return res.json()
}

export async function deleteCommitIndexes(commits: { sha: string; repoId: number }[]): Promise<{ deleted: number }> {
  const res = await fetch(`${API_BASE_URL}/api/search/commits/index`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commits }),
  })
  if (!res.ok) throw new Error('Failed to delete commit indexes')
  return res.json()
}
