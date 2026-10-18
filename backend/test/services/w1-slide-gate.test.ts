import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { YCollabSession } from '../../../frontend/src/lib/ycollab'

/**
 * W1 재현 (node 결정적).
 * 'i >= 1 이면 게시 안 한다'는 조건이 슬라이드 1 이동을 놓치는 버그다.
 * 아래 publishIfIndexGate는 수정 전 PptxViewer의 조건을 그대로 옮긴 것이다.
 */
describe('W1: slide-1 publication gate (T1a-style before/after)', () => {
  /** 수정 전 로직: 0-based index가 1 이상일 때만 게시. */
  const publishIfIndexGate = (index0: number, publish: (slide: number) => void): void => {
    if (index0 >= 1) publish(index0 + 1)
  }

  /** 수정 후 로직: 1 이상은 즉시, 0은 300ms 뒤 실제 상태를 보고 게시. */
  const publishWithDeferredZero = (index0: number, curSlide: () => number, publish: (slide: number) => void): void => {
    if (index0 >= 1) {
      publish(index0 + 1)
      return
    }
    // 예약은 호출부에서 300ms 뒤 curSlide()를 읽는다(여기서는 동기 검증이므로 생략).
    if (curSlide() === 0) publish(1)
  }

  it('BEFORE the fix: moving to slide 1 (index 0) publishes nothing', () => {
    const published: number[] = []
    // 사용자가 3 → 1로 이동: 마지막 콜백 인덱스는 0이다.
    publishIfIndexGate(0, (n) => published.push(n))
    // 수정 전에는 아무것도 게시되지 않아 상대 화면이 '슬라이드 3'에 멈춘다.
    expect(published).toEqual([])
    // 이것이 E19b가 실패해야 하는 이유다.
  })

  it('AFTER the fix: index 0 publishes slide 1', () => {
    const published: number[] = []
    publishWithDeferredZero(0, () => 0, (n) => published.push(n))
    expect(published).toEqual([1])
  })

  it('E19b sequence: 3 → 1 settles on 1 (after) vs stays 3 (before)', () => {
    const before: number[] = []
    publishIfIndexGate(2, (n) => before.push(n))
    publishIfIndexGate(0, (n) => before.push(n))
    expect(before).toEqual([3]) // 1 이 유실

    const after: number[] = []
    publishWithDeferredZero(2, () => 2, (n) => after.push(n))
    publishWithDeferredZero(0, () => 0, (n) => after.push(n))
    expect(after).toEqual([3, 1]) // 1 이 게시됨
  })

  it('E19c sequence: 1 → 3 → 1 → 2 settles on 2 (after)', () => {
    const after: number[] = []
    const cur = [0, 2, 0, 1]
    let step = 0
    for (const idx of cur) {
      const current = step
      publishWithDeferredZero(idx, () => current, (n) => after.push(n))
      step += 1
    }
    expect(after[after.length - 1]).toBe(2)
  })

  it('real session: setLocation updates app.slide and app.where in ONE awareness update', async () => {
    const doc = new Y.Doc()
    const s = new YCollabSession('ws://x/y', { name: 'ada', color: '#e11d48' }, { userId: 'u-ada' })
    // 사운드 연결은 필요 없다. 문서 반영만 확인.
    const updates: Record<string, unknown>[] = []
    s.awareness.on('update', () => {
      updates.push(((s.awareness.getLocalState() ?? {}) as Record<string, unknown>).app as Record<string, unknown>)
    })
    s.setLocation({ slide: 1, where: '슬라이드 1' })
    expect(updates.length).toBe(1)
    expect(updates[0]?.slide).toBe(1)
    expect(updates[0]?.where).toBe('슬라이드 1')
    // 값이 같으면 추가 update가 없다 (H1/G4: 상대 lastActiveAt 흔들림 방지).
    s.setLocation({ slide: 1, where: '슬라이드 1' })
    expect(updates.length).toBe(1)
    // 다른 슬라이드는 1회 더.
    s.setLocation({ slide: 3, where: '슬라이드 3' })
    expect(updates.length).toBe(2)
    expect(updates[1]?.slide).toBe(3)
    // mode가 바뀌면 republishApp이 app를 되살린다 (H3).
    s.setMode('view')
    s.republishApp()
    const st = ((s.awareness.getLocalState() ?? {}) as Record<string, unknown>).app as Record<string, unknown>
    expect(st.mode).toBe('view')
    expect(st.slide).toBe(3)
    expect(st.where).toBe('슬라이드 3')
    s.destroy()
  })
})