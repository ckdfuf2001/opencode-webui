import { Hono } from 'hono'
import { z } from 'zod'
import type { Database } from 'bun:sqlite'
import type { CommandRun } from '../db/command-run-queries'
import * as runs from '../services/command-runs'
import { getRecentHookCalls } from '../services/command-hooks'
import { getSessionTitles, getDescendantSessionIds } from '../services/opencode-session-titles'
import { listRepos } from '../db/queries'
import { logger } from '../utils/logger'

const CreateSchema = z.object({
  sessionId: z.string().min(1),
  repoId: z.number().int().positive().optional(),
  commandName: z.string().min(1).max(255),
  args: z.string().max(20000).optional(),
  directory: z.string().max(1000).optional(),
  kind: z.enum(['command', 'skill']).optional(),
})

const UpdateMessageSchema = z.object({ messageId: z.string().min(1) })
const FinishSchema = z.object({ status: z.enum(['completed', 'failed', 'cancelled']) })

const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000
const DEFAULT_VIEW_WINDOW_MS = 364 * 24 * 60 * 60 * 1000

const ViewQuerySchema = z.object({
  scope: z.enum(['all', 'repo', 'session']).default('all'),
  repoId: z.coerce.number().int().positive().optional(),
  sessionId: z.string().min(1).max(255).optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
})

function repoDisplayName(repo: { repoUrl?: string | null; localPath?: string | null }): string {
  if (repo.repoUrl) return repo.repoUrl.split('/').slice(-1)[0]?.replace(/\.git$/, '') || 'repo'
  const local = repo.localPath?.replace(/\\/g, '/').replace(/\/+$/, '') ?? ''
  return local.split('/').pop() || 'repo'
}

export function createCommandRunRoutes(db: Database) {
  const app = new Hono()

  // GET /api/command-runs?from=<ms>&to=<ms>  (달력 뷰)
  // GET /api/command-runs?sessionId=...      (세션 히스토리)
  // GET /api/command-runs?repoId=...         (repo 히스토리)
  app.get('/', async (c) => {
    try {
      const from = c.req.query('from')
      const to = c.req.query('to')

      if (from || to) {
        const fromTs = Number(from)
        const toTs = Number(to)
        if (!Number.isFinite(fromTs) || !Number.isFinite(toTs)) {
          return c.json({ error: 'from and to must be epoch milliseconds' }, 400)
        }
        if (toTs < fromTs) {
          return c.json({ error: 'to must be greater than or equal to from' }, 400)
        }
        if (toTs - fromTs > MAX_RANGE_MS) {
          return c.json({ error: 'Range too large (max 1 year)' }, 400)
        }
        return c.json(await runs.listRunsInRange(db, fromTs, toTs))
      }

      const sessionId = c.req.query('sessionId')
      if (sessionId) {
        return c.json(await runs.listRunsBySession(db, sessionId))
      }

      const repoIdRaw = c.req.query('repoId')
      if (repoIdRaw) {
        const repoId = parseInt(repoIdRaw, 10)
        if (Number.isNaN(repoId)) return c.json({ error: 'Invalid repoId' }, 400)
        return c.json(await runs.listRunsByRepo(db, repoId))
      }

      return c.json({ error: 'from/to, sessionId or repoId is required' }, 400)
    } catch (error) {
      logger.error('Failed to list command runs:', error)
      return c.json({ error: 'Failed to list command runs' }, 500)
    }
  })

  app.get('/hooks/recent', (c) => {
    return c.json({ calls: getRecentHookCalls() })
  })

  // GET /api/command-runs/view?scope=all|repo|session&repoId=&sessionId=&from=&to=
  // 커맨드 패널/캘린더용 스코프 조회. repoName·sessionTitle을 서버가 채워 반환한다.
  app.get('/view', async (c) => {
    try {
      const query = ViewQuerySchema.parse({
        scope: c.req.query('scope') || undefined,
        repoId: c.req.query('repoId') || undefined,
        sessionId: c.req.query('sessionId') || undefined,
        from: c.req.query('from') || undefined,
        to: c.req.query('to') || undefined,
      })

      let matched: CommandRun[] = []
      if (query.scope === 'repo') {
        if (!query.repoId) return c.json({ error: 'repoId is required for scope=repo' }, 400)
        matched = await runs.listRunsByRepo(db, query.repoId)
      } else if (query.scope === 'session') {
        if (!query.sessionId) return c.json({ error: 'sessionId is required for scope=session' }, 400)
        const descendants = await getDescendantSessionIds([query.sessionId])
        const sessionIds = [query.sessionId, ...descendants]
        const lists = await Promise.all(sessionIds.map((sid) => runs.listRunsBySession(db, sid)))
        matched = lists.flat()
      } else {
        matched = await runs.listRunsInRange(
          db,
          query.from ?? Date.now() - DEFAULT_VIEW_WINDOW_MS,
          query.to ?? Date.now(),
        )
      }

      if (query.from != null) matched = matched.filter((r) => r.startedAt >= (query.from as number))
      if (query.to != null) matched = matched.filter((r) => r.startedAt <= (query.to as number))
      // 히스토리 패널/달력은 커맨드 실행만 보여준다. skill 호출 이력은 jsonl에는 남는다.
      matched = matched.filter((r) => r.kind !== 'skill')

      const repos = listRepos(db)
      const repoNameById = new Map<number, string>()
      const repoNameByDir = new Map<string, string>()
      for (const repo of repos) {
        const name = repoDisplayName(repo)
        repoNameById.set(repo.id, name)
        if (repo.fullPath) repoNameByDir.set(repo.fullPath.replace(/\\/g, '/').toLowerCase(), name)
      }

      const titles = await getSessionTitles(matched.map((r) => r.sessionId))

      const items = matched
        .map((run) => {
          const repoName =
            (run.repoId != null ? repoNameById.get(run.repoId) : undefined) ??
            (run.directory ? repoNameByDir.get(run.directory.replace(/\\/g, '/').toLowerCase()) : undefined) ??
            null
          return { ...run, repoName, sessionTitle: titles[run.sessionId] ?? null }
        })
        .sort((a, b) => b.startedAt - a.startedAt)

      return c.json({ items })
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid view query', details: error.issues }, 400)
      }
      logger.error('Failed to build command run view:', error)
      return c.json({ error: 'Failed to build command run view' }, 500)
    }
  })

  app.post('/', async (c) => {
    try {
      const input = CreateSchema.parse(await c.req.json())
      // origin 은 클라이언트가 지정할 수 없다. UI 경로는 항상 'ui'.
      const run = await runs.recordRunStart(db, { ...input, origin: 'ui' })
      return c.json(run, 201)
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid data', details: error.issues }, 400)
      }
      logger.error('Failed to create command run:', error)
      return c.json({ error: 'Failed to create command run' }, 500)
    }
  })

  app.patch('/:id/message', async (c) => {
    try {
      const { messageId } = UpdateMessageSchema.parse(await c.req.json())
      await runs.attachMessage(db, c.req.param('id'), messageId)
      return c.json({ success: true })
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: 'Invalid data' }, 400)
      logger.error('Failed to update command run message:', error)
      return c.json({ error: 'Failed' }, 500)
    }
  })

  app.patch('/:id/finish', async (c) => {
    try {
      const { status } = FinishSchema.parse(await c.req.json())
      await runs.finishRun(db, c.req.param('id'), status)
      return c.json({ success: true })
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: 'Invalid data' }, 400)
      logger.error('Failed to finish command run:', error)
      return c.json({ error: 'Failed' }, 500)
    }
  })

  app.delete('/:id', async (c) => {
    try {
      await runs.removeRun(db, c.req.param('id'))
      return c.json({ success: true })
    } catch (error) {
      logger.error('Failed to delete command run:', error)
      return c.json({ error: 'Failed' }, 500)
    }
  })

  app.delete('/session/:sessionId', async (c) => {
    try {
      await runs.clearSessionRuns(db, c.req.param('sessionId'))
      return c.json({ success: true })
    } catch (error) {
      logger.error('Failed to clear session command runs:', error)
      return c.json({ error: 'Failed' }, 500)
    }
  })

  return app
}
