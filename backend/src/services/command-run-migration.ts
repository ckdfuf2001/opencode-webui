import { mkdirSync, existsSync } from 'fs'
import type { Database } from 'bun:sqlite'
import type { CommandRun, CommandRunOrigin, CommandRunStatus } from '../db/command-run-queries'
import { appendToDir, listExistingRunIds, resolveHistoryDir } from './command-run-store'
import { getReposPath } from '@opencode-webui/shared'
import { logger } from '../utils/logger'

const META_TABLE = 'app_meta'
const MIGRATED_FLAG = 'command_runs.file_migrated'

interface CommandRunRow {
  id: string
  session_id: string
  repo_id: number | null
  command_name: string
  args: string | null
  directory: string | null
  message_id: string | null
  status: string
  origin: string | null
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

/**
 * command_runs 테이블의 기존 이력을 레포별 run_history jsonl 로 옮긴다(1회).
 * 플래그는 app_meta 에 저장하며, 테이블은 Step 3 까지 이중 쓰기 대상으로 유지된다.
 */
export async function migrateCommandRunsToFiles(db: Database): Promise<number> {
  db.run(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT)`)

  const flag = db.prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`).get(MIGRATED_FLAG) as
    | { value: string }
    | undefined
  if (flag?.value === '1') return 0

  const rows = db
    .prepare('SELECT * FROM command_runs ORDER BY started_at ASC')
    .all() as unknown as CommandRunRow[]

  const existingIds = await listExistingRunIds(db)

  let migrated = 0
  let skipped = 0
  for (const row of rows) {
    if (existingIds.has(row.id)) {
      skipped++
      continue
    }
    // 레포가 삭제된 실행 이력은 파일로 옮기지 않는다(삭제와 운명 일치 원칙).
    if (row.directory && existsSync(row.directory) === false) {
      skipped++
      continue
    }
    const run = rowToRun(row)
    try {
      const dir = resolveHistoryDir(db, run.directory, run.repoId)
      mkdirSync(dir, { recursive: true })
      await appendToDir(dir, run)
      existingIds.add(run.id)
      migrated++
    } catch (error) {
      logger.warn(`Failed to migrate command run ${row.id} to run_history:`, error)
    }
  }

  db.prepare(
    `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(MIGRATED_FLAG, '1')

  logger.info(`Command runs migration to run_history complete: ${migrated} migrated, ${skipped} already present`)
  return migrated
}
