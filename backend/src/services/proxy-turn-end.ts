/**
 * B0-3: 직접 전송(proxy) 경로의 턴 종료 감지.
 * 큐 경로(releaseInFlightOnIdle, busyObservedAt)와 같은 규칙을 적용한다.
 * 발송 이후 busy를 한 번 관측하고, 그다음 idle을 관측하면 붙어 있는
 * 업스트림 요청을 abort한다. busy를 관측하지 못하면 끊지 않는다(오발 방지).
 * 우리가 직접 끊은 경우는 오류가 아니라 정상 종료로 기록한다.
 * 클라이언트 단절을 업스트림에 전파하지 않는다(D46).
 * 의존성 없음 — vitest 단위 테스트용.
 */

const controllers = new Map<string, AbortController>()
const dispatchedAt = new Map<string, number>()
const busyObservedAt = new Map<string, number>()
const idleReleased = new Set<string>()
/** P1-3: idle 1회째 관측 시각 (유예 후에도 idle이어야 끊는다). */
const idleSince = new Map<string, number>()
/** P0-1: 폴러 스냅샷 대조용 디렉터리. */
const trackDirs = new Map<string, string>()
/** P1-3: abort 유예 (폴러 1초 주기 대비 여유). */
export const PROXY_IDLE_GRACE_MS = 3_000

export function trackProxyDispatch(sessionID: string, ac: AbortController, directory?: string): void {
  controllers.set(sessionID, ac)
  dispatchedAt.set(sessionID, Date.now())
  // 이전 턴 관측이 다음 발송 판단에 섞이지 않게 초기화한다.
  busyObservedAt.delete(sessionID)
  idleSince.delete(sessionID)
  if (directory) trackDirs.set(sessionID, directory)
  else trackDirs.delete(sessionID)
}

export function untrackProxyDispatch(sessionID: string): void {
  controllers.delete(sessionID)
  dispatchedAt.delete(sessionID)
  idleSince.delete(sessionID)
  trackDirs.delete(sessionID)
}

export function noteProxyBusy(sessionID: string): void {
  if (!controllers.has(sessionID)) return
  busyObservedAt.set(sessionID, Date.now())
  // busy가 다시 오면 idle 유예는 처음부터 잰다.
  idleSince.delete(sessionID)
}

/**
 * idle 관측. 발송 이후 busy를 본 in-flight가 있고, 유예(PROXY_IDLE_GRACE_MS)를
 * 넘겨도 idle이면 끊고 true를 돌려준다. 호출자가 정상 종료 로그를 남긴다.
 * nowMs는 테스트용(기본 Date.now()).
 */
export function noteProxyIdle(sessionID: string, nowMs?: number): boolean {
  const ac = controllers.get(sessionID)
  if (!ac) return false
  if ((busyObservedAt.get(sessionID) ?? 0) >= (dispatchedAt.get(sessionID) ?? 0)) {
    const now = nowMs ?? Date.now()
    const first = idleSince.get(sessionID)
    if (first === undefined) {
      idleSince.set(sessionID, now)
      return false
    }
    if (now - first < PROXY_IDLE_GRACE_MS) return false
    idleSince.delete(sessionID)
    idleReleased.add(sessionID)
    try {
      ac.abort()
    } catch {
      /* 무시 */
    }
    return true
  }
  return false
}

type TurnVerdictLike = 'busy' | 'idle' | 'unknown'

/**
 * P0-1: 매 틱 추적 중인 dispatch를 폴러 스냅샷 판정으로 처리한다.
 * - busy → noteProxyBusy (유예 리셋).
 * - idle → noteProxyIdle (유예 뒤 abort, true면 released에 담아 반환).
 * - unknown → clearProxyIdle (유예 취소, 끊지 않음). 응답 부재를 idle로 보지 않는다.
 * nowMs는 테스트용(기본 Date.now()).
 */
export function pumpTrackedIdle(
  getVerdict: (sessionId: string, directory?: string) => TurnVerdictLike,
  nowMs?: number,
): string[] {
  const released: string[] = []
  for (const d of listTrackedDispatches()) {
    let verdict: TurnVerdictLike
    try {
      verdict = getVerdict(d.sessionId, d.directory)
    } catch {
      continue
    }
    if (verdict === 'busy') {
      noteProxyBusy(d.sessionId)
      continue
    }
    if (verdict === 'unknown') {
      clearProxyIdle(d.sessionId)
      continue
    }
    if (noteProxyIdle(d.sessionId, nowMs)) released.push(d.sessionId)
  }
  return released
}

/** P0-1: idle 유예를 취소한다 (판정 unknown/busy 시). */
export function clearProxyIdle(sessionID: string): void {
  idleSince.delete(sessionID)
}

/** 우리가 직접 끊은 요청인지 확인하고 1회성으로 소비한다. */
export function consumeProxyIdleReleased(sessionID: string): boolean {
  if (!idleReleased.has(sessionID)) return false
  idleReleased.delete(sessionID)
  return true
}

/** B0-6: 추적 중인 직접 전송 dispatch 목록 (발송 시각·디렉터리 포함). */
export function listTrackedDispatches(): Array<{ sessionId: string; since: number; directory?: string }> {
  const out: Array<{ sessionId: string; since: number; directory?: string }> = []
  for (const [sid, ts] of dispatchedAt) {
    if (controllers.has(sid)) out.push({ sessionId: sid, since: ts, directory: trackDirs.get(sid) })
  }
  return out
}

/**
 * B0-6 sweep용 abort — 정상 종료로 기록한다(프록시 catch/finally가 소비해
 * 오류가 아니라 정상 종료 로그를 남긴다). 추적은 유지해 settle 시 정리한다.
 */
export function sweepAbortTracked(sessionID: string): boolean {
  const ac = controllers.get(sessionID)
  if (!ac) return false
  idleReleased.add(sessionID)
  try {
    ac.abort()
  } catch {
    /* 무시 */
  }
  return true
}

export function resetProxyTurnEndForTest(): void {
  controllers.clear()
  dispatchedAt.clear()
  busyObservedAt.clear()
  idleReleased.clear()
  idleSince.clear()
  trackDirs.clear()
}
