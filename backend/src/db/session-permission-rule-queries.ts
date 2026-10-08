import type { Database } from 'bun:sqlite'

export interface SessionPermissionRule {
  id: string
  sessionId: string
  permission: string
  pattern: string
  createdAt: number
}

interface SessionPermissionRuleRow {
  id: string
  session_id: string
  permission: string
  pattern: string
  created_at: number
}

function rowToRule(row: SessionPermissionRuleRow): SessionPermissionRule {
  return {
    id: row.id,
    sessionId: row.session_id,
    permission: row.permission,
    pattern: row.pattern,
    createdAt: row.created_at,
  }
}

function newRuleId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function listSessionPermissionRules(db: Database, sessionId: string): SessionPermissionRule[] {
  const rows = db
    .prepare('SELECT * FROM session_permission_rules WHERE session_id = ? ORDER BY created_at DESC')
    .all(sessionId) as SessionPermissionRuleRow[]
  return rows.map(rowToRule)
}

export function createSessionPermissionRule(
  db: Database,
  input: { sessionId: string; permission: string; pattern: string },
): SessionPermissionRule {
  const existing = db
    .prepare('SELECT * FROM session_permission_rules WHERE session_id = ? AND permission = ? AND pattern = ?')
    .get(input.sessionId, input.permission, input.pattern) as SessionPermissionRuleRow | undefined
  if (existing) return rowToRule(existing)
  const id = newRuleId()
  const now = Date.now()
  db.prepare(
    'INSERT INTO session_permission_rules (id, session_id, permission, pattern, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, input.sessionId, input.permission, input.pattern, now)
  return { id, sessionId: input.sessionId, permission: input.permission, pattern: input.pattern, createdAt: now }
}

export function deleteSessionPermissionRule(db: Database, id: string): boolean {
  return db.prepare('DELETE FROM session_permission_rules WHERE id = ?').run(id).changes > 0
}

/** 세션 삭제 시 orphan 정리. */
export function deleteSessionPermissionRulesBySession(db: Database, sessionId: string): number {
  return db.prepare('DELETE FROM session_permission_rules WHERE session_id = ?').run(sessionId).changes
}
