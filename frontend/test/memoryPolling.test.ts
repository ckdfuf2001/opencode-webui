import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  sessionStatusRefetchInterval,
  SESSION_STATUS_BUSY_INTERVAL_MS,
  SESSION_STATUS_IDLE_INTERVAL_MS,
} from '../src/lib/sessionStatusPolling'

/**
 * D29: 폴링은 앱당 1개 + 상황별 주기.
 *
 * - 같은 query key의 refetchInterval 주체는 Pollers.tsx 한 곳뿐이다.
 * - 주기는 함수형이다: busy 세션이 하나라도 있으면 1200ms, 전부 idle이면 5000ms.
 *
 * 근거: M7-4 실측에서 observer 9개 × 1.2s = interval 실행 7.9/s였고,
 * 단일 폴러로 합친 뒤 편집 모드 증가율이 +0.42 → +0.26MB/s로 내려갔다.
 */

// react-query 는 isServer(=typeof window === 'undefined') 로 타이머 생성을 막는다.
// node 환경에서 타이머 동작을 검증하려면 window 를 먼저 정의하고 동적 import 한다.
;(globalThis as unknown as { window?: unknown }).window ??= globalThis
const { QueryClient, QueryObserver } = await import('@tanstack/react-query')

const KEY = ['session-status-db']

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
}

describe('D29 세션 상태 폴링 주기', () => {
  it('busy 세션이 하나라도 있으면 1200ms', () => {
    expect(sessionStatusRefetchInterval([{ status: 'busy' }])).toBe(SESSION_STATUS_BUSY_INTERVAL_MS)
    expect(sessionStatusRefetchInterval([{ status: 'idle' }, { status: 'busy' }])).toBe(1200)
  })

  it('전부 idle이면 5000ms', () => {
    expect(sessionStatusRefetchInterval([{ status: 'idle' }])).toBe(SESSION_STATUS_IDLE_INTERVAL_MS)
    expect(sessionStatusRefetchInterval([])).toBe(5000)
    expect(sessionStatusRefetchInterval(undefined)).toBe(5000)
  })
})

describe('D30/D32 세션 해제 규칙', () => {
  it('path 기반 releaseCollabSession export 가 없다 (lease 토큰만)', async () => {
    const registry = await import('../src/lib/collabSessionRegistry')
    const names = Object.keys(registry)
    expect(names.some((n) => n.toLowerCase().includes('releasecollabsession'))).toBe(false)
  })
})

describe('D29 활성 interval 주체는 1개', () => {
  let live: Map<unknown, unknown>
  let restore: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    live = new Map()
    // react-query 의 timeoutManager 는 호출 시점의 global setInterval 을 쓴다.
    // fake timer 를 먼저 깔고 그 위에 기록용 wrapper 를 감는다.
    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    globalThis.setInterval = ((cb: never, delay: never, ...args: never[]) => {
      const id = (realSet as (...a: never[]) => unknown)(cb, delay, ...args)
      live.set(id, delay)
      return id
    }) as typeof globalThis.setInterval
    globalThis.clearInterval = ((id: never) => {
      live.delete(id)
      return (realClear as (...a: never[]) => void)(id)
    }) as typeof globalThis.clearInterval
    restore = () => {
      globalThis.setInterval = realSet
      globalThis.clearInterval = realClear
    }
  })

  afterEach(() => {
    restore()
    vi.useRealTimers()
  })

  const liveRefetchIntervals = () =>
    [...live.values()].filter((d) => d === 1200 || d === 5000).length

  it('폴링 observer 1개 + 캐시 전용 observer 여러 개면 활성 interval 은 1개다', async () => {
    const client = makeClient()
    let calls = 0
    const queryFn = async () => {
      calls += 1
      return [{ status: 'busy' }]
    }
    // busy 상태를 먼저 넣어 주기 판정이 1200ms로 결정되게 한다
    client.setQueryData(KEY, [{ status: 'busy' }])

    // Pollers.tsx 처럼 폴링하는 observer 1개
    const poller = new QueryObserver(client, {
      queryKey: KEY,
      queryFn,
      refetchInterval: (q) => sessionStatusRefetchInterval(q.state.data as Array<{ status?: string }>),
      refetchIntervalInBackground: true,
    })
    const unsubPoller = poller.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0) // 첫 fetch → 타이머 생성
    expect(liveRefetchIntervals()).toBe(1)

    // 나머지 컴포넌트들은 캐시만 읽는다 (refetchInterval 없음)
    const readers = [0, 1, 2].map(() => {
      const obs = new QueryObserver(client, { queryKey: KEY, queryFn })
      return obs.subscribe(() => {})
    })
    await vi.advanceTimersByTimeAsync(0)
    // 캐시 전용 observer 는 타이머를 만들지 않는다
    expect(liveRefetchIntervals()).toBe(1)

    const before = calls
    await vi.advanceTimersByTimeAsync(1200)
    expect(calls).toBe(before + 1) // busy 주기 1200ms
    await vi.advanceTimersByTimeAsync(1200)
    expect(calls).toBe(before + 2)

    unsubPoller()
    readers.forEach((u) => u())
    client.clear()
  })

  it('캐시 전용 observer만 있으면 리페치가 반복되지 않는다', async () => {
    const client = makeClient()
    let calls = 0
    const queryFn = async () => {
      calls += 1
      return [{ status: 'busy' }]
    }
    const readers = [0, 1, 2].map(() => {
      const obs = new QueryObserver(client, { queryKey: KEY, queryFn })
      return obs.subscribe(() => {})
    })
    await vi.advanceTimersByTimeAsync(0)
    const afterMount = calls
    expect(liveRefetchIntervals()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    // 주기가 없으면 추가 리페치가 없다
    expect(calls).toBe(afterMount)
    readers.forEach((u) => u())
    client.clear()
  })
})
