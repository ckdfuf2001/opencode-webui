import { describe, it, expect } from 'vitest'
import { shouldShowPresence } from '../src/components/collab/collabPresenceView'

/**
 * R-ribbon 회귀(C6): 타이틀바 actions 슬롯에는 joined + 피어 1명 이상일 때만
 * presence Shell/Bar를 마운트한다. 슬롯 존재만으로 빈 막대를 꽂으면
 * (px-3 py-1 border-b) 타이틀바 레이아웃이 밀려 리본 스냅샷(328px)이 깨진다.
 * xlsx/docx 공용 게이트 — 형식별 조건 복사를 두지 않는다.
 */
describe('shouldShowPresence (R-ribbon gate)', () => {
  it('solo(joined=false, 0명)는 마운트하지 않는다', () => {
    expect(shouldShowPresence(false, 0)).toBe(false)
  })

  it('joined이지만 피어가 0명이면 마운트하지 않는다', () => {
    expect(shouldShowPresence(true, 0)).toBe(false)
  })

  it('joined이고 피어가 1명 이상이면 마운트한다', () => {
    expect(shouldShowPresence(true, 1)).toBe(true)
    expect(shouldShowPresence(true, 2)).toBe(true)
  })

  it('joined 전에는 피어가 있어도 마운트하지 않는다', () => {
    expect(shouldShowPresence(false, 3)).toBe(false)
  })
})
