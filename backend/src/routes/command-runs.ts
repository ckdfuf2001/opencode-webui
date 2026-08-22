import { Hono } from 'hono'
import { z } from 'zod'
import type { Database } from 'bun:sqlite'
import * as runs from '../services/command-runs'
import { getRecentHookCalls } from '../services/command-hooks'
import { logger } from '../utils/logger'

const CreateSchema = z.object({
  sessionId: z.string().min(1),
  repoId: z.number().int().positive().optional(),
  commandName: z.string().min(1).max(255),
  args: z.string().max(20000).optional(),
  directory: z.string().max(1000).optional(),
})

const UpdateMessageSchema = z.object({ messageId: z.string().min(1) })
const FinishSchema = z.object({ status: z.enum(['completed', 'failed', 'cancelled']) })

const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000

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
        return c.json(runs.listRunsInRange(db, fromTs, toTs))
      }

      const sessionId = c.req.query('sessionId')
      if (sessionId) {
        return c.json(runs.listRunsBySession(db, sessionId))
      }

      const repoIdRaw = c.req.query('repoId')
      if (repoIdRaw) {
        const repoId = parseInt(repoIdRaw, 10)
        if (Number.isNaN(repoId)) return c.json({ error: 'Invalid repoId' }, 400)
        return c.json(runs.listRunsByRepo(db, repoId))
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

  app.post('/', async (c) => {
    try {
      const input = CreateSchema.parse(await c.req.json())
      // origin 은 클라이언트가 지정할 수 없다. UI 경로는 항상 'ui'.
      const run = runs.recordRunStart(db, { ...input, origin: 'ui' })
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
      runs.attachMessage(db, c.req.param('id'), messageId)
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
      runs.finishRun(db, c.req.param('id'), status)
      return c.json({ success: true })
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: 'Invalid data' }, 400)
      logger.error('Failed to finish command run:', error)
      return c.json({ error: 'Failed' }, 500)
    }
  })

  app.delete('/:id', async (c) => {
    try {
      runs.removeRun(db, c.req.param('id'))
      return c.json({ success: true })
    } catch (error) {
      logger.error('Failed to delete command run:', error)
      return c.json({ error: 'Failed' }, 500)
    }
  })

  app.delete('/session/:sessionId', async (c) => {
    try {
      runs.clearSessionRuns(db, c.req.param('sessionId'))
      return c.json({ success: true })
    } catch (error) {
      logger.error('Failed to clear session command runs:', error)
      return c.json({ error: 'Failed' }, 500)
    }
  })

  return app
}
