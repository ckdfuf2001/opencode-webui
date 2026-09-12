import type { Database } from 'bun:sqlite'

export type SessionStatus = 'busy' | 'idle'

export interface SessionStatusRow {
  sessionId: string
  directory: string
  repoId: number | null
  status: SessionStatus
  pendingPermissions: number
  isCancelled: boolean
  updatedAt: number
}

interface SessionStatusRowInternal {
  session_id: string
  directory: string
  repo_id: number | null
  status: string
  pending_permissions: number
  is_cancelled: number
  updated_at: number
}

function rowToStatus(row: SessionStatusRowInternal): SessionStatusRow {
  return {
    sessionId: row.session_id,
    directory: row.directory,
    repoId: row.repo_id,
    status: (row.status === 'busy' ? 'busy' : 'idle') as SessionStatus,
    pendingPermissions: row.pending_permissions ?? 0,
    isCancelled: !!row.is_cancelled,
    updatedAt: row.updated_at,
  }
}

export function upsertSessionStatus(
  db: Database,
  row: {
    sessionId: string
    directory: string
    repoId: number | null
    status: SessionStatus
    pendingPermissions: number
    isCancelled?: boolean
    updatedAt: number
  },
): void {
  const isCancelledInt = row.isCancelled ? 1 : 0
  db.prepare(`
    INSERT INTO session_status (session_id, directory, repo_id, status, pending_permissions, is_cancelled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      directory = excluded.directory,
      repo_id = excluded.repo_id,
      status = excluded.status,
      pending_permissions = excluded.pending_permissions,
      is_cancelled = excluded.is_cancelled,
      updated_at = excluded.updated_at
  `).run(row.sessionId, row.directory, row.repoId, row.status, row.pendingPermissions, isCancelledInt, row.updatedAt)
}

export function listSessionStatus(db: Database): SessionStatusRow[] {
  const rows = db.prepare('SELECT * FROM session_status').all() as SessionStatusRowInternal[]
  return rows.map(rowToStatus)
}

export function listBusySessionStatus(db: Database): SessionStatusRow[] {
  const rows = db.prepare("SELECT * FROM session_status WHERE status = 'busy'").all() as SessionStatusRowInternal[]
  return rows.map(rowToStatus)
}

export function markSessionStatusIdle(db: Database, sessionId: string, updatedAt: number): void {
  db.prepare("UPDATE session_status SET status = 'idle', updated_at = ? WHERE session_id = ?")
    .run(updatedAt, sessionId)
}

export function setSessionCancelled(db: Database, sessionId: string): void {
  db.prepare("UPDATE session_status SET is_cancelled = 1, updated_at = ? WHERE session_id = ?")
    .run(Date.now(), sessionId)
  // row가 없으면 생성 (idle + cancelled)
  const row = db.prepare('SELECT session_id FROM session_status WHERE session_id = ?').get(sessionId) as { session_id?: string } | undefined
  if (!row) {
    const now = Date.now()
    db.prepare(`
      INSERT INTO session_status (session_id, directory, repo_id, status, pending_permissions, is_cancelled, updated_at)
      VALUES (?, 'global', NULL, 'idle', 0, 1, ?)
      ON CONFLICT(session_id) DO UPDATE SET is_cancelled = 1, updated_at = ?
    `).run(sessionId, now, now)
  }
}

export function clearSessionCancelled(db: Database, sessionId: string): void {
  db.prepare("UPDATE session_status SET is_cancelled = 0, updated_at = ? WHERE session_id = ?")
    .run(Date.now(), sessionId)
}

export function getSessionStatusRow(db: Database, sessionId: string): SessionStatusRow | null {
  const row = db.prepare('SELECT * FROM session_status WHERE session_id = ?')
    .get(sessionId) as SessionStatusRowInternal | undefined
  return row ? rowToStatus(row) : null
}

export function deleteSessionStatus(db: Database, sessionId: string): void {
  db.prepare('DELETE FROM session_status WHERE session_id = ?').run(sessionId)
}

/** 오래된 idle 행 정리(30일). busy 행은 건드리지 않는다. */
export function pruneIdleSessionStatus(db: Database, olderThanMs: number, now: number): void {
  db.prepare("DELETE FROM session_status WHERE status = 'idle' AND updated_at < ?")
    .run(now - olderThanMs)
}
