import { Hono } from 'hono'
import { z } from 'zod'
import type { Database } from 'bun:sqlite'
import * as permissionRuleDb from '../db/permission-rule-queries'
import { getRepoById } from '../db/queries'
import { queuePermissionConfigSync } from '../services/permission-config'
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
      // v0.12.0: 룰 변경은 live 자동승인자(SSE+sweep)가 즉시 강제한다 (once 응답).
      // 파일 동기화는 기본 OFF(WEBUI_PERMISSION_FILE_SYNC=1 일 때만 전역 룰을
      // opencode.json에 쓰며, 그 경우 다음 opencode 시작부터 적용 —
      // 즉시 적용하려면 POST /api/opencode-restart 로 opencode 재시작).
      // await로 기다린다 — 요청 순서대로 파일에 반영되게 (빠른 연속 CRUD 순서 보장).
      await queuePermissionConfigSync(db)
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
      await queuePermissionConfigSync(db)
      return c.json({ success: true })
    } catch (error) {
      logger.error('Failed to delete permission rule:', error)
      return c.json({ error: 'Failed to delete permission rule' }, 500)
    }
  })

  return app
}
