import { describe, it, expect } from 'vitest'
import { acquireCollabSession, dropCollabSession, releaseCollabSession, collabSessionCount } from '../src/lib/collabSessionRegistry'

/**
 * M2: 닫은 뒤에도 공동편집 세션이 살아 있던 문제의 계약 테스트.
 *
 * 레지스트리는 acquire/release refs로 짝을 맞춘다. 한쪽만 호출하면 그 세션은
 * WebSocket과 재연결 타이머를 그대로 가진 채 영구히 살아 있다(registry 항목이 남으므로).
 */
type FakeSession = { destroy: () => void }

const makeFake = (): FakeSession & { destroyed: number } => {
  const s = { destroyed: 0, destroy() { this.destroyed += 1 } }
  return s
}

describe('collabSessionRegistry (M2)', () => {
  it('M2-1: release without a matching acquire keeps nothing behind', () => {
    const before = collabSessionCount()
    // acquire가 없는 경로에 release를 걸어도 항목이 생기면 안 된다.
    releaseCollabSession('never-acquired/x', () => {})
    expect(collabSessionCount()).toBe(before)
  })

  it('M2-2: acquire -> release destroys the session and empties the registry', () => {
    const s = makeFake()
    acquireCollabSession('a.pptx', () => s as never, () => {})
    expect(collabSessionCount()).toBeGreaterThan(0)
    releaseCollabSession('a.pptx', (x) => (x as unknown as FakeSession).destroy())
    expect(s.destroyed).toBe(1)
  })

  it('M2-3: two acquirers -> the session survives until the last release', () => {
    const s = makeFake()
    const a = acquireCollabSession('b.pptx', () => s as never, () => {})
    const b = acquireCollabSession('b.pptx', () => makeFake() as never, () => {})
    expect(a.session).toBe(b.session)
    expect(a.reused).toBe(false)
    expect(b.reused).toBe(true)
    releaseCollabSession('b.pptx', (x) => (x as unknown as FakeSession).destroy())
    // 첫 release는 살아 있어야 한다 (다른 뷰어가 쓰고 있다).
    expect(s.destroyed).toBe(0)
    releaseCollabSession('b.pptx', (x) => (x as unknown as FakeSession).destroy())
    expect(s.destroyed).toBe(1)
  })

  it('M2-4: drop removes a reset session immediately (no reuse of a dead session)', () => {
    const dead = makeFake()
    const fresh = makeFake()
    acquireCollabSession('c.pptx', () => dead as never, () => {})
    // 4001 reset 경로: 항목 즉시 제거 + 파괴.
    dropCollabSession('c.pptx', dead as never)
    expect(dead.destroyed).toBe(1)
    // 같은 경로로 다시 들어오면 죽은 세션이 재사용되지 않는다.
    const again = acquireCollabSession('c.pptx', () => fresh as never, () => {})
    expect(again.session).toBe(fresh as never)
    expect(again.reused).toBe(false)
    releaseCollabSession('c.pptx', (x) => (x as unknown as FakeSession).destroy())
  })

  it('M2-5: drop only fires for the session that still owns the entry', () => {
    const s = makeFake()
    const other = makeFake()
    acquireCollabSession('d.pptx', () => s as never, () => {})
    // 다른 세션이 drop을 요청하면 아무 일도 일어나지 않아야 한다.
    dropCollabSession('d.pptx', other as never)
    expect(other.destroyed).toBe(0)
    releaseCollabSession('d.pptx', (x) => (x as unknown as FakeSession).destroy())
    expect(s.destroyed).toBe(1)
  })

  it('M2-6: 20 acquire/release cycles leave no entries', () => {
    const base = collabSessionCount()
    for (let i = 0; i < 20; i++) {
      const s = makeFake()
      acquireCollabSession(`cycle-${i}.pptx`, () => s as never, () => {})
      releaseCollabSession(`cycle-${i}.pptx`, (x) => (x as unknown as FakeSession).destroy())
      expect(s.destroyed).toBe(1)
    }
    expect(collabSessionCount()).toBe(base)
  })
})