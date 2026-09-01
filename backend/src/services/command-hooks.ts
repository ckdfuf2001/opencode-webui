import { logger } from '../utils/logger'
import type { CommandRun, CommandRunStatus } from '../db/command-run-queries'
import type { Database } from 'bun:sqlite'

export type CommandHookPhase = 'pre' | 'post'

export interface CommandHookCall {
  phase: CommandHookPhase
  runId: string
  sessionId: string
  commandName: string
  origin: string
  status: CommandRunStatus | null
  directory: string | null
  repoId: number | null
  at: number
}

const MAX_RECENT = 50
const recentCalls: CommandHookCall[] = []

export function getRecentHookCalls(): CommandHookCall[] {
  return [...recentCalls]
}

export function clearRecentHookCalls(): void {
  recentCalls.length = 0
}

function record(call: CommandHookCall): void {
  recentCalls.unshift(call)
  if (recentCalls.length > MAX_RECENT) recentCalls.length = MAX_RECENT
}

function toCall(run: CommandRun, phase: CommandHookPhase, status: CommandRunStatus): CommandHookCall {
  return {
    phase,
    runId: run.id,
    sessionId: run.sessionId,
    commandName: run.commandName,
    origin: run.origin,
    status: phase === 'post' ? status : null,
    directory: run.directory,
    repoId: run.repoId,
    at: Date.now(),
  }
}

async function preCommand(run: CommandRun, db?: Database): Promise<void> {
  const call = toCall(run, 'pre', 'started')
  record(call)
  logger.info(
    `[pre-command] ${run.commandName} (run=${run.id}, origin=${run.origin}, session=${run.sessionId})`
  )
  if (db && run.commandName) {
    try {
      const { buildRecall } = await import('./recall')
      const q = `${run.commandName} ${run.args ?? ''}`.trim().slice(0, 200)
      const { hits } = buildRecall(db, q, { k: 3, repoId: run.repoId ?? undefined })
      if (hits.length > 0) {
        logger.info(`[pre-command] recall for ${run.commandName}: ${hits.map((h) => `${h.kind}:${h.snippet.slice(0, 40)}`).join(' | ')}`)
      }
    } catch (e) {
      logger.debug('[pre-command] recall skipped:', e)
    }
  }
}

async function postCommand(run: CommandRun, status: Exclude<CommandRunStatus, 'started'>, db?: Database): Promise<void> {
  const call = toCall(run, 'post', status)
  record(call)
  logger.info(
    `[post-command] ${run.commandName} status=${status} (run=${run.id}, origin=${run.origin}, session=${run.sessionId})`
  )
  if (db && run.repoId != null && status === 'completed') {
    try {
      const { indexRepoCommits, listAllIndexedRepos, HOST_REPO_ID } = await import('./git-indexer')
      const { getRepoById } = await import('../db/queries')
      const target =
        run.repoId === HOST_REPO_ID
          ? listAllIndexedRepos(db).find((r) => r.id === HOST_REPO_ID) ?? null
          : getRepoById(db, run.repoId)
      if (target) {
        void indexRepoCommits(db, target).catch((e) => logger.debug('[post-command] git reindex skipped:', e))
      }
    } catch (e) {
      logger.debug('[post-command] git reindex skipped:', e)
    }
  }
}

export function firePreCommandHooks(run: CommandRun, db?: Database): void {
  void preCommand(run, db).catch((error: unknown) => {
    logger.warn('pre-command hook failed:', error)
  })
}

export function firePostCommandHooks(
  run: CommandRun,
  status: Exclude<CommandRunStatus, 'started'>,
  db?: Database
): void {
  void postCommand(run, status, db).catch((error: unknown) => {
    logger.warn('post-command hook failed:', error)
  })
}
