import { Database } from 'bun:sqlite'
import { getOpenCodeDbPath } from './opencode-db'
import { logger } from '../utils/logger'

interface SessionRow {
  id: string
  title: string | null
  parent_id: string | null
}

/** opencode 로컬 DB에서 세션 제목을 조회한다. 실패 시 빈 map(타이틀 미확정)으로 폴백한다. */
const TITLES_CACHE_TTL_MS = 60_000
const titlesCache = new Map<string, { title: string; at: number }>()

export async function getSessionTitles(ids: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids)].filter(Boolean)
  if (unique.length === 0) return {}

  const out: Record<string, string> = {}
  const stale: string[] = []
  const now = Date.now()
  for (const id of unique) {
    const cached = titlesCache.get(id)
    if (cached && now - cached.at < TITLES_CACHE_TTL_MS) out[id] = cached.title
    else stale.push(id)
  }
  if (stale.length === 0) return out

  try {
    const dbPath = await getOpenCodeDbPath()
    if (!dbPath) return out

    const db = new Database(dbPath, { readonly: true })
    try {
      // bun:sqlite의 동기 busy 대기가 이벤트 루프를 막는 것을 방지한다.
      db.exec('PRAGMA busy_timeout = 200')
      const placeholders = stale.map(() => '?').join(',')
      const rows = db
        .prepare(`SELECT id, title FROM session WHERE id IN (${placeholders})`)
        .all(...stale) as { id: string; title: string | null }[]
      for (const row of rows) {
        const title = row.title || 'Untitled Session'
        out[row.id] = title
        titlesCache.set(row.id, { title, at: now })
      }
      // 조회 실패한 것도 짧게 기록해 반복 시도를 줄인다
      for (const id of stale) {
        if (!out[id]) {
          titlesCache.set(id, { title: 'Untitled Session', at: now })
          out[id] = 'Untitled Session'
        }
      }
      return out
    } finally {
      db.close()
    }
  } catch (error) {
    logger.warn('Failed to read opencode session titles:', error)
    return out
  }
}

/** 세션별 마지막 어시스턴트 텍스트 응답 스니펫을 조회한다(커맨드 히스토리 프리뷰용). */
const PREVIEW_CACHE_TTL_MS = 60_000
const previewCache = new Map<string, { text: string | null; at: number }>()

export async function getSessionResponsePreviews(
  sessionIds: string[],
  maxLen = 220,
): Promise<Record<string, string>> {
  const now = Date.now()
  const unique = [...new Set(sessionIds)].filter(Boolean).slice(0, 40)
  if (unique.length === 0) return {}

  const out: Record<string, string> = {}
  const stale: string[] = []
  for (const id of unique) {
    const cached = previewCache.get(id)
    if (cached && now - cached.at < PREVIEW_CACHE_TTL_MS && cached.text) {
      out[id] = cached.text
    } else {
      stale.push(id)
    }
  }
  if (stale.length === 0) return out

  try {
    const dbPath = await getOpenCodeDbPath()
    if (!dbPath) return out

    const db = new Database(dbPath, { readonly: true })
    try {
      db.exec('PRAGMA busy_timeout = 200')
      const stmt = db.prepare(`
        SELECT p.data AS part_data
        FROM message m
        JOIN part p ON p.message_id = m.id
        WHERE m.session_id = ? AND m.data LIKE '%"role":"assistant"%'
        ORDER BY m.time_created DESC, p.time_created DESC
        LIMIT 30
      `)

      for (const sessionId of stale) {
        let resolved: string | null = null
        try {
          const rows = stmt.all(sessionId) as { part_data: string }[]
          for (const row of rows) {
            try {
              const parsed = JSON.parse(row.part_data) as { type?: string; text?: unknown }
              if (parsed.type !== 'text' || typeof parsed.text !== 'string') continue
              const text = parsed.text.replace(/\s+/g, ' ').trim()
              if (!text) continue
              resolved = text.slice(0, maxLen) + (text.length > maxLen ? '…' : '')
              break
            } catch {
              continue
            }
          }
        } catch {
          continue
        }
        previewCache.set(sessionId, { text: resolved, at: now })
        if (resolved) out[sessionId] = resolved
      }
      return out
    } finally {
      db.close()
    }
  } catch (error) {
    logger.warn('Failed to read opencode response previews:', error)
    return out
  }
}

/** opencode 세션 트리에서 parent의 자식(서브세션) id를 재귀적으로 수집한다. */
const DESCENDANT_CACHE_TTL_MS = 10_000
const descendantCache = new Map<string, { ids: Set<string>; at: number }>()

export async function getDescendantSessionIds(rootIds: string[]): Promise<Set<string>> {
  const roots = [...new Set(rootIds)].filter(Boolean)
  const result = new Set<string>()
  if (roots.length === 0) return result

  const cacheKey = [...roots].sort().join(',')
  const cached = descendantCache.get(cacheKey)
  if (cached && Date.now() - cached.at < DESCENDANT_CACHE_TTL_MS) return cached.ids

  try {
    const dbPath = await getOpenCodeDbPath()
    if (!dbPath) return result

    const db = new Database(dbPath, { readonly: true })
    try {
      let frontier = [...roots]
      while (frontier.length > 0) {
        const placeholders = frontier.map(() => '?').join(',')
        const rows = db
          .prepare(`SELECT id, parent_id FROM session WHERE parent_id IN (${placeholders})`)
          .all(...frontier) as SessionRow[]
        frontier = rows.map((r) => r.id).filter((id) => !result.has(id))
        for (const id of frontier) result.add(id)
        if (result.size > 5000) break
      }
    } finally {
      db.close()
    }
    // 실행 중 폴링이 이 조회를 반복하지 않도록 짧게 캐시한다.
    descendantCache.set(cacheKey, { ids: result, at: Date.now() })
    return result
  } catch (error) {
    logger.warn('Failed to read opencode child sessions:', error)
    return result
  }
}
