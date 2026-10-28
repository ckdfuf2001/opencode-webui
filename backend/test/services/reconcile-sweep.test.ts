import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReconcileSweep, type ReconcileDeps } from '../../src/services/reconcile-sweep'

function makeDeps(overrides: Partial<ReconcileDeps> = {}) {
  const calls = {
    markIdle: [] as string[],
    abort: [] as string[],
    fetches: [] as string[],
    markOrphan: [] as string[],
    clearOrphan: [] as string[],
    warns: [] as string[],
    infos: [] as string[],
  }
  let states = new Map<string, 'busy' | 'idle' | 'unknown'>()
  let runningParts: Array<{ sessionId: string; messageId: string; partId: string; tool: string; command: string }> = []
  let partStates = new Map<string, 'running' | 'done' | 'unknown'>()
  let marked = new Set<string>()
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
    logInfo: (msg: string) => {
      calls.infos.push(msg)
    },
    logWarn: (msg: string) => {
      calls.warns.push(msg)
    },
    now: () => Date.now(),
    listRunningParts: () => runningParts,
    getPartState: async (_sid: string, pid: string) => partStates.get(pid) ?? 'unknown',
    isOrphanMarked: (sid: string, pid: string) => marked.has(`${sid}:${pid}`),
    markOrphan: (p: { sessionId: string; partId: string }) => {
      calls.markOrphan.push(p.partId)
      marked.add(`${p.sessionId}:${p.partId}`)
    },
    clearOrphan: (sid: string, pid: string) => {
      calls.clearOrphan.push(pid)
      marked.delete(`${sid}:${pid}`)
    },
    ...overrides,
  }
  const ctl = { states, setRunningParts: (v: typeof runningParts) => (runningParts = v), setPartStates: (v: typeof partStates) => (partStates = v), marked }
  return { deps, calls, states, ctl }
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

  it('세션 A가 바빠도 B idle이면 B만 정리된다 (세션별 판정)', async () => {
    const { deps, calls, states } = makeDeps({
      listCandidates: () => [
        { sessionId: 'A', kinds: ['status'] },
        { sessionId: 'B', kinds: ['status', 'queue'] },
      ],
    })
    states.set('A', 'busy')
    states.set('B', 'idle')
    const sweep = createReconcileSweep(deps, { confirmCount: 2, minGapMs: 0 })
    await sweep.runOnce()
    expect(calls.markIdle).toEqual([])
    await sweep.runOnce()
    expect(calls.markIdle).toEqual(['B'])
  })

  it('running part + 세션 idle 2회 연속이면 orphan으로 표시한다 (abort 없음)', async () => {
    const { deps, calls, states, ctl } = makeDeps()
    ctl.setRunningParts([{ sessionId: 'S', messageId: 'm1', partId: 'p1', tool: 'bash', command: 'sleep 30' }])
    ctl.setPartStates(new Map([['p1', 'running']]))
    states.set('S', 'idle')
    const sweep = createReconcileSweep(deps, { confirmCount: 2, minGapMs: 0 })
    await sweep.runOnce()
    expect(calls.markOrphan).toEqual([])
    await sweep.runOnce()
    expect(calls.markOrphan).toEqual(['p1'])
    expect(calls.abort).toEqual([])
  })

  it('세션이 busy면 running part를 건드리지 않는다 (자동 종료 금지)', async () => {
    const { deps, calls, states, ctl } = makeDeps()
    ctl.setRunningParts([{ sessionId: 'S', messageId: 'm1', partId: 'p1', tool: 'bash', command: 'sleep 30' }])
    ctl.setPartStates(new Map([['p1', 'running']]))
    states.set('S', 'busy')
    const sweep = createReconcileSweep(deps, { confirmCount: 1, minGapMs: 0 })
    await sweep.runOnce()
    await sweep.runOnce()
    expect(calls.markOrphan).toEqual([])
    expect(calls.abort).toEqual([])
    expect(calls.markIdle).toEqual([])
  })

  it('opencode에서 끝난 part의 orphan 표시는 즉시 치우고 경고한다 (part-mismatch 감시)', async () => {
    const { deps, calls, ctl } = makeDeps()
    ctl.setRunningParts([{ sessionId: 'S', messageId: 'm1', partId: 'p1', tool: 'bash', command: 'sleep 30' }])
    ctl.setPartStates(new Map([['p1', 'done']]))
    ctl.marked.add('S:p1')
    const sweep = createReconcileSweep(deps)
    await sweep.runOnce()
    expect(calls.clearOrphan).toEqual(['p1'])
    expect(calls.warns.some((w) => w.includes('part-mismatch'))).toBe(true)
  })

  it('세션 상태를 모르면(unknown) 3회가 돌아도 정리하지 않는다 (P0-1)', async () => {
    const { deps, calls, states } = makeDeps({
      listCandidates: () => [{ sessionId: 'U', kinds: ['status'] }],
    })
    states.set('U', 'unknown')
    const sweep = createReconcileSweep(deps)
    await sweep.runOnce()
    await sweep.runOnce()
    await sweep.runOnce()
    expect(calls.markIdle).toEqual([])
    expect(calls.abort).toEqual([])
  })

  it('이미 표시된 고아는 다시 표시·로그하지 않는다 (P1-2, 3라운드 1회)', async () => {
    const { deps, calls, states, ctl } = makeDeps()
    ctl.setRunningParts([{ sessionId: 'S', messageId: 'm1', partId: 'p1', tool: 'bash', command: 'sleep 30' }])
    ctl.setPartStates(new Map([['p1', 'running']]))
    states.set('S', 'idle')
    const sweep = createReconcileSweep(deps, { confirmCount: 1, minGapMs: 0 })
    await sweep.runOnce()
    await sweep.runOnce()
    await sweep.runOnce()
    expect(calls.markOrphan).toEqual(['p1'])
    expect(calls.infos.filter((m) => m.includes('part-orphan')).length).toBe(1)
  })
})
