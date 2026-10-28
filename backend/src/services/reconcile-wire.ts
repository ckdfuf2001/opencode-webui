import type { Database } from 'bun:sqlite'
import {
  clearPartOrphan,
  isPartOrphanMarked,
  listPartOrphansBySession,
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
import { getToolPartStatesBatch, listRunningToolParts } from './session-message-db'
import { getTurnVerdict } from './turn-verdict'
import { createReconcileSweep, type PartCandidate, type SweepCandidate } from './reconcile-sweep'
import { logger } from '../utils/logger'

/**
 * B0-6 배선: 1분 reconcile sweep의 실제 의존성을 묶는다.
 * 후보 = 우리 DB busy 행 + 2분 초과 sending 큐 + 2분 초과 in-flight(큐/proxy).
 * 판정 = 폴러 스냅샷(P0-1, 새 fetch 없음). 스냅샷이 없거나 해당 디렉터리
 * 조회가 실패했으면 unknown — 응답 부재를 idle로 보지 않는다.
 * 정리 = 우리 DB idle + 우리 in-flight abort. opencode 데이터는 읽기만.
 * 큐 항목은 지우지 않는다 — 기존 idle 확정 경로가 처리한다(유실 방지).
 */

const STALE_MS = 120_000
const ORPHAN_PRUNE_MS = 7 * 24 * 60 * 60_000
/** P1-1: part 상태 배치 재사용 창 (라운드당 open 1회). */
const PART_STATE_CACHE_MS = 30_000

let sweep: ReturnType<typeof createReconcileSweep> | null = null
let lastOrphanPrune = 0
let partStateCache: { at: number; states: Map<string, 'running' | 'done'> } | null = null

export function startReconcileSweep(db: Database): void {
  if (sweep) return
  sweep = createReconcileSweep(
    {
      listCandidates: (): SweepCandidate[] => {
        const kinds = new Map<string, { kinds: Set<SweepCandidate['kinds'][number]>; directory?: string }>()
        const add = (sid: string, kind: SweepCandidate['kinds'][number], directory?: string) => {
          const e = kinds.get(sid) ?? { kinds: new Set<SweepCandidate['kinds'][number]>() }
          e.kinds.add(kind)
          if (directory !== undefined) e.directory = directory
          kinds.set(sid, e)
        }
        const dirBySession = new Map<string, string>()
        for (const row of listSessionStatus(db)) {
          dirBySession.set(row.sessionId, row.directory)
          if (row.status === 'busy') add(row.sessionId, 'status', row.directory)
        }
        for (const s of listStaleSending(STALE_MS)) add(s.sessionId, 'queue', s.directory)
        for (const s of listStaleQueueInFlight(STALE_MS)) add(s.sessionId, 'inflight', s.directory)
        const now = Date.now()
        for (const d of listTrackedDispatches()) {
          if (now - d.since >= STALE_MS) add(d.sessionId, 'inflight', d.directory)
        }
        return [...kinds.entries()].map(([sessionId, e]) => ({
          sessionId,
          kinds: [...e.kinds],
          directory: e.directory ?? dirBySession.get(sessionId),
        }))
      },
      fetchTurnState: (sid: string, directory?: string) => Promise.resolve(getTurnVerdict(sid, directory)),
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
          const dirBySession = new Map<string, string>()
          try {
            for (const row of listSessionStatus(db)) dirBySession.set(row.sessionId, row.directory)
          } catch {}
          const rows = await listRunningToolParts(STALE_MS)
          return rows.map((r) => ({
            sessionId: r.sessionId,
            messageId: r.messageId,
            partId: r.partId,
            tool: r.tool,
            command: r.command,
            directory: dirBySession.get(r.sessionId),
          }))
        } catch {
          return []
        }
      },
      // P1-1: 라운드당 1회 배치 조회로 상태를 재사용한다(part마다 open 금지).
      getPartState: async (sid: string, pid: string) => {
        const now = Date.now()
        if (!partStateCache || now - partStateCache.at > PART_STATE_CACHE_MS) {
          const pairs: Array<{ sessionId: string; partId: string }> = []
          try {
            for (const r of await listRunningToolParts(STALE_MS)) pairs.push({ sessionId: r.sessionId, partId: r.partId })
          } catch {}
          try {
            for (const [msid, plist] of listPartOrphansBySession(db)) {
              for (const ppid of plist as string[]) pairs.push({ sessionId: msid, partId: ppid })
            }
          } catch {}
          try {
            partStateCache = { at: now, states: await getToolPartStatesBatch(pairs) }
          } catch {
            return 'unknown' as const
          }
        }
        return partStateCache.states.get(`${sid}:${pid}`) ?? 'unknown'
      },
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
  partStateCache = null
}
