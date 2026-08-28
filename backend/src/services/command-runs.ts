import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import type {
  CommandRun,
  CommandRunOrigin,
  CommandRunStatus,
  CreateCommandRunInput,
} from '../db/command-run-queries'
import * as store from './command-run-store'
import { listRepos } from '../db/queries'
import { firePreCommandHooks, firePostCommandHooks } from './command-hooks'
import { captureRunVersions } from './run-version'
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
 * run 시작을 기록한다(단일 소스: <repo>/run_history/<yyyy-MM>.jsonl).
 * id / startedAt 은 서버가 생성하므로 클라이언트 시계가 어긋나도 달력 날짜가 밀리지 않는다.
 * repoId 가 없으면 directory 로 해석해 채운다.
 */
export async function recordRunStart(
  db: Database,
  input: RecordRunStartInput,
): Promise<CommandRun> {
  const now = Date.now()
  const versions = await captureRunVersions(input.directory ?? null, input.commandName).catch(() => ({ registrySha: null, targetHash: null }))
  const run: CommandRun = {
    id: randomUUID(),
    sessionId: input.sessionId,
    repoId: input.repoId ?? resolveRepoId(db, input.directory),
    commandName: input.commandName,
    args: input.args ?? null,
    directory: input.directory ?? null,
    messageId: null,
    status: 'started',
    origin: input.origin,
    kind: input.kind ?? 'command',
    startedAt: now,
    finishedAt: null,
    createdAt: now,
    registrySha: versions.registrySha,
    targetHash: versions.targetHash,
  }

  await store.insertRun(db, run, input.directory ?? null)
  firePreCommandHooks(run)
  return run
}

/** 기록 실패가 본 작업(스케줄 실행)을 중단시켜서는 안 되는 경로용. */
export async function recordRunStartSafe(
  db: Database,
  input: RecordRunStartInput,
): Promise<CommandRun | null> {
  try {
    return await recordRunStart(db, input)
  } catch (error) {
    logger.warn('Failed to record command run start:', error)
    return null
  }
}

export async function finishRunSafe(
  db: Database,
  id: string,
  status: Exclude<CommandRunStatus, 'started'>,
): Promise<void> {
  try {
    await finishRun(db, id, status)
  } catch (error) {
    logger.warn(`Failed to mark command run ${id} as ${status}:`, error)
  }
}

export async function attachMessage(db: Database, id: string, messageId: string): Promise<void> {
  await store.updateMessage(db, id, messageId)
}

export async function finishRun(
  db: Database,
  id: string,
  status: Exclude<CommandRunStatus, 'started'>,
): Promise<void> {
  const run = await store.getRunById(db, id)
  await store.markFinished(db, id, status)
  if (run) {
    firePostCommandHooks(run, status)
  }
}

export async function listRunsInRange(db: Database, fromTs: number, toTs: number): Promise<CommandRun[]> {
  return store.listInRange(db, fromTs, toTs)
}

export async function listRunsBySession(db: Database, sessionId: string): Promise<CommandRun[]> {
  return store.listBySession(db, sessionId)
}

export async function listRunsByRepo(db: Database, repoId: number): Promise<CommandRun[]> {
  return store.listByRepo(db, repoId)
}

export async function removeRun(db: Database, id: string): Promise<void> {
  await store.removeRun(db, id)
}

export async function clearSessionRuns(db: Database, sessionId: string): Promise<void> {
  await store.clearSession(db, sessionId)
}
