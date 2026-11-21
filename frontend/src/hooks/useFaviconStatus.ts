import { useEffect, useRef } from 'react'

/** F1-4: 브라우저 탭 파비콘 상태 색상. 타이머·점멸·폴링 없음 — 상태가 바뀔 때만 교체. */
export type FaviconState = 'working' | 'pending' | 'cancelled' | 'idle'

export const DEFAULT_FAVICON_HREF = '/favicon.svg'

const STATE_COLORS: Record<Exclude<FaviconState, 'idle'>, string> = {
  // 작업 중 파랑, 승인 대기 주황, 취소 회색.
  working: '#3B82F6',
  pending: '#F59E0B',
  cancelled: '#9CA3AF',
}

/** 헤더 배지와 같은 우선순위: 승인 대기 > 작업 중 > 취소 > 평소. */
export function resolveFaviconState(args: {
  isStreaming?: boolean
  isCancelled?: boolean
  pendingPermissions?: number
}): FaviconState {
  if ((args.pendingPermissions ?? 0) > 0) return 'pending'
  if (args.isStreaming) return 'working'
  if (args.isCancelled) return 'cancelled'
  return 'idle'
}

function stateSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><rect width="400" height="400" rx="80" fill="#0E0E0E"/><path fill-rule="evenodd" clip-rule="evenodd" d="M312 340H88V60H312V340ZM256 116H144V284H256V116Z" fill="${color}"/></svg>`
}

const HREF_CACHE = new Map<FaviconState, string>()

/** 상태별 favicon href. idle은 기본 경로 그대로 (교체 없음과 동일). */
export function faviconHref(state: FaviconState): string {
  if (state === 'idle') return DEFAULT_FAVICON_HREF
  const hit = HREF_CACHE.get(state)
  if (hit) return hit
  const href = `data:image/svg+xml,${encodeURIComponent(stateSvg(STATE_COLORS[state]))}`
  HREF_CACHE.set(state, href)
  return href
}

function currentIconHref(): string | null {
  try {
    const el = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null
    return el?.getAttribute('href') ?? null
  } catch {
    return null
  }
}

function setIconHref(href: string): void {
  try {
    let el = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null
    if (!el) {
      el = document.createElement('link')
      el.setAttribute('rel', 'icon')
      document.head.appendChild(el)
    }
    if (el.getAttribute('href') !== href) el.setAttribute('href', href)
  } catch {
    /* 무시 */
  }
}

/**
 * 세션 헤더 배지와 같은 값을 받아 탭 아이콘을 바꾼다.
 * 언마운트(세션 화면 이탈)하면 원래 href로 복원한다.
 */
export function useFaviconStatus(args: {
  isStreaming?: boolean
  isCancelled?: boolean
  pendingPermissions?: number
}): void {
  const state = resolveFaviconState(args)
  const origRef = useRef<string | null>(null)
  useEffect(() => {
    if (origRef.current == null) origRef.current = currentIconHref() ?? DEFAULT_FAVICON_HREF
    setIconHref(faviconHref(state))
    return () => {
      if (origRef.current != null) setIconHref(origRef.current)
    }
  }, [state])
}
