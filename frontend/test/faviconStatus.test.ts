import { describe, expect, it } from 'vitest'
import { resolveFaviconState, faviconHref } from '@/hooks/useFaviconStatus'

/**
 * F1-4: 브라우저 탭 아이콘 상태 색상 (unit red).
 * 우선순위: 승인 대기 > 작업 중 > 취소 > 평소.
 */
describe('resolveFaviconState', () => {
  it('평소에는 idle', () => {
    expect(resolveFaviconState({ isStreaming: false, isCancelled: false, pendingPermissions: 0 })).toBe('idle')
  })
  it('작업 중은 working', () => {
    expect(resolveFaviconState({ isStreaming: true, isCancelled: false, pendingPermissions: 0 })).toBe('working')
  })
  it('승인 대기가 작업 중보다 우선한다', () => {
    expect(resolveFaviconState({ isStreaming: true, isCancelled: false, pendingPermissions: 2 })).toBe('pending')
  })
  it('승인 대기가 취소보다 우선한다', () => {
    expect(resolveFaviconState({ isStreaming: false, isCancelled: true, pendingPermissions: 1 })).toBe('pending')
  })
  it('취소는 idle보다 우선한다', () => {
    expect(resolveFaviconState({ isStreaming: false, isCancelled: true, pendingPermissions: 0 })).toBe('cancelled')
  })
})

describe('faviconHref', () => {
  it('idle은 기본 아이콘 경로 그대로', () => {
    expect(faviconHref('idle')).toBe('/favicon.svg')
  })
  it('상태별 data URL에 해당 색이 들어간다', () => {
    expect(faviconHref('working')).toContain('data:image/svg+xml')
    expect(faviconHref('working')).toContain('%233B82F6')
    expect(faviconHref('pending')).toContain('%23F59E0B')
    expect(faviconHref('cancelled')).toContain('%239CA3AF')
  })
  it('data URL에 allow-scripts 같은 실행 흔적이 없다', () => {
    for (const s of ['working', 'pending', 'cancelled'] as const) {
      expect(faviconHref(s)).not.toMatch(/script/i)
    }
  })
})
