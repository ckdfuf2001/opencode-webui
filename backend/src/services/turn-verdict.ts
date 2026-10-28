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
}

const STALE_MS = 15_000

let last: { at: number; busy: Set<string>; okDirs: Set<string> } | null = null

export function recordTurnSnapshot(s: TurnSnapshotInput): void {
  last = { at: s.at, busy: new Set(s.busy), okDirs: new Set(s.okDirs) }
}

/**
 * P0-1: 폴러 스냅샷으로만 판정한다.
 * - 스냅샷 없음/15초 경과 → unknown (관측 불가).
 * - busy 집합에 있으면 → busy (디렉터리 무관, 긍정 증거).
 * - 디렉터리를 알고 그 조회가 성공했으면, 목록에 없을 때만 idle.
 * - 그 외 (디렉터리 모름·'global'·조회 실패)는 전부 unknown.
 *   전역 응답에 없다는 이유만으로 idle 판정하지 않는다.
 */
export function getTurnVerdict(sessionId: string, directory: string | undefined, now?: number): TurnVerdict {
  const snap = last
  if (!snap) return 'unknown'
  if ((now ?? Date.now()) - snap.at > STALE_MS) return 'unknown'
  if (snap.busy.has(sessionId)) return 'busy'
  if (directory !== undefined && directory !== 'global' && snap.okDirs.has(directory)) return 'idle'
  return 'unknown'
}

export function resetTurnVerdictForTest(): void {
  last = null
}
