import { describe, expect, it } from 'vitest'
import {
  SWAP_FAILED_ATTR,
  SWAPPED_ATTR,
  mergePosMap,
  shouldSwapOleImg,
} from '../src/lib/oleSwapGuard'

/**
 * C7m 1-a/1-b red: swap 실패 표식 분리 + 동일값 setState 스킵.
 * (헬퍼가 아직 없어 import 자체가 실패한다 — red 확인용.)
 */
describe('oleSwapGuard', () => {
  it('실패한 img는 다시 swap하지 않는다', () => {
    expect(shouldSwapOleImg('https://x/lib-icon.png', true, false)).toBe(false)
  })

  it('이미 swap한 img는 다시 swap하지 않는다', () => {
    expect(shouldSwapOleImg('https://x/lib-icon.png', false, true)).toBe(false)
  })

  it('우리 아이콘 src는 swap 대상이 아니다', () => {
    expect(shouldSwapOleImg('http://h/api/collab/embed/icon?path=a&part=b', false, false)).toBe(false)
  })

  it('새 lib img는 1회 swap한다', () => {
    expect(shouldSwapOleImg('https://x/lib-icon.png', false, false)).toBe(true)
  })

  it('표식 상수', () => {
    expect(SWAP_FAILED_ATTR).toBe('data-ole-swap-failed')
    expect(SWAPPED_ATTR).toBe('data-ole-swapped')
  })

  it('posMap이 같으면 이전 객체를 유지한다 (D35)', () => {
    const prev = { p: { x: 1, y: 2, w: 3, h: 4, cover: false } }
    const next = { p: { x: 1, y: 2, w: 3, h: 4, cover: false } }
    expect(mergePosMap(prev, next)).toBe(prev)
  })

  it('posMap이 다르면 새 객체를 쓴다', () => {
    const prev = { p: { x: 1, y: 2, w: 3, h: 4, cover: false } }
    const next = { p: { x: 9, y: 2, w: 3, h: 4, cover: false } }
    expect(mergePosMap(prev, next)).toBe(next)
  })
})
