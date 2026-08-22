import { logger } from '../utils/logger'
import type { CommandRun, CommandRunStatus } from '../db/command-run-queries'

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

async function preCommand(run: CommandRun): Promise<void> {
  const call = toCall(run, 'pre', 'started')
  record(call)
  logger.info(
    `[pre-command] ${run.commandName} (run=${run.id}, origin=${run.origin}, session=${run.sessionId})`
  )
}

async function postCommand(run: CommandRun, status: Exclude<CommandRunStatus, 'started'>): Promise<void> {
  const call = toCall(run, 'post', status)
  record(call)
  logger.info(
    `[post-command] ${run.commandName} status=${status} (run=${run.id}, origin=${run.origin}, session=${run.sessionId})`
  )
}

export function firePreCommandHooks(run: CommandRun): void {
  void preCommand(run)
    .then(() => notifyListeners('pre', run))
    .catch((error: unknown) => {
      logger.warn('pre-command hook failed:', error)
    })
}

export function firePostCommandHooks(
  run: CommandRun,
  status: Exclude<CommandRunStatus, 'started'>
): void {
  void postCommand(run, status)
    .then(() => notifyListeners('post', run, status))
    .catch((error: unknown) => {
      logger.warn('post-command hook failed:', error)
    })
}

/** ── 실시간 알림(SSE)용 리스너 ────────────────────────────── */

export interface CommandRunEvent {
  type: 'command-run'
  phase: CommandHookPhase
  runId: string
  sessionId: string
  commandName: string
  origin: string
  status: CommandRunStatus | null
}

type RunEventListener = (event: CommandRunEvent) => void
const listeners = new Set<RunEventListener>()

export function onCommandRunUpdate(listener: RunEventListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notifyListeners(phase: CommandHookPhase, run: CommandRun, status?: CommandRunStatus): void {
  const event: CommandRunEvent = {
    type: 'command-run',
    phase,
    runId: run.id,
    sessionId: run.sessionId,
    commandName: run.commandName,
    origin: run.origin,
    status: status ?? null,
  }
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (error) {
      logger.warn('command run listener failed:', error)
    }
  }
}
