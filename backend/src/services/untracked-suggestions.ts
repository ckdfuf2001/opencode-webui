import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Database, SQLQueryBindings } from 'bun:sqlite'

export interface UntrackedSuggestion {
  id: string
  repoId: number | null
  directory: string | null
  commandName: string
  filePath: string
  trackPath: string
  status: string
  runId: string | null
  createdAt: number
  decidedAt: number | null
}

/**
 * 절대 경로 targetPath 가 repo(directory) 안에 있으면 repo 기준 최상위 트랙 세그먼트를
 * 반환한다. directory 밖(전역 config 등)이면 null.
 * e.g. <repo>/commands/foo.md -> "commands", <repo>/skills/bar/SKILL.md -> "skills"
 */
export function deriveTrackPath(targetPath: string, directory: string | null): string | null {
  if (!targetPath) return null
  const abs = path.resolve(targetPath)
  if (directory) {
    const dir = path.resolve(directory)
    const rel = path.relative(dir, abs)
    if (rel === '' || path.isAbsolute(rel) || rel.startsWith('..')) return null
    const seg = rel.split(/[\\/]/)[0]
    return seg || null
  }
  return null
}

export interface CreateSuggestionInput {
  repoId: number | null
  directory: string | null
  commandName: string
  filePath: string
  trackPath: string
  runId: string
}

/** 동일 파일에 대한 최근 pending 제안이 있으면 스킵(내부 dedup)하고, 없으면 삽입한다. */
export async function createSuggestion(db: Database, input: CreateSuggestionInput): Promise<void> {
  const existing = db
    .query(
      `SELECT id FROM untracked_suggestions
       WHERE file_path = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.filePath) as { id: string } | undefined
  if (existing) return

  db.query(
    `INSERT INTO untracked_suggestions
       (id, repo_id, directory, command_name, file_path, track_path, status, run_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    randomUUID(),
    input.repoId,
    input.directory,
    input.commandName,
    input.filePath,
    input.trackPath,
    input.runId,
    Date.now(),
  )
}

export function listSuggestions(
  db: Database,
  opts: { repoId?: number; status?: string } = {},
): UntrackedSuggestion[] {
  const where: string[] = []
  const params: SQLQueryBindings[] = []
  if (opts.repoId != null) {
    where.push('repo_id = ?')
    params.push(opts.repoId)
  }
  if (opts.status) {
    where.push('status = ?')
    params.push(opts.status)
  }
  const sql = `SELECT * FROM untracked_suggestions${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`
  return (db.query(sql).all(...params) as any[]).map(toSuggestion)
}

export function getSuggestionById(db: Database, id: string): UntrackedSuggestion | null {
  const row = db.query('SELECT * FROM untracked_suggestions WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? toSuggestion(row) : null
}

export function updateSuggestionStatus(db: Database, id: string, status: string): boolean {
  const res = db
    .query('UPDATE untracked_suggestions SET status = ?, decided_at = ? WHERE id = ?')
    .run(status, Date.now(), id)
  return Number((res as { changes?: number }).changes ?? 0) > 0
}

function toSuggestion(row: Record<string, unknown>): UntrackedSuggestion {
  return {
    id: row.id as string,
    repoId: row.repo_id as number | null,
    directory: row.directory as string | null,
    commandName: row.command_name as string,
    filePath: row.file_path as string,
    trackPath: row.track_path as string,
    status: row.status as string,
    runId: row.run_id as string | null,
    createdAt: row.created_at as number,
    decidedAt: row.decided_at as number | null,
  }
}
