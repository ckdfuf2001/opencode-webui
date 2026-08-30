let activeLongRunningRequests = 0

export interface BusyToken {
  release(): void
}

/**
 * 카운터를 잡고 "그 잡은 것만" 되돌리는 토큰을 돌려준다.
 * 전역 clearRequestBusy() 는 잡은 적 없는 요청이 남의 카운트를 깎을 수 있어
 * 신규 코드는 이쪽을 쓴다.
 */
export function acquireBusy(): BusyToken {
  activeLongRunningRequests++
  let released = false
  return {
    release() {
      if (released) return
      released = true
      if (activeLongRunningRequests > 0) {
        activeLongRunningRequests--
      }
    },
  }
}

/** @deprecated acquireBusy() 를 쓸 것. 기존 호출부 호환용. */
export function markRequestBusy(): void {
  activeLongRunningRequests++
}

/** @deprecated acquireBusy() 의 token.release() 를 쓸 것. */
export function clearRequestBusy(): void {
  if (activeLongRunningRequests > 0) {
    activeLongRunningRequests--
  }
}

export function isOpenCodeServerBusy(): boolean {
  return activeLongRunningRequests > 0
}
