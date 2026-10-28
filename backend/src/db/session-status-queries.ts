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
  // isCancelled 미전달 시 기존 값 보존 — 폴러가 busy 갱신으로 cancelled 배지를 지우지 않게
  if (row.isCancelled === undefined) {
    const existing = db.prepare('SELECT is_cancelled FROM session_status WHERE session_id = ?').get(row.sessionId) as { is_cancelled?: number } | undefined
    const keep = existing?.is_cancelled ?? 0
    db.prepare(`
      INSERT INTO session_status (session_id, directory, repo_id, status, pending_permissions, is_cancelled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        directory = excluded.directory,
        repo_id = excluded.repo_id,
        status = excluded.status,
        pending_permissions = excluded.pending_permissions,
        is_cancelled = ?,
        updated_at = excluded.updated_at
    `).run(row.sessionId, row.directory, row.repoId, row.status, row.pendingPermissions, keep, row.updatedAt, keep)
    return
  }
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

export interface PartOrphan {
  sessionId: string
  messageId: string
  partId: string
  tool: string
  command: string
  observedAt: number
}

/**
 * B0-6: opencode idle인데 part가 running으로 남은 고아 표시.
 * opencode 데이터가 아니라 우리 DB에만 적는다.
 */
export function markPartOrphan(db: Database, orphan: Omit<PartOrphan, 'observedAt'> & { observedAt?: number }): void {
  db.prepare(
    `INSERT INTO reconcile_orphans (session_id, message_id, part_id, tool, command, observed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, part_id) DO UPDATE SET observed_at = excluded.observed_at`,
  ).run(orphan.sessionId, orphan.messageId, orphan.partId, orphan.tool, orphan.command, orphan.observedAt ?? Date.now())
}

export function clearPartOrphan(db: Database, sessionId: string, partId: string): void {
  db.prepare('DELETE FROM reconcile_orphans WHERE session_id = ? AND part_id = ?').run(sessionId, partId)
}

export function isPartOrphanMarked(db: Database, sessionId: string, partId: string): boolean {
  const row = db.prepare('SELECT session_id FROM reconcile_orphans WHERE session_id = ? AND part_id = ?')
    .get(sessionId, partId) as { session_id?: string } | undefined
  return !!row
}

/** 세션별 orphan part id 목록 (GET /api/session-status 응답에 동봉). */
export function listPartOrphansBySession(db: Database): Map<string, string[]> {
  const out = new Map<string, string[]>()
  try {
    const rows = db.prepare('SELECT session_id, part_id FROM reconcile_orphans').all() as Array<{
      session_id: string
      part_id: string
    }>
    for (const r of rows) {
      const list = out.get(r.session_id) ?? []
      list.push(r.part_id)
      out.set(r.session_id, list)
    }
  } catch {
    /* 테이블 미생성 DB(구버전)에서는 빈 목록 */
  }
  return out
}

/** 오래된 orphan 표시 정리(7일). */
export function prunePartOrphans(db: Database, olderThanMs: number, now: number): void {
  try {
    db.prepare('DELETE FROM reconcile_orphans WHERE observed_at < ?').run(now - olderThanMs)
  } catch {
    /* 테이블 미생성 DB(구버전)에서는 무시 */
  }
}
