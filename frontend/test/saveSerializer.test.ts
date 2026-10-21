import { describe, it, expect } from 'vitest'
import {
  createSaveSerializer,
  type SaveOutcome,
  type SaveSerializerEvent,
} from '../src/lib/saveSerializer'

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const p = new Promise<T>((r) => {
    resolve = r
  })
  return { p, resolve }
}

type SaveFn = (bytes: string, ctx: { saveSeq: number }) => Promise<SaveOutcome>

/** 직렬화 이전(3-1 전) 동작: request 가 곧바로 save 를 호출한다(직렬화 없음). */
function createNaiveSerializer(save: SaveFn) {
  let active = 0
  let maxActive = 0
  return {
    request: async (bytes: string) => {
      active++
      maxActive = Math.max(maxActive, active)
      try {
        const r = await save(bytes, { saveSeq: 1 })
        return 'ok' in r && r.ok
      } finally {
        active--
      }
    },
    get maxActive() {
      return maxActive
    },
  }
}

describe('saveSerializer (M28 1-1′)', () => {
  it('S1: 저장 중 요청 3회 → 저장 2회, 마지막이 최신 내용', async () => {
    const gate = deferred()
    const saved: string[] = []
    const s = createSaveSerializer<string>({
      save: async (b) => {
        saved.push(b)
        if (saved.length === 1) await gate.p
        return { ok: true }
      },
    })
    const p = s.request('a')
    s.request('b')
    s.request('c')
    gate.resolve()
    await p
    expect(saved.length).toBe(2)
    expect(saved[saved.length - 1]).toBe('c')
  })

  it('S2: 직렬화 모듈은 in-flight 1개 / naive 구현은 깨진다(대조)', async () => {
    const gate = deferred()
    const save: SaveFn = async () => {
      await gate.p
      return { ok: true }
    }
    let realActive = 0
    let realMax = 0
    const real = createSaveSerializer<string>({
      save: async (b, ctx) => {
        realActive++
        realMax = Math.max(realMax, realActive)
        try {
          return await save(b, ctx)
        } finally {
          realActive--
        }
      },
    })
    const pReal = real.request('a')
    real.request('b')
    real.request('c')
    const naive = createNaiveSerializer(save)
    const pNaive = naive.request('a')
    naive.request('b')
    naive.request('c')
    gate.resolve()
    await Promise.all([pReal, pNaive])
    expect(realMax).toBe(1)
    // naive(직렬화 이전) 실패 원문: maxActive 가 1보다 크다.
    expect(naive.maxActive).toBeGreaterThan(1)
  })

  it('S3: 첫 저장 실패 + 그 사이 요청 → writeback-failed 발화, 최신 요청은 유실되지 않음', async () => {
    const gate = deferred()
    const events: SaveSerializerEvent[] = []
    const saved: string[] = []
    const s = createSaveSerializer<string>({
      retry: { attempts: 1, delayMs: 0 },
      save: async (b) => {
        saved.push(b)
        if (saved.length === 1) {
          await gate.p
          return { ok: false, reason: 'boom', retryable: false }
        }
        return { ok: true }
      },
      onEvent: (e) => events.push(e),
    })
    const p = s.request('a')
    s.request('b')
    gate.resolve()
    await p
    expect(events.some((e) => e.evt === 'writeback-failed')).toBe(true)
    expect(saved[saved.length - 1]).toBe('b')
  })

  it('S4: 첫 저장 진행 중 canSave 가 false → 두 번째 요청은 skip{owner_lost}, 저장 1회', async () => {
    const gate = deferred()
    const events: SaveSerializerEvent[] = []
    let calls = 0
    let can = true
    const s = createSaveSerializer<string>({
      save: async () => {
        calls++
        await gate.p
        return { ok: true }
      },
      canSave: () => can,
      onEvent: (e) => events.push(e),
    })
    const p = s.request('a')
    can = false
    s.request('b')
    gate.resolve()
    await p
    expect(calls).toBe(1)
    expect(events.some((e) => e.evt === 'save.skip' && e.reason === 'owner_lost')).toBe(true)
  })

  it('S5: 실패 뒤 새 요청 → 정상 저장(상태 고착 없음)', async () => {
    const saved: string[] = []
    const s = createSaveSerializer<string>({
      retry: { attempts: 1, delayMs: 0 },
      save: async (b) => {
        saved.push(b)
        return saved.length === 1 ? { ok: false, reason: 'boom', retryable: false } : { ok: true }
      },
    })
    await s.request('a')
    await s.request('b')
    expect(saved[saved.length - 1]).toBe('b')
  })

  it('S6: 오래된 gen 은 stale_gen 으로 버린다', async () => {
    const events: SaveSerializerEvent[] = []
    let calls = 0
    const s = createSaveSerializer<string>({
      save: async () => {
        calls++
        return { ok: true }
      },
      onEvent: (e) => events.push(e),
    })
    await s.request('a', { gen: 5 })
    await s.request('b', { gen: 3 })
    expect(calls).toBe(1)
    expect(events.some((e) => e.evt === 'save.skip' && e.reason === 'stale_gen')).toBe(true)
  })

  it('S7: 대기 중 세션(경로/epoch)이 바뀌면 저장 0회 + skip{session_changed}', async () => {
    const gate = deferred()
    const events: SaveSerializerEvent[] = []
    let calls = 0
    let session = { path: '/a.pptx', epoch: 'e1' }
    const s = createSaveSerializer<string>({
      save: async () => {
        calls++
        await gate.p
        return { ok: true }
      },
      getSession: () => session,
      onEvent: (e) => events.push(e),
    })
    const p = s.request('x', { session: { path: '/a.pptx', epoch: 'e1' } })
    // 파일/방이 교체되면 현재 세션은 e2 로 바뀐다.
    session = { path: '/b.pptx', epoch: 'e2' }
    // 대기 중인 요청은 **교체 전 세션(e1)** 의 것이라서 저장하면 안 된다.
    s.request('z', { session: { path: '/a.pptx', epoch: 'e1' } })
    gate.resolve()
    await p
    expect(calls).toBe(1)
    expect(events.some((e) => e.evt === 'save.skip' && e.reason === 'session_changed')).toBe(true)
  })

  it('S8: 실패 후 후속 요청이 없어도 dirty 유지 + failedBytes 존재', async () => {
    const s = createSaveSerializer<string>({
      retry: { attempts: 1, delayMs: 0 },
      save: async () => ({ ok: false, reason: 'boom', retryable: false }),
    })
    await s.request('a')
    expect(s.dirty).toBe(true)
    expect(s.failedBytes).toBe('a')
    s.clearFailed()
    expect(s.dirty).toBe(false)
  })

  it('S9: 재시도 불가 실패는 재시도 0회', async () => {
    let calls = 0
    const s = createSaveSerializer<string>({
      retry: { attempts: 3, delayMs: 0 },
      save: async () => {
        calls++
        return { ok: false, reason: 'denied', retryable: false }
      },
    })
    await s.request('a')
    expect(calls).toBe(1)
  })

  it('P1-1: covers 로 합쳐진 요청을 알 수 있다', async () => {
    const gate = deferred()
    const events: SaveSerializerEvent[] = []
    const s = createSaveSerializer<string>({
      save: async () => {
        await gate.p
        return { ok: true }
      },
      onEvent: (e) => events.push(e),
    })
    const p = s.request('a')
    s.request('b')
    s.request('c')
    gate.resolve()
    await p
    const starts = events.filter((e) => e.evt === 'save.start') as Extract<
      SaveSerializerEvent,
      { evt: 'save.start' }
    >[]
    expect(starts.length).toBe(2)
    expect(starts[0].covers).toEqual([1])
    expect(starts[1].covers).toEqual([2, 3])
  })
})
