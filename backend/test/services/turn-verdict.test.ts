import { describe, expect, it } from 'vitest'
import {
  getTurnVerdict,
  recordTurnSnapshot,
  resetTurnVerdictForTest,
} from '../../src/services/turn-verdict'

describe('turn-verdict (P0-1)', () => {
  it('스냅샷이 없으면 unknown', () => {
    resetTurnVerdictForTest()
    expect(getTurnVerdict('s1', 'd1', 1000)).toBe('unknown')
  })

  it('스냅샷이 오래되면 unknown', () => {
    resetTurnVerdictForTest()
    recordTurnSnapshot({ at: 1000, busy: [], okDirs: ['d1'], globalOk: true })
    expect(getTurnVerdict('s1', 'd1', 1000 + 16_000)).toBe('unknown')
  })

  it('busy 목록에 있으면 busy (디렉터리 무관)', () => {
    resetTurnVerdictForTest()
    recordTurnSnapshot({ at: 1000, busy: ['s1'], okDirs: ['d1'], globalOk: true })
    expect(getTurnVerdict('s1', 'other-dir', 1000)).toBe('busy')
  })

  it('디렉터리 조회 성공 + 목록에 없으면 idle', () => {
    resetTurnVerdictForTest()
    recordTurnSnapshot({ at: 1000, busy: [], okDirs: ['d1'], globalOk: true })
    expect(getTurnVerdict('s1', 'd1', 1000)).toBe('idle')
  })

  it('디렉터리 조회 실패·미시도면 unknown (응답 부재 ≠ idle)', () => {
    resetTurnVerdictForTest()
    recordTurnSnapshot({ at: 1000, busy: [], okDirs: ['d1'], globalOk: true })
    expect(getTurnVerdict('s1', 'd2', 1000)).toBe('unknown')
  })

  it('디렉터리 모르면 전역 커버리지에만 의존한다', () => {
    resetTurnVerdictForTest()
    recordTurnSnapshot({ at: 1000, busy: [], okDirs: ['d1'], globalOk: true })
    expect(getTurnVerdict('s1', undefined, 1000)).toBe('idle')
    recordTurnSnapshot({ at: 1000, busy: [], okDirs: ['d1'], globalOk: false })
    expect(getTurnVerdict('s1', undefined, 1000)).toBe('unknown')
  })
})
