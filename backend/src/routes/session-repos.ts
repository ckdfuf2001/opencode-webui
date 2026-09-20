import { Hono } from 'hono'
import { z } from 'zod'
import type { Database } from 'bun:sqlite'
import { getSessionRepo, setSessionRepoIfAbsent } from '../db/session-repo-queries'
import { getRepoById } from '../db/queries'
import { logger } from '../utils/logger'

const RecordSessionRepoSchema = z.object({
  sessionId: z.string().min(1).max(255),
  repoId: z.number().int().positive(),
})

export function createSessionRepoRoutes(db: Database) {
  const app = new Hono()

  // 세션 소속 기록 (first-write-wins). 프론트가 세션 화면 마운트 시 1회 호출.
  app.post('/', async (c) => {
    try {
      const validated = RecordSessionRepoSchema.parse(await c.req.json().catch(() => ({})))
      if (!getRepoById(db, validated.repoId)) {
        return c.json({ error: 'Repo not found' }, 404)
      }
      const created = setSessionRepoIfAbsent(db, validated.sessionId, validated.repoId)
      return c.json({ ok: true, created, repoId: getSessionRepo(db, validated.sessionId) })
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: 'Invalid payload' }, 400)
      logger.error('Failed to record session repo:', error)
      return c.json({ error: 'Failed to record session repo' }, 500)
    }
  })

  app.get('/:sessionId', async (c) => {
    try {
      return c.json({ repoId: getSessionRepo(db, c.req.param('sessionId')) })
    } catch (error) {
      logger.error('Failed to read session repo:', error)
      return c.json({ error: 'Failed to read session repo' }, 500)
    }
  })

  return app
}
