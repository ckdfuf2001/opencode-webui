import type { Database } from 'bun:sqlite'
import { opencodeServerManager } from './opencode-single-server'
import { ensureServerAuth } from './opencode-auth'
import {
  clearPartOrphan,
  isPartOrphanMarked,
  listSessionStatus,
  markPartOrphan,
  markSessionStatusIdle,
  prunePartOrphans,
} from '../db/session-status-queries'
import {
  abortQueueInFlight,
  listStaleQueueInFlight,
  listStaleSending,
} from './chat-queue'
import { listTrackedDispatches, sweepAbortTracked } from './proxy-turn-end'
import { getToolPartState, listRunningToolParts } from './session-message-db'
import { createReconcileSweep, type PartCandidate, type SweepCandidate } from './reconcile-sweep'
import { logger } from '../utils/logger'

/**
 * B0-6 배선: 1분 reconcile sweep의 실제 의존성을 묶는다.
 * 후보 = 우리 DB busy 행 + 2분 초과 sending 큐 + 2분 초과 in-flight(큐/proxy).
 * 판정 = opencode /session/status 전역 조회(30초 캐시, 후보 있을 때만).
 * 정리 = 우리 DB idle + 우리 in-flight abort. opencode 데이터는 읽기만.
 * 큐 항목은 지우지 않는다 — 기존 idle 확정 경로가 처리한다(유실 방지).
 */

const STALE_MS = 120_000
const STATUS_CACHE_MS = 30_000
const ORPHAN_PRUNE_MS = 7 * 24 * 60 * 60_000

let sweep: ReturnType<typeof createReconcileSweep> | null = null
let statusCache: { at: number; busy: Set<string> } | null = null
let lastOrphanPrune = 0

async function fetchTurnState(sessionId: string): Promise<'busy' | 'idle' | 'unknown'> {
  const now = Date.now()
  if (!statusCache || now - statusCache.at > STATUS_CACHE_MS) {
    try {
      const res = await fetch(`${opencodeServerManager.getUrl()}/session/status`, {
        headers: ensureServerAuth({}),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return 'unknown'
      const map = (await res.json()) as Record<string, { type?: string }>
      statusCache = {
        at: now,
        busy: new Set(
          Object.entries(map)
            .filter(([, v]) => v?.type === 'busy')
            .map(([k]) => k),
        ),
      }
    } catch {
      return 'unknown'
    }
  }
  return statusCache.busy.has(sessionId) ? 'busy' : 'idle'
}

export function startReconcileSweep(db: Database): void {
  if (sweep) return
  sweep = createReconcileSweep(
    {
      listCandidates: (): SweepCandidate[] => {
        const kinds = new Map<string, Set<SweepCandidate['kinds'][number]>>()
        const add = (sid: string, kind: SweepCandidate['kinds'][number]) => {
          const s = kinds.get(sid) ?? new Set<SweepCandidate['kinds'][number]>()
          s.add(kind)
          kinds.set(sid, s)
        }
        for (const row of listSessionStatus(db)) {
          if (row.status === 'busy') add(row.sessionId, 'status')
        }
        for (const s of listStaleSending(STALE_MS)) add(s.sessionId, 'queue')
        for (const s of listStaleQueueInFlight(STALE_MS)) add(s.sessionId, 'inflight')
        const now = Date.now()
        for (const d of listTrackedDispatches()) {
          if (now - d.since >= STALE_MS) add(d.sessionId, 'inflight')
        }
        return [...kinds.entries()].map(([sessionId, set]) => ({ sessionId, kinds: [...set] }))
      },
      fetchTurnState,
      markIdle: (sid: string) => markSessionStatusIdle(db, sid, Date.now()),
      abortInFlight: (sid: string) => {
        try {
          abortQueueInFlight(sid)
        } catch {}
        try {
          sweepAbortTracked(sid)
        } catch {}
      },
      logInfo: (msg: string) => logger.info(msg),
      logWarn: (msg: string) => logger.warn(msg),
      now: () => Date.now(),
      listRunningParts: async (): Promise<PartCandidate[]> => {
        if (Date.now() - lastOrphanPrune >= 60 * 60_000) {
          lastOrphanPrune = Date.now()
          try {
            prunePartOrphans(db, ORPHAN_PRUNE_MS, Date.now())
          } catch {}
        }
        try {
          const rows = await listRunningToolParts(STALE_MS)
          return rows.map((r) => ({
            sessionId: r.sessionId,
            messageId: r.messageId,
            partId: r.partId,
            tool: r.tool,
            command: r.command,
          }))
        } catch {
          return []
        }
      },
      getPartState: (sid: string, pid: string) => getToolPartState(sid, pid),
      isOrphanMarked: (sid: string, pid: string) => {
        try {
          return isPartOrphanMarked(db, sid, pid)
        } catch {
          return false
        }
      },
      markOrphan: (p: PartCandidate) => {
        try {
          markPartOrphan(db, { sessionId: p.sessionId, messageId: p.messageId, partId: p.partId, tool: p.tool, command: p.command })
        } catch {}
      },
      clearOrphan: (sid: string, pid: string) => {
        try {
          clearPartOrphan(db, sid, pid)
        } catch {}
      },
    },
  )
  sweep.start()
  logger.info('Reconcile sweep started (60s)')
}

export function stopReconcileSweep(): void {
  sweep?.stop()
  sweep = null
  statusCache = null
}
