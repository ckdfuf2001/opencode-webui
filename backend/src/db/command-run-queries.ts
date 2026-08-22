import type { Database } from 'bun:sqlite'

export type CommandRunStatus = 'started' | 'completed' | 'failed' | 'cancelled'
export type CommandRunOrigin = 'ui' | 'schedule'

export interface CommandRun {
  id: string
  sessionId: string
  repoId: number | null
  commandName: string
  args: string | null
  directory: string | null
  messageId: string | null
  status: CommandRunStatus
  origin: CommandRunOrigin
  startedAt: number
  finishedAt: number | null
  createdAt: number
}

/** 호출자(라우트/스케줄러)가 서비스에 넘기는 값. id·startedAt·origin은 서비스가 결정한다. */
export interface CreateCommandRunInput {
  sessionId: string
  commandName: string
  args?: string | null
  directory?: string | null
  repoId?: number | null
}

/** 서비스가 완성해서 쿼리 계층에 넘기는 레코드. 이 계층은 값을 만들지 않는다. */
export interface InsertCommandRunRow extends CreateCommandRunInput {
  id: string
  startedAt: number
  origin: CommandRunOrigin
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
  origin: string
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
    status: row.status as CommandRunStatus,
    origin: (row.origin ?? 'ui') as CommandRunOrigin,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  }
}

export function insertCommandRun(db: Database, row: InsertCommandRunRow): CommandRun {
  db.prepare(`
    INSERT INTO command_runs
      (id, session_id, repo_id, command_name, args, directory, status, origin, started_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'started', ?, ?, ?)
  `).run(
    row.id,
    row.sessionId,
    row.repoId ?? null,
    row.commandName,
    row.args ?? null,
    row.directory ?? null,
    row.origin,
    row.startedAt,
    Date.now(),
  )

  const inserted = db
    .prepare('SELECT * FROM command_runs WHERE id = ?')
    .get(row.id) as CommandRunRow | undefined

  if (!inserted) throw new Error(`Failed to insert command run ${row.id}`)
  return rowToRun(inserted)
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

export function listCommandRunsByRange(
  db: Database, fromTs: number, toTs: number, limit = 2000,
): CommandRun[] {
  const rows = db.prepare(
    `SELECT * FROM command_runs
     WHERE started_at >= ? AND started_at <= ?
     ORDER BY started_at DESC LIMIT ?`
  ).all(fromTs, toTs, limit) as CommandRunRow[]
  return rows.map(rowToRun)
}

export function getCommandRunById(db: Database, id: string): CommandRun | null {
  const row = db
    .prepare('SELECT * FROM command_runs WHERE id = ?')
    .get(id) as CommandRunRow | undefined
  return row ? rowToRun(row) : null
}

export function updateCommandRunMessage(db: Database, id: string, messageId: string): void {
  db.prepare('UPDATE command_runs SET message_id = ? WHERE id = ? AND message_id IS NULL')
    .run(messageId, id)
}

export function markCommandRunFinished(db: Database, id: string, status: Exclude<CommandRunStatus, 'started'>): void {
  db.prepare("UPDATE command_runs SET status = ?, finished_at = ? WHERE id = ? AND status = 'started'")
    .run(status, Date.now(), id)
}

export function deleteCommandRun(db: Database, id: string): void {
  db.prepare('DELETE FROM command_runs WHERE id = ?').run(id)
}

export function clearSessionCommandRuns(db: Database, sessionId: string): void {
  db.prepare('DELETE FROM command_runs WHERE session_id = ?').run(sessionId)
}
