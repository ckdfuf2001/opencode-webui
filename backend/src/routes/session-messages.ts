import { Hono } from 'hono'
import { opencodeServerManager } from '../services/opencode-single-server'
import { ensureServerAuth } from '../services/opencode-auth'
import { logger } from '../utils/logger'

interface CachedMessageList {
  at: number
  messages: Array<{ info?: { id?: string } }>
}

// opencode 서버의 전체 목록을 대신 가져와 잠시 들고 있는다.
// 프론트가 380ms~2s 주기로 폴링해도 opencode 이벤트루프를 때리지 않게 한다.
// DOM 윈도우는 프론트가 담당하므로 여기서는 전체를 그대로 반환한다.
// 키(세션)마다 전체 목록(MB급)을 들고 있어 만료 정리+상한이 없으면
// 세션을 옮겨다닐수록 백엔드 메모리가 무한히 는다.
const cache = new Map<string, CachedMessageList>()
const CACHE_TTL_MS = 2000
const CACHE_MAX_KEYS = 20

function pruneCache(now: number): void {
  for (const [key, entry] of cache) {
    if (now - entry.at > CACHE_TTL_MS) cache.delete(key)
  }
  // Map은 삽입순이므로 앞쪽(오래된 것)부터 잘라 상한 유지
  while (cache.size > CACHE_MAX_KEYS) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

async function fetchAllMessages(sessionId: string, directory: string): Promise<Array<{ info?: { id?: string } }>> {
  const base = opencodeServerManager.getUrl()
  const dirQs = directory ? `?directory=${encodeURIComponent(directory)}` : ''
  const res = await fetch(`${base}/session/${sessionId}/message${dirQs}`, {
    headers: ensureServerAuth({}),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`opencode message list failed: HTTP ${res.status}`)
  return (await res.json()) as Array<{ info?: { id?: string } }>
}

export function createSessionMessageRoutes() {
  const app = new Hono()

  // GET /api/session-messages/:sessionId?directory=
  app.get('/:sessionId', async (c) => {
    try {
      const sessionId = c.req.param('sessionId')
      const directory = c.req.query('directory') ?? ''
      const key = `${directory}::${sessionId}`
      const now = Date.now()
      pruneCache(now)
      let entry = cache.get(key)
      if (!entry || now - entry.at > CACHE_TTL_MS) {
        const messages = await fetchAllMessages(sessionId, directory)
        entry = { at: Date.now(), messages }
        cache.delete(key)
        cache.set(key, entry)
        pruneCache(entry.at)
      }
      return c.json(entry.messages)
    } catch (error: unknown) {
      logger.error('Failed to load session messages:', error)
      return c.json({ error: error instanceof Error ? error.message : 'Failed to load messages' }, 500)
    }
  })

  return app
}
