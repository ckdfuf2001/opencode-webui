import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReconcileSweep, type ReconcileDeps } from '../../src/services/reconcile-sweep'

function makeDeps(overrides: Partial<ReconcileDeps> = {}) {
  const calls = { markIdle: [] as string[], abort: [] as string[], fetches: [] as string[] }
  let states = new Map<string, 'busy' | 'idle' | 'unknown'>()
  const deps: ReconcileDeps = {
    listCandidates: () => [],
    fetchTurnState: async (sid: string) => {
      calls.fetches.push(sid)
      return states.get(sid) ?? 'unknown'
    },
    markIdle: (sid: string) => {
      calls.markIdle.push(sid)
    },
    abortInFlight: (sid: string) => {
      calls.abort.push(sid)
    },
    logInfo: () => {},
    now: () => Date.now(),
    ...overrides,
  }
  return { deps, calls, states }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('reconcile sweep (B0-6)', () => {
  it('opencode idle을 2회 연속 관측하면 정리한다', async () => {
    const { deps, calls, states } = makeDeps({
      listCandidates: () => [{ sessionId: 's1', kinds: ['status', 'queue'] }],
    })
    states.set('s1', 'idle')
    const sweep = createReconcileSweep(deps, { intervalMs: 60_000, confirmCount: 2, minGapMs: 60_000 })
    await sweep.runOnce()
    expect(calls.markIdle).toEqual([])
    vi.advanceTimersByTime(60_000)
    await sweep.runOnce()
    expect(calls.markIdle).toEqual(['s1'])
  })

  it('1회만 관측했으면 정리하지 않는다', async () => {
    const { deps, calls, states } = makeDeps({
      listCandidates: () => [{ sessionId: 's1', kinds: ['status'] }],
    })
    states.set('s1', 'idle')
    const sweep = createReconcileSweep(deps)
    await sweep.runOnce()
    expect(calls.markIdle).toEqual([])
    expect(calls.abort).toEqual([])
  })

  it('opencode가 busy면 계속 유지한다', async () => {
    const { deps, calls, states } = makeDeps({
      listCandidates: () => [{ sessionId: 's1', kinds: ['status', 'inflight'] }],
    })
    states.set('s1', 'busy')
    const sweep = createReconcileSweep(deps)
    await sweep.runOnce()
    await sweep.runOnce()
    expect(calls.markIdle).toEqual([])
    expect(calls.abort).toEqual([])
  })

  it('후보가 0이면 fetch를 0회 호출한다', async () => {
    const { deps, calls } = makeDeps({ listCandidates: () => [] })
    const sweep = createReconcileSweep(deps)
    await sweep.runOnce()
    expect(calls.fetches).toEqual([])
  })

  it('sweep이 겹치면 이번 회차는 건너뛴다', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { deps, calls } = makeDeps({
      listCandidates: () => [{ sessionId: 's1', kinds: ['status'] }],
      fetchTurnState: async (sid: string) => {
        calls.fetches.push(sid)
        await gate
        return 'idle' as const
      },
    })
    const sweep = createReconcileSweep(deps)
    const first = sweep.runOnce()
    const second = sweep.runOnce()
    await second
    expect(calls.fetches).toEqual(['s1'])
    release()
    await first
  })

  it('서버가 종료되면 타이머가 해제된다', async () => {
    const { deps, calls, states } = makeDeps({
      listCandidates: () => [{ sessionId: 's1', kinds: ['status'] }],
    })
    states.set('s1', 'idle')
    const sweep = createReconcileSweep(deps, { intervalMs: 60_000, confirmCount: 1, minGapMs: 0 })
    sweep.start()
    sweep.stop()
    vi.advanceTimersByTime(600_000)
    // 정지 뒤에는 돌지 않으므로 정리도 일어나지 않는다.
    expect(calls.markIdle).toEqual([])
  })
})
