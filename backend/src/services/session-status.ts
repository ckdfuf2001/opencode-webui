import type { Database } from 'bun:sqlite'
import { opencodeServerManager } from './opencode-single-server'
import { ensureServerAuth } from './opencode-auth'
import { resolveRepoId } from './command-runs'
import * as crDb from '../db/command-run-queries'
import { flushReadyQueues } from './chat-queue'
import { listRepos } from '../db/queries'
import { getWorkspacePath } from '@opencode-webui/shared'
import {
  listSessionStatus,
  markSessionStatusIdle,
  pruneIdleSessionStatus,
  upsertSessionStatus,
} from '../db/session-status-queries'
import { logger } from '../utils/logger'

const POLL_INTERVAL_MS = 2_000
const FETCH_TIMEOUT_MS = 5_000
const IDLE_ROW_TTL_MS = 30 * 24 * 60 * 60 * 1000

interface DirectorySnapshot {
  busySessionIds: Set<string>
  pendingPermissions: Map<string, number>
}/**
 * opencode 의 /session/status (busy 세션)와 /permission (승인 대기)을 주기적으로
 * 읽어 webui DB(session_status)에 반영한다. SSE 이벤트 유실과 무관하게 프론트가
 * DB만 보고 Working 배지·방패(승인 대기) 배지를 판단할 수 있는 단일 진실 통로.
 *
 * 기동 직후 첫 틱이 곧 정정 로직이다: DB에 busy 로 남아 있는데 opencode 가
 * busy 가 아니라고 하면 idle 로 정정하고, opencode 가 busy 면 감시를 이어간다.
 */
let activeStop: (() => void) | null = null

export function startSessionStatusPoller(db: Database): void {
  if (activeStop) return
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const tick = async (): Promise<void> => {
    if (stopped) return
    const startedAt = Date.now()
    try {
      const snapshots = await collectDirectorySnapshots(db)
      const now = Date.now()

      const touched = new Set<string>()
      const busySessionIds = new Set<string>()
      for (const [directory, snapshot] of snapshots) {
        const repoId = resolveRepoId(db, directory)
        for (const sessionId of snapshot.busySessionIds) {
          busySessionIds.add(sessionId)
          upsertSessionStatus(db, {
            sessionId,
            directory,
            repoId,
            status: 'busy',
            pendingPermissions: snapshot.pendingPermissions.get(sessionId) ?? 0,
            updatedAt: now,
          })
          touched.add(sessionId)
        }
        for (const [sessionId, count] of snapshot.pendingPermissions) {
          if (snapshot.busySessionIds.has(sessionId)) continue
          upsertSessionStatus(db, {
            sessionId,
            directory,
            repoId,
            status: 'idle',
            pendingPermissions: count,
            updatedAt: now,
          })
          touched.add(sessionId)
        }
      }

      for (const row of listSessionStatus(db)) {
        if (touched.has(row.sessionId)) continue
        const snapshot = snapshots.get(row.directory)
        if (!snapshot) continue // 조회 실패 디렉터리는 마지막 상태 유지
        if (row.status === 'busy' && !snapshot.busySessionIds.has(row.sessionId)) {
          logger.info(`Session ${row.sessionId} marked idle by status poller`)
          // SSE 제거로 프론트가 session.idle 을 받지 않으므로 커맨드 런 종료 처리를 여기서 한다.
          try {
            for (const run of crDb.listCommandRunsBySession(db, row.sessionId)) {
              if (run.status === 'started') crDb.markCommandRunFinished(db, run.id, 'completed')
            }
          } catch (error) {
            logger.warn(`Failed to finish command runs for session ${row.sessionId}:`, error)
          }
        }
        markSessionStatusIdle(db, row.sessionId, now)
      }

      pruneIdleSessionStatus(db, IDLE_ROW_TTL_MS, now)

      // idle 이 된 세션의 채팅 큐 헤드를 발송한다 (SSE session.idle 대체).
      flushReadyQueues(busySessionIds)
    } catch (error) {
      logger.warn('Session status poll cycle failed:', error)
    } finally {
      if (!stopped) {
        const elapsed = Date.now() - startedAt
        timer = setTimeout(() => void tick(), Math.max(500, POLL_INTERVAL_MS - elapsed))
      }
    }
  }

  void tick()

  activeStop = () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

export function stopSessionStatusPoller(): void {
  activeStop?.()
  activeStop = null
}

async function collectDirectorySnapshots(db: Database): Promise<Map<string, DirectorySnapshot>> {
  const directories = new Set<string>()
  for (const repo of listRepos(db)) {
    if (repo.fullPath) directories.add(repo.fullPath)
  }
  directories.add(getWorkspacePath())

  const snapshots = new Map<string, DirectorySnapshot>()
  for (const directory of directories) {
    try {
      const [busySessionIds, pendingPermissions, pendingQuestions] = await Promise.all([
        fetchBusySessions(directory),
        fetchPendingCounts(directory, 'permission'),
        fetchPendingCounts(directory, 'question'),
      ])
      // question/permission 대기는 세션이 사용자 입력을 기다리는 running 상태다.
      for (const sessionId of pendingPermissions.keys()) busySessionIds.add(sessionId)
      for (const sessionId of pendingQuestions.keys()) busySessionIds.add(sessionId)
      const merged = new Map<string, number>(pendingPermissions)
      for (const [sessionId, count] of pendingQuestions) {
        merged.set(sessionId, (merged.get(sessionId) ?? 0) + count)
      }
      snapshots.set(directory, { busySessionIds, pendingPermissions: merged })
    } catch {
      // 이 디렉터리 조회 실패는 전체 사이클을 중단시키지 않는다.
      // 실패한 디렉터리의 행은 다음 틱까지 마지막 상태를 유지한다.
    }
  }
  return snapshots
}

async function fetchBusySessions(directory: string): Promise<Set<string>> {
  const url = `${opencodeServerManager.getUrl()}/session/status?directory=${encodeURIComponent(directory)}`
  const response = await fetch(url, {
    headers: ensureServerAuth({}),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`session/status ${response.status}`)
  const map = (await response.json()) as Record<string, { type?: string }>
  const busy = new Set<string>()
  for (const [sessionId, info] of Object.entries(map)) {
    if (info?.type === 'busy') busy.add(sessionId)
  }
  return busy
}

interface PendingItemLike {
  sessionID?: string
}

async function fetchPendingCounts(directory: string, kind: 'permission' | 'question'): Promise<Map<string, number>> {
  const url = `${opencodeServerManager.getUrl()}/${kind}?directory=${encodeURIComponent(directory)}`
  const response = await fetch(url, {
    headers: ensureServerAuth({}),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${kind} ${response.status}`)
  const list = (await response.json()) as PendingItemLike[]
  const counts = new Map<string, number>()
  if (!Array.isArray(list)) return counts
  for (const item of list) {
    const sessionId = item?.sessionID
    if (!sessionId) continue
    counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1)
  }
  return counts
}
