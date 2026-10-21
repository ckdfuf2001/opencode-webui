import { describe, it, expect } from 'vitest'
import { createSaveSerializer, type SaveSerializerEvent } from '../src/lib/saveSerializer'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('saveSerializer (M27 1-1)', () => {
  it('S1: 느린 저장 중 요청 3회 → 저장 2회, 마지막이 최신 내용', async () => {
    const saved: string[] = []
    const s = createSaveSerializer<string>({
      save: async (b) => {
        saved.push(b)
        await wait(40)
        return true
      },
    })
    const p = s.request('a')
    await wait(10)
    s.request('b')
    s.request('c')
    await p
    await wait(60)
    expect(saved.length).toBe(2)
    expect(saved[saved.length - 1]).toBe('c')
  })

  it('S2: flush/debounce 동시 요청 → in-flight 는 항상 1개', async () => {
    let active = 0
    let maxActive = 0
    const s = createSaveSerializer<string>({
      save: async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await wait(30)
        active--
        return true
      },
    })
    await Promise.all([s.request('a'), s.request('b'), s.request('c')])
    await wait(60)
    expect(maxActive).toBe(1)
  })

  it('S3: 첫 저장 실패 + 그 사이 요청 → writeback-failed 발화, 최신 요청은 유실되지 않음', async () => {
    const events: SaveSerializerEvent[] = []
    const saved: string[] = []
    let first = true
    const s = createSaveSerializer<string>({
      retry: { attempts: 1, delayMs: 0 },
      save: async (b) => {
        saved.push(b)
        if (first) {
          first = false
          await wait(30)
          return false
        }
        return true
      },
      onEvent: (e) => events.push(e),
    })
    const p = s.request('a')
    await wait(10)
    s.request('b')
    await p
    await wait(60)
    expect(events.some((e) => e.evt === 'writeback-failed')).toBe(true)
    expect(saved[saved.length - 1]).toBe('b')
  })

  it('S4: 대기 중 canSave 가 false → skip{owner_lost}, 저장 호출 0회', async () => {
    const events: SaveSerializerEvent[] = []
    let calls = 0
    const s = createSaveSerializer<string>({
      save: async () => {
        calls++
        return true
      },
      canSave: () => false,
      onEvent: (e) => events.push(e),
    })
    await s.request('a')
    expect(calls).toBe(0)
    expect(events.some((e) => e.evt === 'save.skip' && e.reason === 'owner_lost')).toBe(true)
  })

  it('S5: 실패 뒤 새 요청 → 정상 저장(상태 고착 없음)', async () => {
    const saved: string[] = []
    let first = true
    const s = createSerializerWithFirstFailure(saved, () => {
      first = false
    })
    await s.request('a')
    await wait(20)
    const p2 = s.request('b')
    await p2
    expect(saved[saved.length - 1]).toBe('b')
  })

  it('T1a: 직렬화 이전 구현(단순 await)은 in-flight 1개 보장을 실패한다', async () => {
    // M27 T1a: 3-1 이전(fba7ed6의 `await persistBytes(bytes)`)은 동시 저장을 막지 못한다.
    // 같은 인터페이스(저장 1개 = Promise<boolean>)로 감쌌을 때 S2 불변식이 깨지는 것을 고정한다.
    let active = 0
    let maxActive = 0
    const save = async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await wait(30)
      active--
      return true
    }
    await Promise.all([save(), save(), save()])
    expect(maxActive).toBeGreaterThan(1)
  })

  it('P1-1: reqSeq/saveSeq 분리 — save.start.covers 로 합쳐진 요청을 알 수 있다', async () => {
    const events: SaveSerializerEvent[] = []
    const s = createSaveSerializer<string>({
      save: async () => {
        await wait(30)
        return true
      },
      onEvent: (e) => events.push(e),
    })
    const p = s.request('a')
    await wait(10)
    s.request('b')
    s.request('c')
    await p
    await wait(60)
    const starts = events.filter((e) => e.evt === 'save.start') as Extract<
      SaveSerializerEvent,
      { evt: 'save.start' }
    >[]
    expect(starts.length).toBe(2)
    expect(starts[0].covers).toEqual([1])
    expect(starts[1].covers).toEqual([2, 3])
  })
})

function createSerializerWithFirstFailure(saved: string[], onFirst: () => void) {
  return createSaveSerializer<string>({
    retry: { attempts: 1, delayMs: 0 },
    save: async (b) => {
      saved.push(b)
      if (saved.length === 1) {
        onFirst()
        return false
      }
      return true
    },
  })
}
