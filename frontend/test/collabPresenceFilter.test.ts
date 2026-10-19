import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  stripCursorFields,
  onlyPresenceNoiseChanged,
  createAwarenessThrottle,
  CURSOR_KEYS,
  PRESENCE_NOISE_KEYS,
} from '../src/lib/collabPresenceFilter'

/**
 * D26 회귀: 원격 마우스 커서를 게시하지 않는다.
 *
 * 수정 전에는 포인터 이동마다 presence 전체가 awareness로 나가서
 * (BROADCAST_THROTTLE_MS=50 → 초당 20회) 송신·직렬화와 수신 측 projector
 * 재계산이 반복됐다. 이 테스트는 커서 좌표가 wire에서 사라지는지와
 * 선택/슬라이드 정보는 살아남는지를 함께 고정한다.
 */
describe('collabPresenceFilter (D26)', () => {
  it('presence의 커서 좌표를 제거한다', () => {
    const out = stripCursorFields({
      presence: { userName: 'ada', userColor: '#f00', activeSlideIndex: 2, cursorX: 120, cursorY: 80 },
    }) as { presence: Record<string, unknown> }
    expect(out.presence.cursorX).toBeUndefined()
    expect(out.presence.cursorY).toBeUndefined()
    expect(out.presence.userName).toBe('ada')
    expect(out.presence.activeSlideIndex).toBe(2)
  })

  it('원본 state는 건드리지 않는다 (로컬 state 불변)', () => {
    const original = { presence: { cursorX: 1, cursorY: 2, userName: 'ada' } }
    stripCursorFields(original)
    expect(original.presence.cursorX).toBe(1)
    expect(original.presence.cursorY).toBe(2)
  })

  it('최상위 커서 키도 제거한다 (구버전 클라이언트 방어)', () => {
    const out = stripCursorFields({ cursorX: 5, cursorY: 6, app: { id: 'u-ada' } }) as Record<string, unknown>
    expect(out.cursorX).toBeUndefined()
    expect(out.cursorY).toBeUndefined()
    expect(out.app).toEqual({ id: 'u-ada' })
  })

  it('선택 정보는 살아남는다 (E3 원격 선택 외곽선 회귀 방지)', () => {
    const out = stripCursorFields({
      presence: { userName: 'ada', selectedElementId: 'shape-7', cursorX: 3, cursorY: 4 },
    }) as { presence: Record<string, unknown> }
    expect(out.presence.selectedElementId).toBe('shape-7')
  })

  it('커서가 없을 않으면 같은 참조를 돌려준다 (불필요한 재직렬화 방지)', () => {
    const state = { presence: { userName: 'ada' }, app: { id: 'u-ada' } }
    expect(stripCursorFields(state)).toBe(state)
  })

  it('제거 후 남은 presence가 비어도 presence 키는 유지한다 (제거 표시가 아니라 빈 객체)', () => {
    const out = stripCursorFields({ presence: { cursorX: 1, cursorY: 2 } }) as { presence: unknown }
    expect('presence' in out).toBe(true)
    expect(out.presence).toEqual({})
  })

  it('CURSOR_KEYS는 좌표 두 개뿐이다', () => {
    expect([...CURSOR_KEYS]).toEqual(['cursorX', 'cursorY'])
  })

  it('PRESENCE_NOISE_KEYS에는 lastUpdated가 들어 있다 (포인터 이동마다 함께 찍힌다)', () => {
    expect([...PRESENCE_NOISE_KEYS]).toEqual(['cursorX', 'cursorY', 'lastUpdated'])
  })
})

describe('onlyPresenceNoiseChanged (D26)', () => {
  it('좌표와 lastUpdated만 바뀌면 noise로 본다', () => {
    const a = { presence: { userName: 'ada', cursorX: 1, cursorY: 1, lastUpdated: '2026-01-01T00:00:00.000Z' } }
    const b = { presence: { userName: 'ada', cursorX: 99, cursorY: 88, lastUpdated: '2026-01-01T00:00:09.000Z' } }
    expect(onlyPresenceNoiseChanged(a, b)).toBe(true)
  })

  it('lastUpdated만 바뀌어도 noise다 (lib 10초 재게시 경로)', () => {
    const a = { presence: { userName: 'ada', lastUpdated: '2026-01-01T00:00:00.000Z' } }
    const b = { presence: { userName: 'ada', lastUpdated: '2026-01-01T00:00:10.000Z' } }
    expect(onlyPresenceNoiseChanged(a, b)).toBe(true)
  })

  it('슬라이드 변경은 noise가 아니다', () => {
    const a = { presence: { activeSlideIndex: 0, lastUpdated: 'x' } }
    const b = { presence: { activeSlideIndex: 2, lastUpdated: 'y' } }
    expect(onlyPresenceNoiseChanged(a, b)).toBe(false)
  })

  it('선택 변경은 noise가 아니다 (E3 보존)', () => {
    const a = { presence: { selectedElementId: 's1', cursorX: 1, lastUpdated: 'x' } }
    const b = { presence: { selectedElementId: 's2', cursorX: 2, lastUpdated: 'y' } }
    expect(onlyPresenceNoiseChanged(a, b)).toBe(false)
  })

  it('이름 변경은 noise가 아니다', () => {
    const a = { presence: { userName: 'ada', cursorX: 1, lastUpdated: 'x' } }
    const b = { presence: { userName: 'grace', cursorX: 2, lastUpdated: 'y' } }
    expect(onlyPresenceNoiseChanged(a, b)).toBe(false)
  })

  it('app 변경은 noise가 아니다', () => {
    const a = { app: { mode: 'view' }, presence: { lastUpdated: 'x' } }
    const b = { app: { mode: 'edit' }, presence: { lastUpdated: 'y' } }
    expect(onlyPresenceNoiseChanged(a, b)).toBe(false)
  })

  it('첫 상태는 noise가 아니다', () => {
    expect(onlyPresenceNoiseChanged(null, { presence: { cursorX: 1 } })).toBe(false)
  })

  it('마우스 60회/초를 10초간 시뮬레이션하면 신호 변경 0건이다', () => {
    let last: unknown = null
    let sends = 0
    for (let i = 0; i < 600; i++) {
      const next = {
        presence: { userName: 'ada', activeSlideIndex: 0, cursorX: i, cursorY: i, lastUpdated: `t${i}` },
      }
      if (!onlyPresenceNoiseChanged(last, next)) sends++
      last = next
    }
    // 첫 1회만 신호로 보고, 이후 599회는 전부 노이즈다.
    expect(sends).toBe(1)
  })
})

describe('createAwarenessThrottle (D26)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('첫 요청은 즉시 보낸다', () => {
    const th = createAwarenessThrottle(4, () => 0)
    expect(th.request()).toBe(true)
  })

  it('초당 4회로 제한한다 (250ms 간격)', () => {
    let t = 0
    const th = createAwarenessThrottle(4, () => t)
    expect(th.request()).toBe(true) // t=0
    t = 100
    expect(th.request()).toBe(false)
    t = 200
    expect(th.request()).toBe(false)
    t = 249
    expect(th.request()).toBe(false)
    t = 250
    expect(th.request()).toBe(true)
  })

  it('막히면 pending이 선다', () => {
    let t = 0
    const th = createAwarenessThrottle(4, () => t)
    expect(th.request()).toBe(true)
    t = 10
    expect(th.request()).toBe(false)
  })

  it('한 번 통과하면 다시 통과한다 (pending이 내려간다)', () => {
    let t = 0
    const th = createAwarenessThrottle(4, () => t)
    th.request()
    t = 10
    expect(th.request()).toBe(false)
    t = 300
    expect(th.request()).toBe(true)
  })

  it('마우스 60회/초를 넣어도 초당 4회만 통과한다', () => {
    let t = 0
    const th = createAwarenessThrottle(4, () => t)
    let sent = 0
    for (let i = 0; i < 60; i++) {
      t += 16
      if (th.request()) sent++
    }
    expect(sent).toBeLessThanOrEqual(5)
  })
})
