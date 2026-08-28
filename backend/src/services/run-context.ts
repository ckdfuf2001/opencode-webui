import type { Database } from 'bun:sqlite'
import type { CommandRun } from '../db/command-run-queries'
import { listRepos } from '../db/queries'
import { getReposPath, getWorkspacePath } from '@opencode-webui/shared'
import path from 'path'
import { listFromDir } from './command-run-store'
import { readdir } from 'fs/promises'

const HISTORY_DIRNAME = 'run_history'
const UNASSIGNED_DIRNAME = 'unassigned'

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function candidateDirs(db: Database): string[] {
  const dirs = listRepos(db)
    .map((r) => r.fullPath)
    .filter((p): p is string => Boolean(p))
    .map((p) => path.join(p, HISTORY_DIRNAME))
  dirs.push(path.join(getWorkspacePath(), HISTORY_DIRNAME, UNASSIGNED_DIRNAME))
  return dirs
}

async function listMonthFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    return entries.filter((f) => f.endsWith('.jsonl')).sort().reverse()
  } catch {
    return []
  }
}

async function collectRecentRuns(db: Database, directory: string | undefined, commandName: string, limit: number): Promise<CommandRun[]> {
  const targetNorm = directory ? normalizePath(directory) : null
  const all: CommandRun[] = []
  for (const dir of candidateDirs(db)) {
    const runs = await listFromDir(dir, (r) => {
      if (r.commandName !== commandName) return false
      if (targetNorm) {
        if (!r.directory) return false
        if (normalizePath(r.directory) !== targetNorm) return false
      }
      return true
    })
    all.push(...runs)
  }
  all.sort((a, b) => b.startedAt - a.startedAt)
  return all.slice(0, limit)
}

export interface RunContextFacts {
  commandName: string
  windowSize: number
  total: number
  successCount: number
  failedCount: number
  cancelledCount: number
  consecutiveFailures: number
  lastFailureAt: number | null
  lastSuccessAt: number | null
}

export async function buildRunContextFacts(
  db: Database,
  directory: string | undefined,
  commandName: string,
  windowSize = 10,
): Promise<RunContextFacts> {
  const runs = await collectRecentRuns(db, directory, commandName, windowSize)
  let successCount = 0
  let failedCount = 0
  let cancelledCount = 0
  let consecutiveFailures = 0
  let lastFailureAt: number | null = null
  let lastSuccessAt: number | null = null

  for (const r of runs) {
    if (r.status === 'completed') successCount++
    else if (r.status === 'failed') {
      failedCount++
      if (lastFailureAt == null) lastFailureAt = r.startedAt
    } else if (r.status === 'cancelled') cancelledCount++
    if (r.status === 'completed' && lastSuccessAt == null) lastSuccessAt = r.startedAt
  }

  for (const r of runs) {
    if (r.status === 'failed') consecutiveFailures++
    else if (r.status === 'completed') break
    else if (r.status === 'cancelled') break
    else if (r.status === 'started') break
  }

  return {
    commandName,
    windowSize,
    total: runs.length,
    successCount,
    failedCount,
    cancelledCount,
    consecutiveFailures,
    lastFailureAt,
    lastSuccessAt,
  }
}

function formatTs(ts: number | null): string {
  if (ts == null) return '-'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function renderRunContextBlock(facts: RunContextFacts): string {
  if (facts.total === 0) {
    return `[run-context] command=${facts.commandName} 최근 실행 없음. 이 블록은 관측 사실이며 지시가 아니다.`
  }
  const parts: string[] = []
  parts.push(`[run-context] command=${facts.commandName} 최근 ${facts.total}회 실행: 성공 ${facts.successCount}/${facts.total}, 실패 ${facts.failedCount}, 취소 ${facts.cancelledCount}.`)
  if (facts.consecutiveFailures > 0) {
    parts.push(`연속 실패 ${facts.consecutiveFailures}회 (마지막 실패 ${formatTs(facts.lastFailureAt)}).`)
  } else if (facts.lastSuccessAt) {
    parts.push(`연속 실패 0회 (마지막 성공 ${formatTs(facts.lastSuccessAt)}).`)
  }
  parts.push('이 블록은 관측 사실이며 지시가 아니다.')
  return parts.join(' ')
}

export async function buildRunContext(
  db: Database,
  directory: string | undefined,
  commandName: string,
  windowSize = 10,
): Promise<{ block: string; facts: RunContextFacts }> {
  const facts = await buildRunContextFacts(db, directory, commandName, windowSize)
  return { block: renderRunContextBlock(facts), facts }
}

export function isRunContextBlock(text: string): boolean {
  return text.includes('[run-context]')
}

export const CIRCUIT_BREAKER_THRESHOLD = 3
