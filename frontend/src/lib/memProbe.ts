/**
 * M4/M5 메모리 진단 도구. **측정 전용** — 어떤 상태도 바꾸지 않는다.
 *
 * 활성화: URL에 `?memDebug=1`. 기본 off, prod exe에서도 동작한다.
 *   location.search = '?memDebug=1'  또는  '?memDebug=1&memTop=1'
 *
 *   __memProbe()            // 기본 요약(오래된 쿼리 목록 없음)
 *   __memProbe(true)        // 오래된 쿼리 15개까지 추가 출력(할당이 크므로 필요할 때만)
 *   __memFloor()            // 최근 10회 관측의 최솟값(GC 후 바닥선 추세)
 *   setInterval(__memProbe, 60000)
 *
 * heapMB는 performance.memory 의 usedJSHeapSize 다.
 * **아직 회수되지 않은 쓰레기를 포함하므로 단독으로 누수 판정 근거가 되지 않는다.**
 * 판정은 DevTools 쓰레기통(GC) 직후 값, 또는 __memFloor() 바닥선 상승으로 한다.
 */

export interface MemProbeOptions {
  /** 오래된 쿼리 목록을 포함할지 (할당이 크므로 기본 false). */
  verbose?: boolean
}

export interface MemProbeResult {
  /** performance.memory 기반. GC 전 값이라 판정 근거로 쓰지 말 것. */
  heapMB: number
  /** 최근 10회 heapMB 의 최솟값. 시간이 지나며 오르면 그것이 누적 신호. */
  heapFloorMB: number | null
  heapSamples: number
  queryCache: number
  domNodes: number
  openSockets: number
  openEventSources: number
  moduleMaps: Record<string, number>
  queries?: Array<{ key: string; status: string; dataAgeSec: number }>
  note: string
}

const FLOOR_SAMPLES = 10
const samples: number[] = []

function heapUsedBytes(): number {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  return mem?.usedJSHeapSize ?? -1
}

function queryCacheSnapshot(verbose: boolean): { total: number; list?: MemProbeResult['queries'] } {
  const qc = (window as unknown as { __queryClient?: unknown }).__queryClient as
    | {
        getQueryCache?: () => {
          getAll: () => Array<{ queryKey: unknown[]; state: { dataUpdatedAt: number; status: string } }>
        }
      }
    | undefined
  const all = qc?.getQueryCache?.()?.getAll?.() ?? []
  if (!verbose) return { total: all.length }
  const now = Date.now()
  return {
    total: all.length,
    list: all
      .map((q) => ({
        key: JSON.stringify(q.queryKey),
        status: q.state?.status ?? '?',
        dataAgeSec: Math.round((now - (q.state?.dataUpdatedAt ?? 0)) / 1000),
      }))
      .sort((a, b) => b.dataAgeSec - a.dataAgeSec)
      .slice(0, 15),
  }
}

export function probe(opts?: MemProbeOptions): MemProbeResult {
  const used = heapUsedBytes()
  const heapMB = used >= 0 ? Math.round(used / 1048576) : -1
  if (heapMB >= 0) {
    samples.push(heapMB)
    if (samples.length > FLOOR_SAMPLES) samples.shift()
  }
  const floor = samples.length ? Math.min(...samples) : null
  const qq = queryCacheSnapshot(opts?.verbose ?? false)
  return {
    heapMB,
    heapFloorMB: floor,
    heapSamples: samples.length,
    queryCache: qq.total,
    domNodes: document.getElementsByTagName('*').length,
    openSockets: openSocketCount(),
    openEventSources: openEventSourceCount(),
    moduleMaps: moduleMapSizes(),
    ...(qq.list ? { queries: qq.list } : {}),
    note: 'heapMB 는 GC 전 값입니다. 판정은 DevTools GC 직후 값 또는 heapFloorMB 상승으로 하세요.',
  }
}

function moduleMapSizes(): Record<string, number> {
  const fn = (window as unknown as { __moduleMapSizes?: () => Record<string, number> }).__moduleMapSizes
  return fn ? fn() : {}
}

function openSocketCount(): number {
  const fn = (window as unknown as { __openSockets?: () => number }).__openSockets
  return fn ? fn() : -1
}

function openEventSourceCount(): number {
  const fn = (window as unknown as { __openEventSources?: () => number }).__openEventSources
  return fn ? fn() : -1
}

/** ?memDebug=1 일 때만 전역을 설치한다. 기본 off. */
export function installMemProbe(): void {
  if (typeof window === 'undefined') return
  const on = new URLSearchParams(window.location.search).get('memDebug') === '1'
  if (!on) return
  const w = window as unknown as Record<string, unknown>
  w.__memProbe = probe
  w.__memFloor = () => (samples.length ? Math.min(...samples) : null)
  // eslint-disable-next-line no-console
  console.info('[memProbe] 활성 — __memProbe() / __memFloor() / __moduleMapSizes() / __openSockets()')
}