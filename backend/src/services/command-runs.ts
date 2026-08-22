import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import * as crDb from '../db/command-run-queries'
import type {
  CommandRun,
  CommandRunOrigin,
  CommandRunStatus,
  CreateCommandRunInput,
} from '../db/command-run-queries'
import { listRepos } from '../db/queries'
import { firePreCommandHooks, firePostCommandHooks } from './command-hooks'
import { logger } from '../utils/logger'

/** 슬래시 방향과 끝 슬래시를 정규화한다. Windows 경로 비교를 위해 필요. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * 실행 디렉토리로 repo 를 역추적한다.
 * Repo.fullPath 는 rowToRepo() 에서 path.join(getReposPath(), local_path) 로 계산되며,
 * scheduler 가 directory 를 만드는 방식과 동일하므로 정확히 일치한다.
 * fullPath 가 맞지 않으면 localPath suffix 로 한 번 더 시도한다(하위 디렉토리 대응).
 */
export function resolveRepoId(db: Database, directory?: string | null): number | null {
  if (!directory) return null
  const target = normalizePath(directory)
  if (!target) return null

  const repos = listRepos(db)

  // 1차: fullPath 정확 일치 (Windows 대소문자 무시)
  for (const repo of repos) {
    if (!repo.fullPath) continue
    if (target.toLowerCase() === normalizePath(repo.fullPath).toLowerCase()) {
      return repo.id
    }
  }

  // 2차: localPath suffix 일치. 가장 긴 것을 택해 "app" vs "app/web" 모호성을 해소한다.
  let bestId: number | null = null
  let bestLength = -1
  const lowered = target.toLowerCase()

  for (const repo of repos) {
    const local = normalizePath(repo.localPath ?? '').toLowerCase()
    if (!local) continue
    if ((lowered === local || lowered.endsWith(`/${local}`)) && local.length > bestLength) {
      bestId = repo.id
      bestLength = local.length
    }
  }

  return bestId
}

export interface RecordRunStartInput extends CreateCommandRunInput {
  origin: CommandRunOrigin
}

/**
 * run 시작을 기록한다. id / startedAt 은 서버가 생성하므로
 * 클라이언트 시계가 어긋나도 달력 날짜가 밀리지 않는다.
 * repoId 가 없으면 directory 로 해석해 채운다.
 */
export function recordRunStart(db: Database, input: RecordRunStartInput): CommandRun {
  const repoId = input.repoId ?? resolveRepoId(db, input.directory)

  const run = crDb.insertCommandRun(db, {
    id: randomUUID(),
    startedAt: Date.now(),
    origin: input.origin,
    sessionId: input.sessionId,
    commandName: input.commandName,
    args: input.args ?? null,
    directory: input.directory ?? null,
    repoId,
  })

  firePreCommandHooks(run)
  return run
}

/** 기록 실패가 본 작업(스케줄 실행)을 중단시켜서는 안 되는 경로용. */
export function recordRunStartSafe(db: Database, input: RecordRunStartInput): CommandRun | null {
  try {
    return recordRunStart(db, input)
  } catch (error) {
    logger.warn('Failed to record command run start:', error)
    return null
  }
}

export function finishRunSafe(
  db: Database,
  id: string,
  status: Exclude<CommandRunStatus, 'started'>
): void {
  try {
    finishRun(db, id, status)
  } catch (error) {
    logger.warn(`Failed to mark command run ${id} as ${status}:`, error)
  }
}

export function attachMessage(db: Database, id: string, messageId: string): void {
  crDb.updateCommandRunMessage(db, id, messageId)
}

export function finishRun(
  db: Database,
  id: string,
  status: Exclude<CommandRunStatus, 'started'>
): void {
  const run = crDb.getCommandRunById(db, id)
  crDb.markCommandRunFinished(db, id, status)
  if (run) {
    firePostCommandHooks(run, status)
  }
}

export function listRunsInRange(db: Database, fromTs: number, toTs: number): CommandRun[] {
  return crDb.listCommandRunsByRange(db, fromTs, toTs)
}

export function listRunsBySession(db: Database, sessionId: string): CommandRun[] {
  return crDb.listCommandRunsBySession(db, sessionId)
}

export function listRunsByRepo(db: Database, repoId: number): CommandRun[] {
  return crDb.listCommandRunsByRepo(db, repoId)
}

export function removeRun(db: Database, id: string): void {
  crDb.deleteCommandRun(db, id)
}

export function clearSessionRuns(db: Database, sessionId: string): void {
  crDb.clearSessionCommandRuns(db, sessionId)
}
