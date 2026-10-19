import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * D29 연결 테스트: "같은 query key 에 refetchInterval 활성 observer 가 1개다" 를
 * queryCache 기준으로 확인한다.
 *
 * grep 검사(poll:true 는 Pollers.tsx 한 곳)만으로는 같은 key 에 observer 가 여러 개
 * 붙는 경우를 못 잡는다. 여기서는 실제로 observer 를 붙여서 확인한다.
 *
 * - 런타임: 폴링 observer 1개 + 캐시 전용 observer 3개 → 폴링 observer 는 1개
 * - 소스: useSessionStatusMap 의 refetchInterval 이 `poll` 에 조건부이며,
 *         `poll: true` 호출 지점이 Pollers.tsx 한 곳뿐인지
 *
 * T1a: 47b23af(단일 폴러 이전) 에서는 useSessionStatusMap 가 조건부 없이 폴링했고
 *      호출 지점이 9곳이었다 → 이 테스트가 실패해야 한다.
 */

// react-query 는 isServer(=typeof window === 'undefined') 로 타이머 생성을 막는다.
// node 환경에서 타이머 동작을 검증하려면 window 를 먼저 정의하고 동적 import 한다.
;(globalThis as unknown as { window?: unknown }).window ??= globalThis
const { QueryClient, QueryObserver } = await import('@tanstack/react-query')

const KEY = ['session-status-db']
const SRC = path.resolve(__dirname, '..', 'src')

function readSrc(...parts: string[]) {
  return fs.readFileSync(path.join(SRC, ...parts), 'utf8')
}

describe('D29 같은 key 의 활성 refetchInterval observer 는 1개', () => {
  let live: Map<unknown, unknown>
  let restore: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    live = new Map()
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

  it('폴링 observer 1개 + 캐시 전용 3개 → 폴링 observer 는 1개, 활성 타이머도 1개', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const queryFn = async () => [{ status: 'idle' }]

    // Pollers.tsx 처럼 폴링하는 observer 1개
    const poller = new QueryObserver(client, {
      queryKey: KEY,
      queryFn,
      refetchInterval: 5000,
      refetchIntervalInBackground: true,
    })
    const unsubPoller = poller.subscribe(() => {})

    // 상태를 읽기만 하는 컴포넌트 3개
    const readers = [0, 1, 2].map(() => {
      const obs = new QueryObserver(client, { queryKey: KEY, queryFn })
      return obs.subscribe(() => {})
    })

    await vi.advanceTimersByTimeAsync(0)

    // queryCache 기준으로 확인
    const query = client.getQueryCache().find({ queryKey: KEY })
    expect(query).toBeTruthy()
    const observers = Array.from((query as unknown as { observers: Set<unknown> }).observers)
    expect(observers.length).toBe(4) // 폴링 1 + 캐시 전용 3
    const polling = observers.filter((o) => {
      const opt = (o as { options?: { refetchInterval?: unknown } }).options
      const ri = opt?.refetchInterval
      return typeof ri === 'number' ? ri > 0 : typeof ri === 'function'
    })
    expect(polling.length).toBe(1) // 폴링은 1개뿐
    expect(live.size).toBe(1) // 활성 타이머도 1개

    unsubPoller()
    readers.forEach((u) => u())
    client.clear()
  })
})

describe('D29 연결: 앱 소스가 조건부 폴링을 유지한다', () => {
  it('useSessionStatusMap 의 refetchInterval 은 poll 에 조건부이고, 없으면 false 다', () => {
    const src = readSrc('hooks', 'useOpenCode.ts')
    // M7-4 (d) 단일 폴러: refetchInterval 은 poll ? (...) : false 형태여야 한다
    expect(src).toMatch(/refetchInterval:\s*poll\s*\n?\s*\?/)
    expect(src).toMatch(/\?\s*\(query\)\s*=>\s*sessionStatusRefetchInterval\(/)
    expect(src).toMatch(/:\s*false,\s*\n\s*staleTime:\s*800,/)
  })

  it('poll: true 인 호출 지점은 Pollers.tsx 한 곳뿐이다', () => {
    const files = [
      'components/Pollers.tsx',
      'components/favorites/FavoriteSessionsPanel.tsx',
      'components/message/PromptInput.tsx',
      'components/navigation/NavigationTree.tsx',
      'components/opencode/OpenCodeStatus.tsx',
      'components/repo/RepoList.tsx',
      'components/session/SessionList.tsx',
      'pages/SessionDetail.tsx',
    ]
    const pollingCallSites: string[] = []
    for (const f of files) {
      const src = readSrc(...f.split('/'))
      const hits = src.match(/useSessionStatusMap\([^)]*poll\s*:\s*true[^)]*\)/g)
      if (hits) pollingCallSites.push(`${f} × ${hits.length}`)
    }
    expect(pollingCallSites).toEqual(['components/Pollers.tsx × 1'])
  })
})
