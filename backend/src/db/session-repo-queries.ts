import type { Database } from 'bun:sqlite'

/**
 * sessionId → repoId 정본 매핑 (S1).
 * opencode 세션 directory와 무관하게 세션의 소속 레포를 기록한다.
 * - 생성 시 1회 기록(first-write-wins): 세션은 레포를 옮기지 않는다.
 * - 기존 세션은 부팅 백필(현재 directory 역산)이 채운다.
 */

export function getSessionRepo(db: Database, sessionId: string): number | null {
  try {
    const row = db.prepare('SELECT repo_id FROM session_repo_map WHERE session_id = ?')
      .get(sessionId) as { repo_id?: number | null } | undefined
    return typeof row?.repo_id === 'number' ? row.repo_id : null
  } catch {
    return null
  }
}

/** 세션 생성 시 1회 기록. 이미 있으면 건드리지 않는다. 성공 시 true. */
export function setSessionRepoIfAbsent(db: Database, sessionId: string, repoId: number): boolean {
  if (!sessionId || !Number.isInteger(repoId) || repoId <= 0) return false
  try {
    const result = db.prepare(
      'INSERT INTO session_repo_map (session_id, repo_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO NOTHING'
    ).run(sessionId, repoId, Date.now())
    return Number(result.changes ?? 0) > 0
  } catch {
    return false
  }
}

export function deleteSessionRepo(db: Database, sessionId: string): void {
  try {
    db.prepare('DELETE FROM session_repo_map WHERE session_id = ?').run(sessionId)
  } catch {}
}

export function deleteSessionRepoMapsByRepo(db: Database, repoId: number): number {
  try {
    return db.prepare('DELETE FROM session_repo_map WHERE repo_id = ?').run(repoId).changes as number
  } catch {
    return 0
  }
}

export function countSessionRepoMaps(db: Database): number {
  try {
    const row = db.prepare('SELECT COUNT(*) AS c FROM session_repo_map').get() as { c?: number } | undefined
    return Number(row?.c ?? 0)
  } catch {
    return 0
  }
}
