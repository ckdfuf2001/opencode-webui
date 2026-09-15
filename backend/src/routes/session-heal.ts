import { Hono } from 'hono'
import { opencodeServerManager } from '../services/opencode-single-server'
import { healAbnormalTailIfNeeded } from '../services/reasoning-heal'
import { logger } from '../utils/logger'

export function createSessionHealRoutes() {
  const app = new Hono()

  // POST /api/session-heal/:sessionId?directory=...
  // 비정상 꼬리(에러·aborted·ghost·중단)가 있으면 마지막 user부터 잘라내고 1회 정리.
  // 프론트 "정리" 버튼 전용 — 신선도 무관 force.
  app.post('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    const directory = c.req.query('directory') || undefined
    try {
      const base = opencodeServerManager.getUrl()
      const result = await healAbnormalTailIfNeeded(base, sessionId, directory, { force: true })
      if (result.healed) {
        return c.json({ healed: true, ...result })
      }
      return c.json({ healed: false, reason: result.reason ?? 'history clean' })
    } catch (e) {
      logger.error('session heal failed:', e)
      return c.json({ healed: false, reason: (e as Error)?.message ?? String(e) }, 500)
    }
  })

  return app
}
