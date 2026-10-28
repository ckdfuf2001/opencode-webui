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

export function trackProxyDispatch(sessionID: string, ac: AbortController): void {
  controllers.set(sessionID, ac)
  dispatchedAt.set(sessionID, Date.now())
}

export function untrackProxyDispatch(sessionID: string): void {
  controllers.delete(sessionID)
  dispatchedAt.delete(sessionID)
}

export function noteProxyBusy(sessionID: string): void {
  if (controllers.has(sessionID)) busyObservedAt.set(sessionID, Date.now())
}

/**
 * idle 관측. 발송 이후 busy를 본 in-flight가 있으면 끊고 true를 돌려준다.
 * 호출자가 정상 종료 로그를 남긴다.
 */
export function noteProxyIdle(sessionID: string): boolean {
  const ac = controllers.get(sessionID)
  if (!ac) return false
  if ((busyObservedAt.get(sessionID) ?? 0) >= (dispatchedAt.get(sessionID) ?? 0)) {
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

/** 우리가 직접 끊은 요청인지 확인하고 1회성으로 소비한다. */
export function consumeProxyIdleReleased(sessionID: string): boolean {
  if (!idleReleased.has(sessionID)) return false
  idleReleased.delete(sessionID)
  return true
}

/** B0-6: 추적 중인 직접 전송 dispatch 목록 (발송 시각 포함). */
export function listTrackedDispatches(): Array<{ sessionId: string; since: number }> {
  const out: Array<{ sessionId: string; since: number }> = []
  for (const [sid, ts] of dispatchedAt) {
    if (controllers.has(sid)) out.push({ sessionId: sid, since: ts })
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
}
