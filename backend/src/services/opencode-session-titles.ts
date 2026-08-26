import { Database } from 'bun:sqlite'
import { getOpenCodeDbPath } from './opencode-db'
import { logger } from '../utils/logger'

interface SessionRow {
  id: string
  title: string | null
  parent_id: string | null
}

/** opencode 로컬 DB에서 세션 제목을 조회한다. 실패 시 빈 map(타이틀 미확정)으로 폴백한다. */
export async function getSessionTitles(ids: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids)].filter(Boolean)
  if (unique.length === 0) return {}

  try {
    const dbPath = await getOpenCodeDbPath()
    if (!dbPath) return {}

    const db = new Database(dbPath, { readonly: true })
    try {
      const placeholders = unique.map(() => '?').join(',')
      const rows = db
        .prepare(`SELECT id, title FROM session WHERE id IN (${placeholders})`)
        .all(...unique) as { id: string; title: string | null }[]
      const out: Record<string, string> = {}
      for (const row of rows) out[row.id] = row.title || 'Untitled Session'
      return out
    } finally {
      db.close()
    }
  } catch (error) {
    logger.warn('Failed to read opencode session titles:', error)
    return {}
  }
}

/** opencode 세션 트리에서 parent의 자식(서브세션) id를 재귀적으로 수집한다. */
export async function getDescendantSessionIds(rootIds: string[]): Promise<Set<string>> {
  const roots = [...new Set(rootIds)].filter(Boolean)
  const result = new Set<string>()
  if (roots.length === 0) return result

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
      return result
    } finally {
      db.close()
    }
  } catch (error) {
    logger.warn('Failed to read opencode child sessions:', error)
    return result
  }
}
