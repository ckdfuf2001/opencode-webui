let activeLongRunningRequests = 0

export function markRequestBusy(): void {
  activeLongRunningRequests++
}

export function clearRequestBusy(): void {
  if (activeLongRunningRequests > 0) {
    activeLongRunningRequests--
  }
}

export function isOpenCodeServerBusy(): boolean {
  return activeLongRunningRequests > 0
}