import type { Database } from 'bun:sqlite'
import type { Schedule, CreateScheduleInput, UpdateScheduleInput } from '../types/schedule'

interface ScheduleRow {
  id: number
  repo_id: number
  name: string
  action: string
  command: string | null
  prompt: string | null
  cron: string
  enabled: number
  last_run_at: number | null
  created_at: number
  updated_at: number
}

function rowToSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    repoId: row.repo_id,
    name: row.name,
    action: row.action as Schedule['action'],
    command: row.command ?? undefined,
    prompt: row.prompt ?? undefined,
    cron: row.cron,
    enabled: Boolean(row.enabled),
    lastRunAt: row.last_run_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listSchedules(db: Database, repoId?: number): Schedule[] {
  const stmt = repoId
    ? db.prepare('SELECT * FROM schedules WHERE repo_id = ? ORDER BY created_at DESC')
    : db.prepare('SELECT * FROM schedules ORDER BY created_at DESC')
  const rows = repoId ? stmt.all(repoId) : stmt.all()
  return (rows as ScheduleRow[]).map(rowToSchedule)
}

export function getScheduleById(db: Database, id: number): Schedule | null {
  const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined
  return row ? rowToSchedule(row) : null
}

export function createSchedule(db: Database, input: CreateScheduleInput): Schedule {
  const now = Date.now()
  const result = db.prepare(`
    INSERT INTO schedules (repo_id, name, action, command, prompt, cron, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.repoId,
    input.name,
    input.action,
    input.command ?? null,
    input.prompt ?? null,
    input.cron,
    input.enabled === false ? 0 : 1,
    now,
    now,
  )

  const schedule = getScheduleById(db, Number(result.lastInsertRowid))
  if (!schedule) {
    throw new Error('Failed to retrieve created schedule')
  }
  return schedule
}

export function updateSchedule(db: Database, id: number, input: UpdateScheduleInput): Schedule | null {
  const existing = getScheduleById(db, id)
  if (!existing) return null

  db.prepare(`
    UPDATE schedules
    SET name = ?, action = ?, command = ?, prompt = ?, cron = ?, enabled = ?, updated_at = ?
    WHERE id = ?
  `).run(
    input.name ?? existing.name,
    input.action ?? existing.action,
    (input.command !== undefined ? input.command : existing.command) ?? null,
    (input.prompt !== undefined ? input.prompt : existing.prompt) ?? null,
    input.cron ?? existing.cron,
    input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled,
    Date.now(),
    id,
  )

  return getScheduleById(db, id)
}

export function deleteSchedule(db: Database, id: number): void {
  db.prepare('DELETE FROM schedules WHERE id = ?').run(id)
}

export function listEnabledSchedules(db: Database): Schedule[] {
  const rows = db.prepare('SELECT * FROM schedules WHERE enabled = 1').all() as ScheduleRow[]
  return rows.map(rowToSchedule)
}

export function markScheduleRun(db: Database, id: number): void {
  db.prepare('UPDATE schedules SET last_run_at = ? WHERE id = ?').run(Date.now(), id)
}
