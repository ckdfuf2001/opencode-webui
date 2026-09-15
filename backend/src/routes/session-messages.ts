import { Hono } from 'hono'
import { opencodeServerManager } from '../services/opencode-single-server'
import { ensureServerAuth } from '../services/opencode-auth'
import { logger } from '../utils/logger'

// 즐겨favorites 팝업이 limit=10으로 끝 N개만 가져와도, 백엔드는
// opencode에 전체 목록(MB~GB)을 먼저 다 받아 캐시에 올린 뒤 slice한다.
// pnpm·git pull 등 대량 툴 출력이 한 세션에 수 GB 쌓이면
// 캐시가 20개 키 × GB = 20GB 힙을 잡고, 2s TTL 동안 폴링마다 재로드해
// GC 폭발과 네트워크 폭발을 일으킨다. 캐시에 올릴 때 tool output을
// 미리 잘라낸다 — 원본은 opencode에 보관, 프론트는 cap된 사본만 본다.
const MAX_TOOL_OUTPUT_KEEP = 20_000
const TOOL_TRUNCATE_NOTICE = '\n\n…[output truncated for memory — see full log in session]'
const MAX_TOOL_OUTPUT_RUNNING = MAX_TOOL_OUTPUT_KEEP * 6

function capToolOutputInMessage(msg: { info?: { id?: string }; parts?: unknown[] }): { info?: { id?: string }; parts?: unknown[] } {
  const parts = msg.parts
  if (!Array.isArray(parts)) return msg
  let changed = false
  const nextParts = parts.map((p: any) => {
    if (!p || p.type !== 'tool' || !p.state) return p
    const st = p.state as { output?: unknown; metadata?: { output?: unknown }; status?: string }
    const out = st.output ?? st.metadata?.output
    if (typeof out !== 'string' || out.length <= MAX_TOOL_OUTPUT_RUNNING) return p
    const truncated = out.slice(0, MAX_TOOL_OUTPUT_KEEP) + TOOL_TRUNCATE_NOTICE + ` (${out.length - MAX_TOOL_OUTPUT_KEEP} chars omitted)`
    if (st.output != null) return { ...p, state: { ...st, output: truncated } }
    return { ...p, state: { ...st, metadata: { ...(st.metadata ?? {}), output: truncated } } }
  })
  if (nextParts !== parts) changed = true
  return changed ? { ...msg, parts: nextParts } : msg
}

function capToolOutputsInList(messages: Array<{ info?: { id?: string } }>): Array<{ info?: { id?: string } }> {
  let changed = false
  const next = messages.map((m) => {
    const capped = capToolOutputInMessage(m)
    if (capped !== m) changed = true
    return capped
  })
  return changed ? next : messages
}

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

  // GET /api/session-messages/:sessionId?directory=&limit=
  // limit이 있으면 끝 N개만 반환한다 — 즐겨찾기 팝업이 전체를 들고 오는 GB 문제를 막기 위해.
  app.get('/:sessionId', async (c) => {
    try {
      const sessionId = c.req.param('sessionId')
      const directory = c.req.query('directory') ?? ''
      const limitRaw = c.req.query('limit')
      const limit = limitRaw ? Math.max(1, Math.min(100, parseInt(limitRaw, 10) || 0)) : 0
      const key = `${directory}::${sessionId}`
      const now = Date.now()
      pruneCache(now)
      let entry = cache.get(key)
      if (!entry || now - entry.at > CACHE_TTL_MS) {
        const messages = await fetchAllMessages(sessionId, directory)
        const capped = capToolOutputsInList(messages)
        entry = { at: Date.now(), messages: capped }
        cache.delete(key)
        cache.set(key, entry)
        pruneCache(entry.at)
      }
      if (limit > 0 && entry.messages.length > limit) {
        return c.json(entry.messages.slice(-limit))
      }
      return c.json(entry.messages)
    } catch (error: unknown) {
      logger.error('Failed to load session messages:', error)
      return c.json({ error: error instanceof Error ? error.message : 'Failed to load messages' }, 500)
    }
  })

  return app
}
