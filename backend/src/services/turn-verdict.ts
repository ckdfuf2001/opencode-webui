/**
 * P0-1: 턴 상태 판정은 폴러 스냅샷으로만 한다.
 * reconcile-wire가 독자 fetch(전역 /session/status)하면 레포 세션이
 * 전역 응답에 없을 때 busy를 idle로 오판한다. 스냅샷이 없거나 오래됐거나,
 * 해당 디렉터리 조회가 실패·미시도면 unknown으로 처리한다.
 * 세션이 응답에 없다는 이유만으로 idle 판정을 하지 않는다.
 * 의존성 없음 — vitest 단위 테스트용.
 */

export type TurnVerdict = 'busy' | 'idle' | 'unknown'

export interface TurnSnapshotInput {
  at: number
  busy: string[]
  okDirs: string[]
  globalOk: boolean
}

const STALE_MS = 15_000

let last: { at: number; busy: Set<string>; okDirs: Set<string>; globalOk: boolean } | null = null

export function recordTurnSnapshot(s: TurnSnapshotInput): void {
  last = { at: s.at, busy: new Set(s.busy), okDirs: new Set(s.okDirs), globalOk: s.globalOk }
}

export function getTurnVerdict(sessionId: string, directory: string | undefined, now?: number): TurnVerdict {
  const snap = last
  if (!snap) return 'unknown'
  if ((now ?? Date.now()) - snap.at > STALE_MS) return 'unknown'
  if (snap.busy.has(sessionId)) return 'busy'
  if (directory !== undefined && directory !== 'global') {
    if (!snap.okDirs.has(directory)) return 'unknown'
    return 'idle'
  }
  return snap.globalOk ? 'idle' : 'unknown'
}

export function resetTurnVerdictForTest(): void {
  last = null
}
