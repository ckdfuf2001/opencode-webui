import type { Database } from 'bun:sqlite'

export interface CommandRun {
  id: string
  sessionId: string
  repoId: number | null
  commandName: string
  args: string | null
  directory: string | null
  messageId: string | null
  status: 'started' | 'completed' | 'failed' | 'cancelled'
  startedAt: number
  finishedAt: number | null
  createdAt: number
}

export interface CreateCommandRunInput {
  id: string
  sessionId: string
  repoId?: number | null
  commandName: string
  args?: string | null
  directory?: string | null
  startedAt: number
}

interface CommandRunRow {
  id: string
  session_id: string
  repo_id: number | null
  command_name: string
  args: string | null
  directory: string | null
  message_id: string | null
  status: string
  started_at: number
  finished_at: number | null
  created_at: number
}

function rowToRun(row: CommandRunRow): CommandRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    repoId: row.repo_id,
    commandName: row.command_name,
    args: row.args,
    directory: row.directory,
    messageId: row.message_id,
    status: row.status as CommandRun['status'],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  }
}

export function createCommandRun(db: Database, input: CreateCommandRunInput): CommandRun {
  db.prepare(`
    INSERT INTO command_runs (id, session_id, repo_id, command_name, args, directory, status, started_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'started', ?, ?)
  `).run(
    input.id,
    input.sessionId,
    input.repoId ?? null,
    input.commandName,
    input.args ?? null,
    input.directory ?? null,
    input.startedAt,
    Date.now(),
  )
  const row = db.prepare('SELECT * FROM command_runs WHERE id = ?').get(input.id) as CommandRunRow
  return rowToRun(row)
}

export function listCommandRunsBySession(db: Database, sessionId: string, limit = 200): CommandRun[] {
  const rows = db.prepare(
    'SELECT * FROM command_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT ?'
  ).all(sessionId, limit) as CommandRunRow[]
  return rows.map(rowToRun)
}

export function listCommandRunsByRepo(db: Database, repoId: number, limit = 500): CommandRun[] {
  const rows = db.prepare(
    'SELECT * FROM command_runs WHERE repo_id = ? ORDER BY started_at DESC LIMIT ?'
  ).all(repoId, limit) as CommandRunRow[]
  return rows.map(rowToRun)
}

export function updateCommandRunMessage(db: Database, id: string, messageId: string): void {
  db.prepare('UPDATE command_runs SET message_id = ? WHERE id = ? AND message_id IS NULL').run(messageId, id)
}

export function markCommandRunFinished(
  db: Database,
  id: string,
  status: 'completed' | 'failed' | 'cancelled',
): void {
  db.prepare('UPDATE command_runs SET status = ?, finished_at = ? WHERE id = ?').run(status, Date.now(), id)
}

export function deleteCommandRun(db: Database, id: string): void {
  db.prepare('DELETE FROM command_runs WHERE id = ?').run(id)
}

export function clearSessionCommandRuns(db: Database, sessionId: string): void {
  db.prepare('DELETE FROM command_runs WHERE session_id = ?').run(sessionId)
}
