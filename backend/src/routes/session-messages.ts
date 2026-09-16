import { Hono } from 'hono'
import {
  countSessionMessages,
  listSessionMessages,
  recentSessionMessages,
  windowSessionMessages,
} from '../services/session-message-db'
import { logger } from '../utils/logger'

// 세션 메시지 조회는 전부 opencode SQLite 직접 접근이다.
// opencode HTTP API(GET /session/:id/message)는 페이지네이션을 지원하지 않아
// 호출 한 번에 세션 전체(GB 가능)를 직렬화·전송·파싱하므로 — 전체 메시지
// 로드가 절대 발생하지 않게 이 파일에서 opencode HTTP 목록 조회를 쓰지 않는다.

function dbUnavailable(c: { json: (o: object, s?: number) => Response }) {
  return c.json({ error: 'OpenCode database unavailable' }, 503)
}

export function createSessionMessageRoutes() {
  const app = new Hono()

  // GET /api/session-messages/:sessionId/count
  // 개수 전용 — 메시지 본문을 일절 읽지 않는다 (상단 표기용). 가볍게 폴링 가능.
  app.get('/:sessionId/count', async (c) => {
    try {
      const sessionId = c.req.param('sessionId')
      const total = await countSessionMessages(sessionId)
      if (total == null) return dbUnavailable(c)
      return c.json({ total })
    } catch (error: unknown) {
      logger.error('Failed to count session messages:', error)
      return c.json({ error: error instanceof Error ? error.message : 'Failed to count messages' }, 500)
    }
  })

  // GET /api/session-messages/:sessionId/list?limit=&offset=&order=
  // 검색 메뉴 진입 시 소량 리스트 — id/role/시간/미리보기만 (parts 없음).
  // order=asc면 오래된 것부터 (다이얼로그 시간순 브라우징용), 기본 desc.
  app.get('/:sessionId/list', async (c) => {
    try {
      const sessionId = c.req.param('sessionId')
      const limitRaw = c.req.query('limit')
      const offsetRaw = c.req.query('offset')
      const limit = limitRaw ? parseInt(limitRaw, 10) || 20 : 20
      const offset = offsetRaw ? Math.max(0, parseInt(offsetRaw, 10) || 0) : 0
      const order = c.req.query('order') === 'asc' ? 'asc' : 'desc'
      const result = await listSessionMessages(sessionId, limit, offset, order)
      if (!result) return dbUnavailable(c)
      return c.json(result)
    } catch (error: unknown) {
      logger.error('Failed to list session messages:', error)
      return c.json({ error: error instanceof Error ? error.message : 'Failed to list messages' }, 500)
    }
  })

  // GET /api/session-messages/:sessionId/recent?limit=
  // 폴링용 최근 N개 전체 메시지 (parts 포함, 큰 part는 head만). 시간 오름차순.
  app.get('/:sessionId/recent', async (c) => {
    try {
      const sessionId = c.req.param('sessionId')
      const limitRaw = c.req.query('limit')
      const limit = limitRaw ? parseInt(limitRaw, 10) || 60 : 60
      const result = await recentSessionMessages(sessionId, limit)
      if (!result) return dbUnavailable(c)
      return c.json(result)
    } catch (error: unknown) {
      logger.error('Failed to load recent session messages:', error)
      return c.json({ error: error instanceof Error ? error.message : 'Failed to load recent messages' }, 500)
    }
  })

  // GET /api/session-messages/:sessionId/window?around=&limit= / ?before=&limit=
  // 점프용 윈도우 — around면 전후 limit개, before면 앵커 이전 limit개만 (parts 포함, cap 적용).
  // before는 load-more(오래된 쪽 확장)용. 응답에 total/hasMore가 같이 오므로
  // 헤더의 count 폴링 없이 더보기 버튼의 잔여 계산이 된다.
  app.get('/:sessionId/window', async (c) => {
    try {
      const sessionId = c.req.param('sessionId')
      const around = c.req.query('around') || ''
      const before = c.req.query('before') || ''
      const anchor = around || before
      if (!anchor) return c.json({ error: 'around or before query parameter is required' }, 400)
      const limitRaw = c.req.query('limit')
      const limit = limitRaw ? parseInt(limitRaw, 10) || 30 : 30
      const result = await windowSessionMessages(sessionId, anchor, limit, before ? 'before' : 'around')
      if (!result) return dbUnavailable(c)
      if (!result.found) return c.json({ error: 'Message not found' }, 404)
      return c.json({ total: result.total, messages: result.messages, hasMore: result.hasMore })
    } catch (error: unknown) {
      logger.error('Failed to load session message window:', error)
      return c.json({ error: error instanceof Error ? error.message : 'Failed to load message window' }, 500)
    }
  })

  return app
}
