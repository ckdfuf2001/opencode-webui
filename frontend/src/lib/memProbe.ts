/**
 * M4 진단 도구. **측정 전용** — 어떤 상태도 바꾸지 않는다.
 *
 * 사용법(브라우저 콘솔):
 *   __memProbe()                     // 한 번에 전부
 *   setInterval(__memProbe, 60000)   // 1분 간격 추이 관찰
 *
 * dev 빌드에서만 노출한다(prod에는 넣지 않는다).
 */

interface MemProbe {
  heapMB: number
  queryCache: number
  queries: Array<{ key: string; state: string; dataAgeMs: number }>
  moduleMaps: Record<string, number>
  sockets: number
  domNodes: number
  listenersHint: string
}

function countFromReactQuery(): { total: number; list: MemProbe['queries'] } {
  // queryClient는 앱 전역에 하나 있다. 전역 훅을 경유해 접근한다.
  const anyWin = window as unknown as { __queryClient?: unknown }
  const qc = anyWin.__queryClient as
    | { getQueryCache?: () => { getAll: () => Array<{ queryKey: unknown[]; state: { dataUpdatedAt: number; status: string } }> } }
    | undefined
  const cache = qc?.getQueryCache?.()
  const all = cache?.getAll?.() ?? []
  const now = Date.now()
  return {
    total: all.length,
    list: all
      .map((q) => ({
        key: JSON.stringify(q.queryKey),
        state: q.state?.status ?? '?',
        dataAgeMs: now - (q.state?.dataUpdatedAt ?? 0),
      }))
      .sort((a, b) => b.dataAgeMs - a.dataAgeMs)
      .slice(0, 15),
  }
}

export function installMemProbe(register: (fn: () => MemProbe) => void): void {
  if (!import.meta.env.DEV) return
  const fn = (): MemProbe => {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    const qq = countFromReactQuery()
    return {
      heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : -1,
      queryCache: qq.total,
      queries: qq.list,
      moduleMaps: mapSizes(),
      sockets: openSocketCount(),
      domNodes: document.getElementsByTagName('*').length,
      listenersHint: 'DevTools Performance monitor의 JS event listeners를 함께 보세요',
    }
  }
  register(fn)
}

function mapSizes(): Record<string, number> {
  const w = window as unknown as Record<string, unknown>
  const probe = w.__moduleMapSizes as (() => Record<string, number>) | undefined
  return probe ? probe() : {}
}

/** 열려 있는 WebSocket 수. 닫히지 않은 소켓이 원인일 때 바로 드러난다. */
function openSocketCount(): number {
  const w = window as unknown as { __openSockets?: () => number }
  return w.__openSockets ? w.__openSockets() : -1
}