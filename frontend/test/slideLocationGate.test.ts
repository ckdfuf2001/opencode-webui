import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createSlideGate } from '../src/lib/slideLocationGate'

/**
 * W1 회귀: 슬라이드 1(인덱스 0) 이동이 게시되는지.
 * 실제 모듈(frontend/src/lib/slideLocationGate.ts)을 그대로 검증한다 —
 * 복사본을 재구현하지 않는다 (T1a 방식: 수정 전 게이트로 옮기면 실패해야 한다).
 */
describe('slideLocationGate (W1)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const harness = ({ armed = true }: { armed?: boolean } = {}) => {
    const published: number[] = []
    const applied: number[] = []
    let cur = 0
    const gate = createSlideGate({
      getCurrent: () => cur,
      applyLocal: (i) => {
        cur = i
        applied.push(i)
      },
      // Y1: publish가 세션 없음(=no-op)이어도 applyLocal은 반드시 호출돼야 한다.
      publish: (i) => published.push(i),
    })
    if (armed) gate.arm()
    return { gate, published, applied, getCur: () => cur }
  }

  it('index >= 1 publishes immediately', () => {
    const h = harness()
    h.gate.onIndex(2)
    expect(h.published).toEqual([2])
    h.gate.onIndex(1)
    expect(h.published).toEqual([2, 1])
  })

  it('E19b: 3 → 1 settles on 1 (the W1 bug)', () => {
    const h = harness()
    h.gate.onIndex(2) // 슬라이드 3
    h.gate.onIndex(0) // 슬라이드 1 — 수정 전에는 게시되지 않았다
    vi.advanceTimersByTime(300)
    expect(h.published).toEqual([2, 0])
  })

  it('W1-a: local state applies immediately even for index 0', () => {
    const h = harness()
    h.gate.onIndex(2)
    h.gate.onIndex(0)
    // 게시는 지연되지만 화면 상태는 즉시 0이어야 한다.
    expect(h.applied).toEqual([2, 0])
    expect(h.getCur()).toBe(0)
  })

  it('E19c: rapid 1 → 3 → 1 → 2 leaves exactly the final slide published', () => {
    const h = harness()
    for (const i of [0, 2, 0, 1]) h.gate.onIndex(i)
    // 0은 지연되고 1/2는 즉시 게시된다: 즉 예약된 것은 3번 위치(0 → 1번 슬라이드)다.
    expect(h.published).toEqual([2, 1])
    // 마지막 이동(인덱스 1)은 즉시 게시 경로라 새 예약이 없다.
    expect(h.gate.pending()).toBe(false)
    vi.advanceTimersByTime(300)
    // 지연된 0 게시는 실행 시점 cur=1이므로 게시되지 않는다 (튀는 0 판정).
    expect(h.published).toEqual([2, 1])
  })

  it('W1-b: a spurious 0 right after a move does not publish', () => {
    const h = harness()
    h.gate.onIndex(2) // 실제 이동
    h.gate.onIndex(0) // 리렌더성 튐
    h.gate.onIndex(2) // 실제 이동으로 예약 취소
    vi.advanceTimersByTime(1000)
    expect(h.published).toEqual([2, 2])
  })

  it('dispose cancels a pending zero publish', () => {
    const h = harness()
    h.gate.onIndex(2)
    h.gate.onIndex(0)
    expect(h.gate.pending()).toBe(true)
    h.gate.dispose()
    vi.advanceTimersByTime(1000)
    expect(h.published).toEqual([2])
    expect(h.gate.pending()).toBe(false)
  })

  it('negative/NaN indices are clamped, never throw', () => {
    const h = harness()
    h.gate.onIndex(-3)
    h.gate.onIndex(Number.NaN)
    expect(h.applied).toEqual([0, 0])
    vi.advanceTimersByTime(300)
    expect(h.published).toEqual([0])
  })

  // Y1: 게이트는 세션 유무와 무관하게 살아 있어야 한다. publish가 no-op이어도
  // 화면 상태는 즉시 갱신되어야 한다 (혼자 편집할 때 썸네일이 멈추면 안 된다).
  it('Y1: applyLocal runs even when publishing is a no-op (no session)', () => {
    const applied: number[] = []
    let cur = 0
    const gate = createSlideGate({
      getCurrent: () => cur,
      applyLocal: (i) => {
        cur = i
        applied.push(i)
      },
      publish: () => {
        /* 세션 없음 = no-op */
      },
    })
    gate.arm()
    gate.onIndex(2)
    gate.onIndex(0)
    expect(applied).toEqual([2, 0])
    expect(cur).toBe(0)
    vi.advanceTimersByTime(300)
  })

  // Y2: parse 전 lib이 내보내는 0(마운트 직후 activeSlideIndex 초기값)은 무시한다.
  it('Y2: a pre-parse 0 is ignored entirely (no local, no publish)', () => {
    const h = harness({ armed: false })
    h.gate.onIndex(0)
    expect(h.applied).toEqual([])
    expect(h.published).toEqual([])
    expect(h.gate.pending()).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(h.published).toEqual([])
  })

  it('Y2: after arm the normal W1 rules resume', () => {
    const h = harness({ armed: false })
    h.gate.onIndex(2)
    h.gate.arm()
    h.gate.onIndex(2)
    expect(h.applied).toEqual([2])
    expect(h.published).toEqual([2])
  })

  // Y2: 리마운트 = disarm + 다시 arm. 그 사이 0이 와도 위치가 0으로 돌아가지 않는다.
  it('Y2: disarm → spurious 0 → re-arm keeps the position', () => {
    const h = harness()
    h.gate.onIndex(2) // 슬라이드 3
    h.gate.disarm() // 리마운트
    h.gate.onIndex(0) // parse 전 초기값
    expect(h.getCur()).toBe(2)
    expect(h.published).toEqual([2])
    h.gate.arm()
    h.gate.onIndex(2) // parse 후 실제 인덱스
    expect(h.getCur()).toBe(2)
    expect(h.published).toEqual([2, 2])
  })

  it('Y2: disarm cancels a pending zero publish', () => {
    const h = harness()
    h.gate.onIndex(2)
    h.gate.onIndex(0)
    expect(h.gate.pending()).toBe(true)
    h.gate.disarm()
    expect(h.gate.pending()).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(h.published).toEqual([2])
  })
})