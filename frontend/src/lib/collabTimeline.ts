/**
 * M11: collab 진단 타임라인 (측정 전용, 동작 변경 없음).
 *
 * ?collabDebug=1 일 때만 window.__collabTimeline 에 이벤트를 쌓는다.
 * 최대 300개(넘으면 앞을 버린다). 내용 변경은 없고, 읽기 전용으로만 쓴다.
 */

export interface CollabTimelineEntry {
  /**performance.now() 기준 ms */
  t: number
  evt: string
  [k: string]: unknown
}

const MAX = 300

function store(): { list: CollabTimelineEntry[] } | null {
  try {
    const w = window as unknown as { __collabTimeline?: { list: CollabTimelineEntry[] }; __collabDebug?: { collabDebug?: boolean } }
    if (!w.__collabTimeline) w.__collabTimeline = { list: [] }
    return w.__collabTimeline
  } catch {
    return null
  }
}

/** 타임라인에 이벤트 1건을 추가한다. */
export function tl(evt: string, data?: Record<string, unknown>): void {
  try {
    // collabDebug=1 일 때만 수집한다(프로덕션 부하 0).
    if (new URLSearchParams(window.location.search).get('collabDebug') !== '1') return
    const s = store()
    if (!s) return
    s.list.push({ t: Math.round(performance.now()), evt, ...(data ?? {}) })
    if (s.list.length > MAX) s.list.splice(0, s.list.length - MAX)
  } catch {
    // 계측 실패가 앱을 막지 않게 한다.
  }
}

/** 타임라인 스냅샷. */
export function tlDump(): CollabTimelineEntry[] {
  try {
    const s = store()
    return s ? [...s.list] : []
  } catch {
    return []
  }
}

/** 호출 스택 상위 N줄(계측용). */
export function tlStack(n = 3): string {
  try {
    return (new Error().stack ?? '').split('\n').slice(2, 2 + n).join(' | ').trim()
  } catch {
    return ''
  }
}
