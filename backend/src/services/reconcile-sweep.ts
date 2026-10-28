/**
 * B0-6: 1분 정리 타이머 (reconcile sweep).
 * opencode는 이미 끝났는데(timeout, abort, 재시작 등) 우리 쪽에 "실행 중"으로
 * 남은 상태를 1분마다 찾아 정리한다. 실시간 감지(B0-3, 큐 경로)가 놓친
 * 경우를 받아 내는 안전망이다. 자동 abort는 하지 않는다 — 정리는
 * 2회 연속 idle 관측 뒤에만 하고, opencode가 busy면 그대로 둔다.
 *
 * - 전역 setInterval(60s) 하나. 세션별 타이머 없음. unref + 서버 종료 시 정리.
 * - 이전 sweep 실행 중이면 이번 회차 건너뜀(재진입 가드).
 * - 후보 0이면 opencode를 호출하지 않는다.
 * - opencode 자체 데이터는 쓰지 않는다(읽기만). 정리는 우리 DB + 우리 in-flight만.
 * 의존성 없음(주입) — vitest 단위 테스트용.
 */

export type SweepKind = 'status' | 'queue' | 'inflight'

export interface SweepCandidate {
  sessionId: string
  kinds: SweepKind[]
}

export type TurnState = 'busy' | 'idle' | 'unknown'

export type PartState = 'running' | 'done' | 'unknown'

export interface PartCandidate {
  sessionId: string
  messageId: string
  partId: string
  tool: string
  command: string
}

export interface ReconcileDeps {
  listCandidates(): SweepCandidate[]
  fetchTurnState(sessionId: string): Promise<TurnState>
  markIdle(sessionId: string): void
  abortInFlight(sessionId: string): void
  logInfo(message: string): void
  logWarn(message: string): void
  now(): number
  /** opencode에서 running으로 남은 tool part (wire가 2분 초과만 넘긴다). */
  listRunningParts(): PartCandidate[] | Promise<PartCandidate[]>
  /** opencode 기준 part 상태. 끝났으면 done(행 삭제 포함). */
  getPartState(sessionId: string, partId: string): Promise<PartState>
  isOrphanMarked(sessionId: string, partId: string): boolean
  markOrphan(part: PartCandidate): void
  clearOrphan(sessionId: string, partId: string): void
}

export interface ReconcileOpts {
  intervalMs?: number
  confirmCount?: number
  minGapMs?: number
}

const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_CONFIRM_COUNT = 2
const DEFAULT_MIN_GAP_MS = 60_000

export function createReconcileSweep(deps: ReconcileDeps, opts: ReconcileOpts = {}) {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const confirmCount = opts.confirmCount ?? DEFAULT_CONFIRM_COUNT
  const minGapMs = opts.minGapMs ?? DEFAULT_MIN_GAP_MS
  // 세션별 연속 idle 관측 { 횟수, 첫 관측 시각 }.
  const observed = new Map<string, { count: number; firstSeenAt: number }>()
  // part별 연속 idle 관측 (세션 idle이면서 opencode part가 running일 때만 센다).
  const observedParts = new Map<string, { count: number; firstSeenAt: number }>()
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  async function runOnce(): Promise<void> {
    if (running) return
    running = true
    // 라운드 내 세션 턴 상태 캐시 — 세션·part 루프가 같은 판정을 공유한다.
    const turnCache = new Map<string, TurnState>()
    async function turnStateOf(sid: string): Promise<TurnState> {
      const hit = turnCache.get(sid)
      if (hit) return hit
      let st: TurnState = 'unknown'
      try {
        st = await deps.fetchTurnState(sid)
      } catch {
        /* 유지 */
      }
      turnCache.set(sid, st)
      return st
    }
    try {
      const candidates = deps.listCandidates()
      const parts = await deps.listRunningParts()
      if (candidates.length === 0 && parts.length === 0) {
        for (const sid of [...observed.keys()]) {
          if (!candidates.some((c) => c.sessionId === sid)) observed.delete(sid)
        }
        return
      }
      const seen = new Set<string>()
      for (const c of candidates) {
        const sid = c.sessionId
        seen.add(sid)
        const st = await turnStateOf(sid)
        if (st === 'busy') {
          observed.delete(sid)
          continue
        }
        if (st !== 'idle') continue
        const now = deps.now()
        const rec = observed.get(sid) ?? { count: 0, firstSeenAt: now }
        rec.count += 1
        observed.set(sid, rec)
        if (rec.count >= confirmCount && now - rec.firstSeenAt >= minGapMs) {
          deps.markIdle(sid)
          deps.abortInFlight(sid)
          deps.logInfo(
            `[reconcile] session=${sid} cleared=[${c.kinds.join('+')}] idleObservedFor=${Math.round((now - rec.firstSeenAt) / 1000)}s`,
          )
          observed.delete(sid)
        }
      }
      for (const sid of [...observed.keys()]) {
        if (!seen.has(sid)) observed.delete(sid)
      }

      // part 단위: opencode에서 running으로 남은 tool part만 본다.
      // - 세션 busy → 건드리지 않는다(자동 종료·abort 금지, opencode 쓰기 금지).
      // - 세션 idle 2회 연속 → orphan 표시(우리 DB) + [reconcile] part-orphan.
      // - opencode에서 끝난 part의 표시는 즉시 치운다 + [reconcile] part-mismatch 경고.
      const seenParts = new Set<string>()
      for (const p of parts) {
        const key = `${p.sessionId}:${p.partId}`
        seenParts.add(key)
        let pst: PartState = 'unknown'
        try {
          pst = await deps.getPartState(p.sessionId, p.partId)
        } catch {
          continue
        }
        if (pst === 'done') {
          if (deps.isOrphanMarked(p.sessionId, p.partId)) {
            deps.clearOrphan(p.sessionId, p.partId)
            deps.logWarn(
              `[reconcile] part-mismatch session=${p.sessionId} part=${p.partId} tool=${p.tool} opencode=done mark cleared`,
            )
          }
          observedParts.delete(key)
          continue
        }
        if (pst !== 'running') continue
        const tst = await turnStateOf(p.sessionId)
        if (tst === 'busy') {
          observedParts.delete(key)
          continue
        }
        if (tst !== 'idle') continue
        const now = deps.now()
        const rec = observedParts.get(key) ?? { count: 0, firstSeenAt: now }
        rec.count += 1
        observedParts.set(key, rec)
        if (rec.count >= confirmCount && now - rec.firstSeenAt >= minGapMs) {
          deps.markIdle(p.sessionId)
          deps.markOrphan(p)
          deps.logInfo(
            `[reconcile] part-orphan session=${p.sessionId} part=${p.partId} tool=${p.tool} idleObservedFor=${Math.round((now - rec.firstSeenAt) / 1000)}s`,
          )
          observedParts.delete(key)
        }
      }
      for (const key of [...observedParts.keys()]) {
        if (!seenParts.has(key)) observedParts.delete(key)
      }
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
    observed.clear()
    observedParts.clear()
  }

  return { runOnce, start, stop }
}
