import { Hono } from 'hono'
import { z } from 'zod'
import type { Database } from 'bun:sqlite'
import {
  searchMessages,
  expandMessage,
  indexSessionMessages,
  indexAllSessions,
} from '../services/fts-indexer'
import {
  searchCommits,
  getCommitDetail,
  indexRepoCommits,
  indexAllRepos,
  HOST_REPO_ID,
} from '../services/git-indexer'
import { getRepoById } from '../db/queries'
import { listAllIndexedRepos } from '../services/git-indexer'
import { buildRecall } from '../services/recall'
import { logger } from '../utils/logger'

const SearchSchema = z.object({ q: z.string().max(500).optional(), k: z.coerce.number().int().min(1).max(50).optional() })
const ExpandSchema = z.object({ messageId: z.string().min(1), n: z.coerce.number().int().min(0).max(20).optional() })
const ReindexMessagesSchema = z.object({ sessionId: z.string().optional() })
const ReindexCommitsSchema = z.object({ repoId: z.coerce.number().int().optional(), force: z.boolean().optional() })
const CommitDetailSchema = z.object({ repoId: z.coerce.number().int() })

export function createSearchRoutes(db: Database) {
  const app = new Hono()

  app.get('/messages', async (c) => {
    try {
      const parsed = SearchSchema.parse({
        q: c.req.query('q'),
        k: c.req.query('k') ? Number(c.req.query('k')) : undefined,
      })
      const repoIdRaw = c.req.query('repoId')
      const repoId = repoIdRaw != null && repoIdRaw !== '' ? parseInt(repoIdRaw, 10) : undefined
      const sessionId = c.req.query('sessionId') || undefined
      const hits = searchMessages(db, parsed.q || '', {
        k: parsed.k,
        repoId: repoId != null && !Number.isNaN(repoId) ? repoId : undefined,
        sessionId,
      })
      return c.json({ hits })
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: 'Invalid query', details: error.issues }, 400)
      logger.error('Failed to search messages:', error)
      return c.json({ error: 'Failed to search messages' }, 500)
    }
  })

  app.get('/messages/expand', async (c) => {
    try {
      const parsed = ExpandSchema.parse({
        messageId: c.req.query('messageId'),
        n: c.req.query('n') ? Number(c.req.query('n')) : undefined,
      })
      const result = expandMessage(db, parsed.messageId, parsed.n)
      if (!result.center) return c.json({ error: 'Message not found' }, 404)
      return c.json(result)
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: 'Invalid query', details: error.issues }, 400)
      logger.error('Failed to expand message:', error)
      return c.json({ error: 'Failed to expand message' }, 500)
    }
  })

  app.post('/messages/reindex', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const parsed = ReindexMessagesSchema.parse(body ?? {})
      if (parsed.sessionId) {
        const n = await indexSessionMessages(db, parsed.sessionId)
        return c.json({ sessionId: parsed.sessionId, indexed: n })
      }
      const total = await indexAllSessions(db)
      return c.json({ indexed: total })
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: 'Invalid body', details: error.issues }, 400)
      logger.error('Failed to reindex messages:', error)
      return c.json({ error: 'Failed to reindex messages' }, 500)
    }
  })

  app.get('/commits', async (c) => {
    try {
      const parsed = SearchSchema.parse({
        q: c.req.query('q'),
        k: c.req.query('k') ? Number(c.req.query('k')) : undefined,
      })
      const repoIdRaw = c.req.query('repoId')
      const repoId = repoIdRaw != null && repoIdRaw !== '' ? parseInt(repoIdRaw, 10) : undefined
      const hits = searchCommits(db, parsed.q || '', {
        k: parsed.k,
        repoId: repoId != null && !Number.isNaN(repoId) ? repoId : undefined,
      })
      return c.json({ hits })
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: 'Invalid query', details: error.issues }, 400)
      logger.error('Failed to search commits:', error)
      return c.json({ error: 'Failed to search commits' }, 500)
    }
  })

  app.get('/commits/:sha', async (c) => {
    try {
      const repoIdRaw = c.req.query('repoId')
      if (!repoIdRaw) return c.json({ error: 'repoId query parameter is required' }, 400)
      const parsed = CommitDetailSchema.parse({ repoId: Number(repoIdRaw) })
      const sha = c.req.param('sha')
      const detail = getCommitDetail(db, parsed.repoId, sha)
      if (!detail) {
        await tryIndexSingleCommit(db, parsed.repoId, sha)
        const retry = getCommitDetail(db, parsed.repoId, sha)
        return retry ? c.json(retry) : c.json({ error: 'Commit not found' }, 404)
      }
      return c.json(detail)
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: 'Invalid query', details: error.issues }, 400)
      logger.error('Failed to get commit detail:', error)
      return c.json({ error: 'Failed to get commit detail' }, 500)
    }
  })

  app.post('/commits/reindex', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const parsed = ReindexCommitsSchema.parse(body ?? {})
      if (parsed.repoId != null) {
        const repo =
          parsed.repoId === HOST_REPO_ID
            ? listAllIndexedRepos(db).find((r) => r.id === HOST_REPO_ID) ?? null
            : getRepoById(db, parsed.repoId)
        if (!repo) return c.json({ error: 'Repo not found' }, 404)
        const n = await indexRepoCommits(db, repo, { force: parsed.force })
        return c.json({ repoId: parsed.repoId, indexed: n })
      }
      const results = await indexAllRepos(db, { force: parsed.force })
      return c.json({ repos: results })
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: 'Invalid body', details: error.issues }, 400)
      logger.error('Failed to reindex commits:', error)
      return c.json({ error: 'Failed to reindex commits' }, 500)
    }
  })

  app.get('/recall', async (c) => {
    try {
      const q = c.req.query('q') ?? ''
      if (!q.trim()) return c.json({ block: '', hits: [] })
      const kRaw = c.req.query('k')
      const k = kRaw ? parseInt(kRaw, 10) : undefined
      const repoIdRaw = c.req.query('repoId')
      const repoId = repoIdRaw != null && repoIdRaw !== '' ? parseInt(repoIdRaw, 10) : undefined
      const sessionId = c.req.query('sessionId') || undefined
      const result = buildRecall(db, q, {
        k: k != null && !Number.isNaN(k) ? k : undefined,
        repoId: repoId != null && !Number.isNaN(repoId) ? repoId : undefined,
        sessionId,
      })
      return c.json(result)
    } catch (error) {
      logger.error('Failed to recall:', error)
      return c.json({ error: 'Failed to recall' }, 500)
    }
  })

  return app
}

async function tryIndexSingleCommit(db: Database, repoId: number, sha: string): Promise<void> {
  try {
    const repo =
      repoId === HOST_REPO_ID
        ? listAllIndexedRepos(db).find((r) => r.id === HOST_REPO_ID) ?? null
        : getRepoById(db, repoId)
    if (!repo) return
    // 단일 커밋은 최신 이력 재인덱스로 커버한다.
    await indexRepoCommits(db, repo, { force: true })
  } catch (error) {
    logger.warn(`Failed to index single commit ${sha}:`, error)
  }
}
