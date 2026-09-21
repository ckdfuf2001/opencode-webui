import { Hono } from 'hono'
import { z } from 'zod'
import type { Database } from 'bun:sqlite'
import * as permissionRuleDb from '../db/permission-rule-queries'
import { getRepoById } from '../db/queries'
import { logger } from '../utils/logger'

const CreatePermissionRuleSchema = z.object({
  // null/생략이면 전역 룰 — 모든 레포 세션에 적용
  repoId: z.number().int().positive().nullish(),
  permission: z.string().min(1).max(255),
  pattern: z.string().min(1).max(10000),
})

export function createPermissionRuleRoutes(db: Database) {
  const app = new Hono()

  app.get('/', async (c) => {
    try {
      if (c.req.query('scope') === 'global') {
        return c.json(permissionRuleDb.listGlobalPermissionRules(db))
      }
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
      const repoId = validated.repoId ?? null

      if (repoId !== null && !getRepoById(db, repoId)) {
        return c.json({ error: 'Repo not found' }, 404)
      }

      const rule = permissionRuleDb.createPermissionRule(db, { ...validated, repoId })
      // 전역 룰 변경은 opencode.json permission 블록에 반영한다 (직렬화).
      // 파일은 다음 opencode 시작부터 적용, 그 전에는 live 자동승인이 커버.
      // 즉시 적용하려면 POST /api/opencode-restart 로 opencode 재시작.
      void import('../services/permission-config')
        .then((m) => m.queuePermissionConfigSync(db))
        .catch((e) => logger.debug('Permission config rewrite skipped:', e))
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
      void import('../services/permission-config')
        .then((m) => m.queuePermissionConfigSync(db))
        .catch((e) => logger.debug('Permission config rewrite skipped:', e))
      return c.json({ success: true })
    } catch (error) {
      logger.error('Failed to delete permission rule:', error)
      return c.json({ error: 'Failed to delete permission rule' }, 500)
    }
  })

  return app
}
