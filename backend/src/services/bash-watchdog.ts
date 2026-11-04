import type { Database } from 'bun:sqlite'
import { listBusySessionStatus, markPartOrphan, markSessionStatusIdle } from '../db/session-status-queries'
import { abortQueueInFlight } from './chat-queue'
import { resolveLiveDirectory } from './command-runs'
import { opencodeServerManager } from './opencode-single-server'
import { ensureServerAuth } from './opencode-auth'
import { sweepAbortTracked } from './proxy-turn-end'
import { listRunningBashDetails, type RunningBashDetail } from './session-message-db'
import { logger } from '../utils/logger'

/**
 * 백단 bash-watchdog: opencode가 bash를 kill했는데 우리 세션이 계속
 * busy(스피너)로 남는 고착을 백단에서 끝낸다. 프론트(MessageThread 20s
 * 토스트)는 표시만 하고 kill하지 않는다.
 *
 * - 10s 전역 타이머 1개. 세션별 타이머 없음. unref + 종료 시 정리.
 * - 후보 = 우리 DB busy 행 (우리만 대기 중인데 opencode는 끝난 경우).
 * - opencode busy 여부는 직접 fetch(/session/status?directory= + 전역)로
 *   판정한다. 폴러 스냅샷(turn-verdict) unknown 함정에 걸리지 않게 한다.
 * - opencode idle + bash part가 input.timeout(기본 120s, 상한 600s)+grace(30s)를
 *   넘겨도 running이면 고착으로 보고: 우리 DB idle + orphan 표시 + in-flight abort.
 * - opencode 데이터는 읽기만 한다. opencode DB에는 쓰지 않는다(readonly open).
 * - 의존성 주입 구조 — vitest 단위 테스트용.
 */

export const BASH_DEFAULT_TIMEOUT_MS = 120_000
export const BASH_MAX_TIMEOUT_MS = 600_000
export const BASH_GRACE_MS = 30_000
const WATCHDOG_INTERVAL_MS = 10_000
/** opencode fetch 실패 시 unknown으로 보고 손대지 않는다. */
const FETCH_TIMEOUT_MS = 5_000

export interface BashWatchdogPart extends RunningBashDetail {}

export function bashTimeoutMs(rawTimeout: number | null): number {
  const t = typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : BASH_DEFAULT_TIMEOUT_MS
  return Math.min(t, BASH_MAX_TIMEOUT_MS)
}

export function bashStartAt(p: RunningBashDetail): number {
  if (typeof p.rawStart === 'number' && p.rawStart > 0) return p.rawStart
  if (typeof p.messageCreated === 'number' && p.messageCreated > 0) return p.messageCreated
  return p.timeUpdated
}

/** 만료됐는데도 running이면 true. nowMs는 테스트용(기본 Date.now()). */
export function isBashTimedOut(p: RunningBashDetail, nowMs?: number): boolean {
  const now = nowMs ?? Date.now()
  const start = bashStartAt(p)
  if (!start || now < start) return false
  return now - start >= bashTimeoutMs(p.rawTimeout) + BASH_GRACE_MS
}

export interface BashWatchdogDeps {
  listBusySessions(): Array<{ sessionId: string; directory: string; pendingPermissions: number }>
  /** true=opencode가 아직 busy, false=idle. 실패 시 throw → unknown으로 스킵. */
  fetchOpencodeBusy(sessionId: string, directory: string): Promise<boolean>
  listBashParts(): Promise<BashWatchdogPart[]> | BashWatchdogPart[]
  markIdle(sessionId: string): void
  markOrphan(p: BashWatchdogPart): void
  abortInFlight(sessionId: string): void
  logInfo(message: string): void
  logWarn(message: string): void
  now(): number
}

export interface BashWatchdogOpts {
  intervalMs?: number
}

export function createBashWatchdog(deps: BashWatchdogDeps, opts: BashWatchdogOpts = {}) {
  const intervalMs = opts.intervalMs ?? WATCHDOG_INTERVAL_MS
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  async function runOnce(): Promise<string[]> {
    if (running) return []
    running = true
    const cleared: string[] = []
    try {
      const busy = deps.listBusySessions()
      if (busy.length === 0) return cleared
      let parts: BashWatchdogPart[] = []
      try {
        parts = await deps.listBashParts()
      } catch {
        return cleared
      }
      if (parts.length === 0) {
        // bash 고착이 아니면 손대지 않는다 — 일반 busy/idle 정리는
        // session-status poller + reconcile sweep이 맡는다.
        return cleared
      }
      const bySession = new Map<string, BashWatchdogPart[]>()
      for (const p of parts) {
        const list = bySession.get(p.sessionId) ?? []
        list.push(p)
        bySession.set(p.sessionId, list)
      }
      const now = deps.now()
      for (const row of busy) {
        // 승인 대기 중이면 사용자가 답해야 하는 정상 대기 — 강제 종료 금지.
        if ((row.pendingPermissions ?? 0) > 0) continue
        const sessParts = bySession.get(row.sessionId)
        if (!sessParts || sessParts.length === 0) continue
        // 전부 만료된 것만 고착 후보. 하나라도 정상 실행 중이면 스킵.
        const timedOut = sessParts.filter((p) => isBashTimedOut(p, now))
        if (timedOut.length === 0) continue
        let opencodeBusy: boolean
        try {
          opencodeBusy = await deps.fetchOpencodeBusy(row.sessionId, row.directory)
        } catch {
          continue // unknown — 응답 부재를 idle로 보지 않는다
        }
        if (opencodeBusy) continue
        // opencode는 idle인데 만료된 bash가 running으로 남음 → 고착 확정.
        try {
          deps.markIdle(row.sessionId)
        } catch {}
        for (const p of timedOut) {
          try {
            deps.markOrphan(p)
          } catch {}
        }
        try {
          deps.abortInFlight(row.sessionId)
        } catch {}
        try {
          deps.logInfo(
            `[bash-watchdog] session=${row.sessionId} cleared parts=[${timedOut.map((p) => p.partId).join(',')}] tool=bash overdue=${Math.round((now - Math.min(...timedOut.map((p) => bashStartAt(p)))) / 1000)}s`,
          )
        } catch {}
        cleared.push(row.sessionId)
      }
      return cleared
    } finally {
      running = false
    }
  }

  function start(): void {
    if (timer) return
    timer = setInterval(() => {
      void runOnce()
    }, intervalMs)
    const t = timer as unknown as { unref?: () => void }
    if (typeof t.unref === 'function') t.unref()
  }

  function stop(): void {
    if (timer) clearInterval(timer)
    timer = null
  }

  return { runOnce, start, stop }
}

// ---- 실제 배선 ----

let watchdog: ReturnType<typeof createBashWatchdog> | null = null

async function fetchBusySet(url: string): Promise<Set<string>> {
  const res = await fetch(url, {
    headers: ensureServerAuth({}) as Record<string, string>,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`session/status ${res.status}`)
  const map = (await res.json()) as Record<string, { type?: string }>
  const out = new Set<string>()
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    for (const [sid, info] of Object.entries(map)) {
      if (info?.type === 'busy') out.add(sid)
    }
  }
  return out
}

async function fetchOpencodeBusyDirect(sessionId: string, directory: string): Promise<boolean> {
  const baseUrl = opencodeServerManager.getUrl()
  // 디렉터리 인스턴스 + 전역 둘 다 확인한다. 어느 한쪽이라도 busy면 busy.
  // 둘 다 실패하면 throw → unknown으로 스킵한다. 실패를 빈 집합으로
  // 오인하지 않는다 (fetchBusySessionIds는 실패 시 []를 돌려줘 busy를
  // idle로 오판할 수 있어 직접 fetch한다).
  const dirUrl = `${baseUrl}/session/status?directory=${encodeURIComponent(directory)}`
  const globalUrl = `${baseUrl}/session/status`
  const results = await Promise.allSettled([fetchBusySet(dirUrl), fetchBusySet(globalUrl)])
  let ok = false
  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    ok = true
    if (r.value.has(sessionId)) return true
  }
  if (!ok) throw new Error('opencode status unreachable')
  return false
}

export function startBashWatchdog(db: Database): void {
  if (watchdog) return
  watchdog = createBashWatchdog(
    {
      listBusySessions: () =>
        listBusySessionStatus(db).map((r) => ({
          sessionId: r.sessionId,
          directory: resolveLiveDirectory(db, r.directory, r.repoId),
          pendingPermissions: r.pendingPermissions ?? 0,
        })),
      fetchOpencodeBusy: (sid, dir) => fetchOpencodeBusyDirect(sid, dir),
      listBashParts: () => listRunningBashDetails(),
      markIdle: (sid) => markSessionStatusIdle(db, sid, Date.now()),
      markOrphan: (p) =>
        markPartOrphan(db, {
          sessionId: p.sessionId,
          messageId: p.messageId,
          partId: p.partId,
          tool: p.tool,
          command: p.command,
        }),
      abortInFlight: (sid) => {
        try {
          abortQueueInFlight(sid)
        } catch {}
        try {
          sweepAbortTracked(sid)
        } catch {}
      },
      logInfo: (msg) => logger.info(msg),
      logWarn: (msg) => logger.warn(msg),
      now: () => Date.now(),
    },
  )
  watchdog.start()
  logger.info('Bash watchdog started (10s)')
}

export function stopBashWatchdog(): void {
  watchdog?.stop()
  watchdog = null
}

export function resetBashWatchdogForTest(): void {
  watchdog = null
}
