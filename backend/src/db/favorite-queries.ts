import type { Database } from 'bun:sqlite'
import { logger } from '../utils/logger'

export interface FavoriteSession {
  sessionId: string
  repoId: number | null
  directory: string
  title: string
  createdAt: number
  updatedAt: number
}

interface Row {
  session_id: string
  repo_id: number | null
  directory: string
  title: string
  created_at: number
  updated_at: number
}

function toRow(r: Row): FavoriteSession {
  return {
    sessionId: r.session_id,
    repoId: r.repo_id,
    directory: r.directory,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function listFavorites(db: Database): FavoriteSession[] {
  const rows = db.prepare('SELECT session_id, repo_id, directory, title, created_at, updated_at FROM favorites ORDER BY updated_at DESC').all() as Row[]
  return rows.map(toRow)
}

export function getFavorite(db: Database, sessionId: string): FavoriteSession | null {
  const row = db.prepare('SELECT session_id, repo_id, directory, title, created_at, updated_at FROM favorites WHERE session_id = ?').get(sessionId) as Row | undefined
  return row ? toRow(row) : null
}

export function upsertFavorite(db: Database, input: { sessionId: string; repoId?: number | null; directory?: string; title?: string }): FavoriteSession {
  const sid = input.sessionId?.trim()
  if (!sid) throw Object.assign(new Error('sessionId required'), { statusCode: 400 })
  const now = Date.now()
  const existing = db.prepare('SELECT created_at FROM favorites WHERE session_id = ?').get(sid) as { created_at: number } | undefined
  const createdAt = existing?.created_at ?? now
  const title = (input.title ?? sid).trim().slice(0, 200) || sid
  const directory = (input.directory ?? '').trim().slice(0, 1024)
  const repoId = input.repoId ?? null
  db.prepare(`
    INSERT INTO favorites (session_id, repo_id, directory, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET repo_id=excluded.repo_id, directory=excluded.directory, title=excluded.title, updated_at=excluded.updated_at
  `).run(sid, repoId, directory, title, createdAt, now)
  logger.info(`Favorite upsert: ${sid}`)
  return { sessionId: sid, repoId, directory, title, createdAt, updatedAt: now }
}

export function deleteFavorite(db: Database, sessionId: string): boolean {
  const r = db.prepare('DELETE FROM favorites WHERE session_id = ?').run(sessionId)
  return r.changes > 0
}
