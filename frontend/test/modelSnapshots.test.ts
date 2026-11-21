import { describe, expect, it } from 'vitest'
import { classifyModelSnapshot } from '@/lib/modelSnapshots'

/**
 * F1-1: 새로고침 스냅샷 비교 (추가/유지/없어짐 분류).
 */
describe('classifyModelSnapshot', () => {
  it('추가/유지/없어짐을 구분한다', () => {
    const r = classifyModelSnapshot(['a', 'b'], [{ id: 'b' }, { id: 'c' }])
    expect(r.kept).toEqual(['b'])
    expect(r.added).toEqual(['c'])
    expect(r.removed).toEqual(['a'])
  })
  it('빈 스냅샷이면 전부 추가, 빈 목록이면 전부 없어짐', () => {
    expect(classifyModelSnapshot([], [{ id: 'a' }])).toEqual({ added: ['a'], kept: [], removed: [] })
    expect(classifyModelSnapshot(['a'], [])).toEqual({ added: [], kept: [], removed: ['a'] })
  })
  it('중복 id는 하나로 취급한다', () => {
    const r = classifyModelSnapshot(['a', 'a', 'b'], [{ id: 'b' }, { id: 'b' }, { id: 'c' }])
    expect(r.kept).toEqual(['b'])
    expect(r.added).toEqual(['c'])
    expect(r.removed).toEqual(['a'])
  })
  it('순서는 스냅샷·현재 목록 순서를 유지한다', () => {
    const r = classifyModelSnapshot(['b', 'a'], [{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    expect(r.kept).toEqual(['b', 'a'])
    expect(r.added).toEqual(['c'])
  })
})
