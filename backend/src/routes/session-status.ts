import { Hono } from 'hono'
import type { Database } from 'bun:sqlite'
import { listSessionStatus, setSessionCancelled, clearSessionCancelled } from '../db/session-status-queries'
import { logger } from '../utils/logger'

export function createSessionStatusRoutes(db: Database) {
  const app = new Hono()

  // GET /api/session-status — 전체 세션 상태(busy/idle + 승인 대기 수).
  // 프론트 리스트/헤더가 이 값을 폴링해 상태를 그린다.
  app.get('/', (c) => {
    try {
      return c.json(listSessionStatus(db))
    } catch (error) {
      logger.error('Failed to list session status:', error)
      return c.json({ error: 'Failed to list session status' }, 500)
    }
  })

  // POST /api/session-status/:id/cancelled — 마지막 결과가 캔슬이면 cancelled 배찌 표시 (다음 채팅 전까지 유지)
  app.post('/:id/cancelled', async (c) => {
    try {
      const id = c.req.param('id')
      setSessionCancelled(db, id)
      return c.json({ ok: true })
    } catch (error) {
      logger.error('Failed to set cancelled:', error)
      return c.json({ error: 'Failed to set cancelled' }, 500)
    }
  })

  app.delete('/:id/cancelled', async (c) => {
    try {
      const id = c.req.param('id')
      clearSessionCancelled(db, id)
      return c.json({ ok: true })
    } catch (error) {
      logger.error('Failed to clear cancelled:', error)
      return c.json({ error: 'Failed to clear cancelled' }, 500)
    }
  })

  return app
}
