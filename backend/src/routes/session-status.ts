import { Hono } from 'hono'
import type { Database } from 'bun:sqlite'
import { listSessionStatus } from '../db/session-status-queries'
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

  return app
}
