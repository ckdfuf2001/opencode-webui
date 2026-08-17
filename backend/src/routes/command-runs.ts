import { Hono } from 'hono'
import { z } from 'zod'
import type { Database } from 'bun:sqlite'
import * as crDb from '../db/command-run-queries'
import { logger } from '../utils/logger'

const CreateSchema = z.object({
  id: z.string().min(1).max(100),
  sessionId: z.string().min(1),
  repoId: z.number().int().positive().optional(),
  commandName: z.string().min(1).max(255),
  args: z.string().max(20000).optional(),
  directory: z.string().max(1000).optional(),
  startedAt: z.number().int().positive(),
})

const UpdateMessageSchema = z.object({ messageId: z.string().min(1) })
const FinishSchema = z.object({ status: z.enum(['completed', 'failed', 'cancelled']) })

export function createCommandRunRoutes(db: Database) {
  const app = new Hono()

  // GET /api/command-runs?sessionId=... 또는 ?repoId=...
  app.get('/', async (c) => {
    try {
      const sessionId = c.req.query('sessionId')
      const repoIdRaw = c.req.query('repoId')
      if (sessionId) {
        return c.json(crDb.listCommandRunsBySession(db, sessionId))
      }
      if (repoIdRaw) {
        const repoId = parseInt(repoIdRaw, 10)
        if (Number.isNaN(repoId)) return c.json({ error: 'Invalid repoId' }, 400)
        return c.json(crDb.listCommandRunsByRepo(db, repoId))
      }
      return c.json({ error: 'sessionId or repoId is required' }, 400)
    } catch (error) {
      logger.error('Failed to list command runs:', error)
      return c.json({ error: 'Failed to list command runs' }, 500)
    }
  })

  app.post('/', async (c) => {
    try {
      const body = await c.req.json()
      const input = CreateSchema.parse(body)
      const run = crDb.createCommandRun(db, input)
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
      const id = c.req.param('id')
      const { messageId } = UpdateMessageSchema.parse(await c.req.json())
      crDb.updateCommandRunMessage(db, id, messageId)
      return c.json({ success: true })
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: 'Invalid data' }, 400)
      logger.error('Failed to update command run message:', error)
      return c.json({ error: 'Failed' }, 500)
    }
  })

  app.patch('/:id/finish', async (c) => {
    try {
      const id = c.req.param('id')
      const { status } = FinishSchema.parse(await c.req.json())
      crDb.markCommandRunFinished(db, id, status)
      return c.json({ success: true })
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: 'Invalid data' }, 400)
      logger.error('Failed to finish command run:', error)
      return c.json({ error: 'Failed' }, 500)
    }
  })

  app.delete('/:id', async (c) => {
    try {
      crDb.deleteCommandRun(db, c.req.param('id'))
      return c.json({ success: true })
    } catch (error) {
      logger.error('Failed to delete command run:', error)
      return c.json({ error: 'Failed' }, 500)
    }
  })

  app.delete('/session/:sessionId', async (c) => {
    try {
      crDb.clearSessionCommandRuns(db, c.req.param('sessionId'))
      return c.json({ success: true })
    } catch (error) {
      logger.error('Failed to clear session command runs:', error)
      return c.json({ error: 'Failed' }, 500)
    }
  })

  return app
}
