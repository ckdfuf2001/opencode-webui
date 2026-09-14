import { Hono } from 'hono'
import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { listFavorites, upsertFavorite, deleteFavorite } from '../db/favorite-queries'
import { logger } from '../utils/logger'

const UPSERT = z.object({
  sessionId: z.string().min(1).max(200),
  repoId: z.number().int().nullable().optional(),
  directory: z.string().max(1024).optional(),
  title: z.string().max(200).optional(),
})

export function createFavoriteRoutes(db: Database) {
  const app = new Hono()
  app.get('/', (c) => {
    try { return c.json(listFavorites(db)) } catch (e) { logger.error('list favorites', e); return c.json({ error: 'failed' }, 500) }
  })
  app.post('/', async (c) => {
    try {
      const body = UPSERT.parse(await c.req.json())
      const row = upsertFavorite(db, body)
      return c.json(row)
    } catch (e: any) {
      if (e?.issues) return c.json({ error: 'Invalid body', details: e.issues }, 400)
      return c.json({ error: e.message || 'failed' }, e.statusCode || 500)
    }
  })
  app.delete('/', (c) => {
    const sid = c.req.query('sessionId') || c.req.query('session_id') || ''
    if (!sid) return c.json({ error: 'sessionId required' }, 400)
    try {
      if (!deleteFavorite(db, sid)) return c.json({ error: 'not found' }, 404)
      return c.json({ success: true })
    } catch (e) { return c.json({ error: 'failed' }, 500) }
  })
  return app
}
