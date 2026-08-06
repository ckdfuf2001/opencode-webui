import { Hono } from 'hono'
import { z } from 'zod'
import type { Database } from 'bun:sqlite'
import * as permissionRuleDb from '../db/permission-rule-queries'
import { getRepoById } from '../db/queries'
import { logger } from '../utils/logger'

const CreatePermissionRuleSchema = z.object({
  repoId: z.number().int().positive(),
  permission: z.string().min(1).max(255),
  pattern: z.string().min(1).max(10000),
})

export function createPermissionRuleRoutes(db: Database) {
  const app = new Hono()

  app.get('/', async (c) => {
    try {
      const repoIdRaw = c.req.query('repoId')
      const repoId = repoIdRaw ? parseInt(repoIdRaw, 10) : undefined
      const rules = permissionRuleDb.listPermissionRules(db, repoId && !Number.isNaN(repoId) ? repoId : undefined)
      return c.json(rules)
    } catch (error) {
      logger.error('Failed to list permission rules:', error)
      return c.json({ error: 'Failed to list permission rules' }, 500)
    }
  })

  app.post('/', async (c) => {
    try {
      const body = await c.req.json()
      const validated = CreatePermissionRuleSchema.parse(body)

      if (!getRepoById(db, validated.repoId)) {
        return c.json({ error: 'Repo not found' }, 404)
      }

      const rule = permissionRuleDb.createPermissionRule(db, validated)
      return c.json(rule, 201)
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid permission rule data', details: error.issues }, 400)
      }
      logger.error('Failed to create permission rule:', error)
      return c.json({ error: 'Failed to create permission rule' }, 500)
    }
  })

  app.delete('/:id', async (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10)
      const deleted = permissionRuleDb.deletePermissionRule(db, id)
      if (!deleted) {
        return c.json({ error: 'Permission rule not found' }, 404)
      }
      return c.json({ success: true })
    } catch (error) {
      logger.error('Failed to delete permission rule:', error)
      return c.json({ error: 'Failed to delete permission rule' }, 500)
    }
  })

  return app
}
