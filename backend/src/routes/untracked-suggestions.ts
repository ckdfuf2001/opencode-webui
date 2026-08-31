import { Hono } from 'hono'
import { z } from 'zod'
import type { Database } from 'bun:sqlite'
import * as untracked from '../services/untracked-suggestions'
import { logger } from '../utils/logger'

const SuggestionStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'applied'])
const UpdateStatusSchema = z.object({ status: SuggestionStatusSchema })

export function createUntrackedSuggestionsRoutes(db: Database) {
  const app = new Hono()

  app.get('/', async (c) => {
    try {
      const repoIdRaw = c.req.query('repoId')
      const status = c.req.query('status')
      const repoId = repoIdRaw ? parseInt(repoIdRaw, 10) : undefined
      const items = untracked.listSuggestions(db, {
        repoId: repoId && !Number.isNaN(repoId) ? repoId : undefined,
        status: status || undefined,
      })
      return c.json(items)
    } catch (error) {
      logger.error('Failed to list untracked suggestions:', error)
      return c.json({ error: 'Failed to list untracked suggestions' }, 500)
    }
  })

  app.patch('/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const existing = untracked.getSuggestionById(db, id)
      if (!existing) return c.json({ error: 'Suggestion not found' }, 404)

      const body = await c.req.json()
      const validated = UpdateStatusSchema.parse(body)

      const ok = untracked.updateSuggestionStatus(db, id, validated.status)
      if (!ok) return c.json({ error: 'Failed to update suggestion' }, 500)

      const updated = untracked.getSuggestionById(db, id)
      return c.json(updated)
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid suggestion data', details: error.issues }, 400)
      }
      logger.error('Failed to update untracked suggestion:', error)
      return c.json({ error: 'Failed to update untracked suggestion' }, 500)
    }
  })

  return app
}
