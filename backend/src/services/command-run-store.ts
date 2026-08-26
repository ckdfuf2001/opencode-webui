import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'fs/promises'
import path from 'path'
import type { Database } from 'bun:sqlite'
import { getReposPath, getWorkspacePath } from '@opencode-webui/shared'
import { listRepos } from '../db/queries'
import type { CommandRun } from '../db/command-run-queries'
import { logger } from '../utils/logger'

const HISTORY_DIRNAME = 'run_history'
const UNASSIGNED_DIRNAME = 'unassigned'
const FILE_EXT = '.jsonl'

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function isUnder(child: string, parent: string): boolean {
  const c = normalizePath(child)
  const p = normalizePath(parent)
  return c.startsWith(`${p}/`) || c === p
}

export function monthKey(ts: number): string {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${d.getFullYear()}-${mm}`
}

/** 실행 이력이 속하는 디렉터리를 결정한다. 레포 밖이면 workspace의 unassigned로 폴백한다. */
export function resolveHistoryDir(
  db: Database,
  directory?: string | null,
  repoId?: number | null,
): string {
  if (directory && isUnder(directory, getReposPath())) {
    return path.join(directory, HISTORY_DIRNAME)
  }

  if (repoId != null) {
    const repo = listRepos(db).find((r) => r.id === repoId)
    if (repo?.fullPath) {
      return path.join(repo.fullPath, HISTORY_DIRNAME)
    }
  }

  return path.join(getWorkspacePath(), HISTORY_DIRNAME, UNASSIGNED_DIRNAME)
}

function monthFilePath(dir: string, ts: number): string {
  return path.join(dir, `${monthKey(ts)}${FILE_EXT}`)
}

function parseLines(content: string): { lineNo: number; run: CommandRun }[] {
  const out: { lineNo: number; run: CommandRun }[] = []
  content.split('\n').forEach((line, idx) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      out.push({ lineNo: idx, run: JSON.parse(trimmed) as CommandRun })
    } catch {
      logger.warn(`Skipping malformed run history line ${idx + 1}`)
    }
  })
  return out
}

async function readMonth(dir: string, ts: number): Promise<string | null> {
  try {
    return await readFile(monthFilePath(dir, ts), 'utf8')
  } catch {
    return null
  }
}

async function listMonthFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    return entries.filter((f) => f.endsWith(FILE_EXT)).sort().reverse()
  } catch {
    return []
  }
}

/**
 * 모든 쓰기는 이 체인을 통해 직렬화된다(단일 프로세스 기준).
 * 읽기는 큐를 거치지 않지만, 치환은 원자적(temp→rename)이라 부분 파일을 볼 수 없다.
 */
let writeQueue: Promise<void> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task, task)
  writeQueue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

export async function appendToDir(dir: string, run: CommandRun): Promise<void> {
  await mkdir(dir, { recursive: true })
  await appendMonthLine(dir, run)
}

async function appendMonthLine(dir: string, run: CommandRun): Promise<void> {
  const file = monthFilePath(dir, run.startedAt)
  await appendFile(file, `${JSON.stringify(run)}\n`, 'utf8')
}

type RunUpdater = (run: CommandRun) => CommandRun | null

async function rewriteMonth(dir: string, ts: number, transform: (runs: CommandRun[]) => CommandRun[]): Promise<boolean> {
  const file = monthFilePath(dir, ts)
  const content = await readMonth(dir, ts)
  if (content === null) return false

  const runs = parseLines(content).map(({ run }) => run)
  const updated = transform(runs)
  if (updated.length === runs.length && updated.every((r, i) => r === runs[i])) {
    return false
  }

  const body = updated.map((r) => JSON.stringify(r)).join('\n')
  const next = body ? `${body}\n` : ''
  const tmp = `${file}.tmp`
  await writeFile(tmp, next, 'utf8')
  await rename(tmp, file)
  return true
}

/** 저수준: 특정 디렉터리에서 id로 런을 찾아 갱신한다. updater가 null을 반환하면 삭제된다. */
export async function updateInDir(dir: string, id: string, updater: RunUpdater): Promise<CommandRun | null> {
  let result: CommandRun | null = null

  const applyUpdater = (runs: CommandRun[]): CommandRun[] =>
    runs.flatMap((r) => {
      if (r.id !== id) return [r]
      const next = updater(r)
      if (next) result = next
      return next ? [next] : []
    })

  const files = await listMonthFiles(dir)
  for (const file of files) {
    const ts = new Date(`${file.replace(FILE_EXT, '')}-01T00:00:00`).getTime()
    if (Number.isNaN(ts)) continue
    const changed = await rewriteMonth(dir, ts, applyUpdater)
    if (changed) break
  }

  return result
}

export async function listFromDir(dir: string, filter: (r: CommandRun) => boolean): Promise<CommandRun[]> {
  const out: CommandRun[] = []
  for (const file of await listMonthFiles(dir)) {
    const ts = new Date(`${file.replace(FILE_EXT, '')}-01T00:00:00`).getTime()
    if (Number.isNaN(ts)) continue
    const content = await readMonth(dir, ts)
    if (content === null) continue
    for (const { run } of parseLines(content)) {
      if (filter(run)) out.push(run)
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt)
}

function candidateDirs(db: Database): string[] {
  const dirs = listRepos(db)
    .map((r) => r.fullPath)
    .filter((p): p is string => Boolean(p))
    .map((p) => path.join(p, HISTORY_DIRNAME))
  dirs.push(path.join(getWorkspacePath(), HISTORY_DIRNAME, UNASSIGNED_DIRNAME))
  return dirs
}

/** 모든 run_history 파일에 존재하는 run id 집합. 마이그레이션 중복 방지용. */
export async function listExistingRunIds(db: Database): Promise<Set<string>> {
  const ids = new Set<string>()
  const tasks = candidateDirs(db).map(async (dir) => {
    for (const file of await listMonthFiles(dir)) {
      const content = await readFile(path.join(dir, file), 'utf8').catch(() => null)
      if (content === null) continue
      for (const { run } of parseLines(content)) ids.add(run.id)
    }
  })
  await Promise.all(tasks)
  return ids
}

const locationCache = new Map<string, string>()

function rememberLocation(id: string, dir: string): void {
  if (locationCache.size > 5000) locationCache.clear()
  locationCache.set(id, dir)
}

async function locateDir(db: Database, id: string): Promise<string | null> {
  const cached = locationCache.get(id)
  if (cached) return cached

  for (const dir of candidateDirs(db)) {
    const found = await updateInDir(dir, id, (r) => r)
    if (found) {
      rememberLocation(id, dir)
      return dir
    }
  }
  return null
}

export async function getRunById(db: Database, id: string): Promise<CommandRun | null> {
  const dir = await locateDir(db, id)
  if (!dir) return null
  const runs = await listFromDir(dir, (r) => r.id === id)
  return runs[0] ?? null
}

export async function insertRun(db: Database, run: CommandRun, directory?: string | null): Promise<void> {
  const dir = resolveHistoryDir(db, directory ?? run.directory, run.repoId)
  rememberLocation(run.id, dir)
  await enqueue(() => appendToDir(dir, run))
}

export async function updateMessage(db: Database, id: string, messageId: string): Promise<void> {
  const dir = await locateDir(db, id)
  if (!dir) return
  await enqueue(() => updateInDir(dir, id, (r) => (r.messageId ? r : { ...r, messageId })))
}

export async function markFinished(
  db: Database,
  id: string,
  status: Exclude<CommandRun['status'], 'started'>,
): Promise<void> {
  const dir = await locateDir(db, id)
  if (!dir) return
  await enqueue(() =>
    updateInDir(dir, id, (r) => (r.status !== 'started' ? r : { ...r, status, finishedAt: Date.now() })),
  )
}

export async function removeRun(db: Database, id: string): Promise<void> {
  const dir = await locateDir(db, id)
  if (!dir) return
  await enqueue(() => updateInDir(dir, id, () => null))
  locationCache.delete(id)
}

export async function clearSession(db: Database, sessionId: string): Promise<void> {
  const tasks = candidateDirs(db).map((dir) =>
    enqueue(async () => {
      const files = await listMonthFiles(dir)
      for (const file of files) {
        const ts = new Date(`${file.replace(FILE_EXT, '')}-01T00:00:00`).getTime()
        if (!Number.isNaN(ts)) await rewriteMonth(dir, ts, (runs) => runs.filter((r) => r.sessionId !== sessionId))
      }
    }),
  )
  await Promise.all(tasks)
}

export async function listInRange(db: Database, fromTs: number, toTs: number): Promise<CommandRun[]> {
  const results = await Promise.all(
    candidateDirs(db).map((dir) => listFromDir(dir, (r) => r.startedAt >= fromTs && r.startedAt <= toTs)),
  )
  return results.flat().sort((a, b) => b.startedAt - a.startedAt)
}

export async function listBySession(db: Database, sessionId: string): Promise<CommandRun[]> {
  const results = await Promise.all(
    candidateDirs(db).map((dir) => listFromDir(dir, (r) => r.sessionId === sessionId)),
  )
  return results.flat().sort((a, b) => b.startedAt - a.startedAt)
}

export async function listByRepo(db: Database, repoId: number): Promise<CommandRun[]> {
  const repo = listRepos(db).find((r) => r.id === repoId)
  if (!repo?.fullPath) return []
  return listFromDir(path.join(repo.fullPath, HISTORY_DIRNAME), () => true)
}
