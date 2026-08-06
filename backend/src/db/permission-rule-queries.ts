import type { Database } from 'bun:sqlite'
import type { PermissionRule, CreatePermissionRuleInput } from '../types/permission-rule'

interface PermissionRuleRow {
  id: number
  repo_id: number
  permission: string
  pattern: string
  created_at: number
}

function rowToPermissionRule(row: PermissionRuleRow): PermissionRule {
  return {
    id: row.id,
    repoId: row.repo_id,
    permission: row.permission,
    pattern: row.pattern,
    createdAt: row.created_at,
  }
}

export function listPermissionRules(db: Database, repoId?: number): PermissionRule[] {
  const stmt = repoId
    ? db.prepare('SELECT * FROM permission_rules WHERE repo_id = ? ORDER BY created_at DESC')
    : db.prepare('SELECT * FROM permission_rules ORDER BY created_at DESC')
  const rows = repoId ? stmt.all(repoId) : stmt.all()
  return (rows as PermissionRuleRow[]).map(rowToPermissionRule)
}

export function getPermissionRuleById(db: Database, id: number): PermissionRule | null {
  const row = db.prepare('SELECT * FROM permission_rules WHERE id = ?').get(id) as PermissionRuleRow | undefined
  return row ? rowToPermissionRule(row) : null
}

export function createPermissionRule(db: Database, input: CreatePermissionRuleInput): PermissionRule {
  const existing = db.prepare(
    'SELECT * FROM permission_rules WHERE repo_id = ? AND permission = ? AND pattern = ?'
  ).get(input.repoId, input.permission, input.pattern) as PermissionRuleRow | undefined
  if (existing) {
    return rowToPermissionRule(existing)
  }

  const result = db.prepare(
    'INSERT INTO permission_rules (repo_id, permission, pattern, created_at) VALUES (?, ?, ?, ?)'
  ).run(input.repoId, input.permission, input.pattern, Date.now())

  const rule = getPermissionRuleById(db, Number(result.lastInsertRowid))
  if (!rule) {
    throw new Error('Failed to retrieve created permission rule')
  }
  return rule
}

export function deletePermissionRule(db: Database, id: number): boolean {
  const result = db.prepare('DELETE FROM permission_rules WHERE id = ?').run(id)
  return result.changes > 0
}
