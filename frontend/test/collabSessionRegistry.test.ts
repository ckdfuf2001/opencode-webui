import { describe, it, expect } from 'vitest'
import * as registryModule from '../src/lib/collabSessionRegistry'
import { acquireCollabSession, dropCollabSession, collabSessionCount, collabSessionRefs } from '../src/lib/collabSessionRegistry'

/**
 * M3/N1: release는 경로가 아니라 토큰(lease) 기준이어야 한다.
 *
 * 342035c의 경로 기반 releaseCollabSession + "c가 null이어도 무조건 release" 조합은
 * 두 가지로 남의 세션을 죽인다.
 *  - acquire하지 않은 뷰어가 언마운트하면 남의 refs를 깎는다.
 *  - drop 후 새 세션이 acquire된 상태에서 옛 보유자가 release하면 새 세션이 죽는다.
 */
type Fake = { destroy: () => void; destroyed: number }
const fake = (): Fake => ({ destroyed: 0, destroy() { this.destroyed += 1 } })
const use = <T>(s: unknown): T => s as T

describe('collabSessionRegistry lease (M3/N1)', () => {
  it('R1: A releases twice while B holds it — B survives', () => {
    const s = fake()
    const a = acquireCollabSession('r1.pptx', () => use<Fake>(s) as never, () => {})
    const b = acquireCollabSession('r1.pptx', () => fake() as never, () => {})
    expect(b.session).toBe(a.session)
    a.release()
    a.release() // 두 번째는 무효여야 한다.
    expect(s.destroyed).toBe(0)
    expect(collabSessionRefs('r1.pptx')).toBe(1)
    b.release()
    expect(s.destroyed).toBe(1)
  })

  it('R2: the path-based release API is gone, so a non-acquiring mount cannot disturb the holder', () => {
    const s = fake()
    const holder = acquireCollabSession('r2.pptx', () => use<Fake>(s) as never, () => {})
    // N1 요구사항: 토큰 없이 release할 수 있는 경로 자체를 없앤다.
    // 이전 API(path 기반 release)가 남아 있으면 acquire하지 않은 뷰어가 남의 refs를
    // 깎을 수 있으므로, export가 존재하지 않음을 명시적으로 고정한다.
    const mod = registryModule as Record<string, unknown>
    expect(mod.releaseCollabSession, 'path-based release must not be exported').toBeUndefined()
    // 보유자 세션은 그대로 살아 있다.
    expect(s.destroyed).toBe(0)
    expect(collabSessionRefs('r2.pptx')).toBe(1)
    holder.release()
    expect(s.destroyed).toBe(1)
  })

  it('R3: after drop, an old lease release must not kill the new session', () => {
    const dead = fake()
    const fresh = fake()
    const old = acquireCollabSession('r3.pptx', () => use<Fake>(dead) as never, () => {})
    const peer = acquireCollabSession('r3.pptx', () => fake() as never, () => {})
    dropCollabSession('r3.pptx', use<Fake>(dead) as never)
    expect(dead.destroyed).toBe(1)
    // 새 세션이 같은 경로에 들어온다.
    const next = acquireCollabSession('r3.pptx', () => use<Fake>(fresh) as never, () => {})
    expect(next.reused).toBe(false)
    const refsBefore = collabSessionRefs('r3.pptx')
    // 옛 보유자들이 늦게 release를 부르지만 새 세션은 살아 있어야 한다.
    old.release()
    peer.release()
    expect(fresh.destroyed).toBe(0)
    expect(collabSessionRefs('r3.pptx')).toBe(refsBefore)
    next.release()
    expect(fresh.destroyed).toBe(1)
  })

  it('R4: registry empties after 20 acquire/release cycles', () => {
    const base = collabSessionCount()
    for (let i = 0; i < 20; i++) {
      const s = fake()
      const lease = acquireCollabSession(`cycle-${i}.pptx`, () => use<Fake>(s) as never, () => {})
      lease.release()
      expect(s.destroyed).toBe(1)
    }
    expect(collabSessionCount()).toBe(base)
  })

  it('R5: drop notifies every holder of that session exactly once (N2)', () => {
    const s = fake()
    const a = acquireCollabSession('r5.pptx', () => use<Fake>(s) as never, () => {})
    const b = acquireCollabSession('r5.pptx', () => fake() as never, () => {})
    let aHits = 0
    let bHits = 0
    a.onReset(() => { aHits += 1 })
    b.onReset(() => { bHits += 1 })
    dropCollabSession('r5.pptx', use<Fake>(s) as never)
    expect(aHits).toBe(1)
    expect(bHits).toBe(1)
    // 통지 뒤 release는 조용히 무시된다(이미 제거됨).
    a.release()
    b.release()
    expect(collabSessionCount()).toBe(0)
  })

  it('R6: subscribing after a drop fires immediately (no silent dead session)', () => {
    const s = fake()
    const lease = acquireCollabSession('r6.pptx', () => use<Fake>(s) as never, () => {})
    dropCollabSession('r6.pptx', use<Fake>(s) as never)
    let hits = 0
    lease.onReset(() => { hits += 1 })
    expect(hits).toBe(1)
  })
})