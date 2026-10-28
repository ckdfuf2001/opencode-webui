import { describe, expect, it } from 'vitest'
import {
  consumeProxyIdleReleased,
  noteProxyBusy,
  noteProxyIdle,
  pumpTrackedIdle,
  resetProxyTurnEndForTest,
  trackProxyDispatch,
  untrackProxyDispatch,
} from '../../src/services/proxy-turn-end'

describe('proxy 직접 전송 — 턴 종료(idle 관측) 시 업스트림 요청을 끊는다 (B0-3)', () => {
  it('발송 뒤 busy를 관측하고 idle이 유예 뒤에도 계속되면 요청을 중단한다', () => {
    resetProxyTurnEndForTest()
    const sid = 'ses-proxy-turnend-1'
    const ac = new AbortController()
    trackProxyDispatch(sid, ac)
    expect(ac.signal.aborted).toBe(false)

    // 턴 진행 중 관측 — 이 관측이 없으면 끊지 않는다(오발 방지).
    noteProxyBusy(sid)
    expect(ac.signal.aborted).toBe(false)

    // 턴 종료(idle) 1회째는 유예한다(P1-3 경합 방지).
    expect(noteProxyIdle(sid, 5_000_000)).toBe(false)
    expect(ac.signal.aborted).toBe(false)
    // 유예(3초) 뒤에도 idle이면 붙어 있는 업스트림 요청을 끊는다.
    expect(noteProxyIdle(sid, 5_000_000 + 3_000)).toBe(true)
    expect(ac.signal.aborted).toBe(true)
    // 우리가 직접 끊은 경우는 정상 종료로 기록된다.
    expect(consumeProxyIdleReleased(sid)).toBe(true)
    expect(consumeProxyIdleReleased(sid)).toBe(false)
  })

  it('busy를 한 번도 관측하지 못하면 idle이어도 끊지 않는다 (오발 방지)', () => {
    resetProxyTurnEndForTest()
    const sid = 'ses-proxy-turnend-2'
    const ac = new AbortController()
    trackProxyDispatch(sid, ac)

    expect(noteProxyIdle(sid)).toBe(false)
    expect(ac.signal.aborted).toBe(false)
    expect(consumeProxyIdleReleased(sid)).toBe(false)
  })

  it('idle 1회는 유예한다 — 3초 뒤에도 idle이면 끊는다 (P1-3 경합 방지)', () => {
    resetProxyTurnEndForTest()
    const sid = 'ses-proxy-turnend-3'
    const ac = new AbortController()
    trackProxyDispatch(sid, ac)
    noteProxyBusy(sid)

    expect(noteProxyIdle(sid, 1_000_000)).toBe(false)
    expect(ac.signal.aborted).toBe(false)
    expect(noteProxyIdle(sid, 1_000_000 + 3_000)).toBe(true)
    expect(ac.signal.aborted).toBe(true)
  })

  it('idle 관측 직후 본문이 도착하면 끊지 않는다 (P1-3)', () => {
    resetProxyTurnEndForTest()
    const sid = 'ses-proxy-turnend-4'
    const ac = new AbortController()
    trackProxyDispatch(sid, ac)
    noteProxyBusy(sid)

    // 1회 idle: 유예 (끊지 않음). 그 사이 응답이 와서 dispatch가 끝난다.
    expect(noteProxyIdle(sid, 2_000_000)).toBe(false)
    untrackProxyDispatch(sid)
    // 다음 idle 관측: 붙어 있는 요청이 없으므로 끊을 게 없다.
    expect(noteProxyIdle(sid, 2_000_000 + 10_000)).toBe(false)
    expect(ac.signal.aborted).toBe(false)
    expect(consumeProxyIdleReleased(sid)).toBe(false)
  })

  it('idle → unknown 2틱 → idle이면 유예가 다시 시작돼 끊지 않는다 (P1-a)', () => {
    resetProxyTurnEndForTest()
    const sid = 'ses-proxy-pump-restart'
    const ac = new AbortController()
    trackProxyDispatch(sid, ac, '/repo/a')
    noteProxyBusy(sid)

    const t0 = 10_000_000
    const verdicts = ['idle', 'unknown', 'unknown', 'idle'] as const
    let i = 0
    const at = [t0, t0 + 1_000, t0 + 2_000, t0 + 3_500]
    const results = at.map((now) => pumpTrackedIdle(() => verdicts[i++]!, now))
    expect(results).toEqual([[], [], [], []])
    expect(ac.signal.aborted).toBe(false)
    expect(consumeProxyIdleReleased(sid)).toBe(false)
  })

  it('unknown만 10초 이어져도 끊지 않는다 (P1-a)', () => {
    resetProxyTurnEndForTest()
    const sid = 'ses-proxy-unknown-only'
    const ac = new AbortController()
    trackProxyDispatch(sid, ac, '/repo/a')
    noteProxyBusy(sid)

    const t0 = 20_000_000
    for (let k = 0; k <= 5; k++) {
      expect(pumpTrackedIdle(() => 'unknown', t0 + k * 2_000)).toEqual([])
    }
    expect(ac.signal.aborted).toBe(false)
    expect(consumeProxyIdleReleased(sid)).toBe(false)
  })

  it('idle 2틱(유예 초과)이면 끊는다 (P0-1 pump 경로)', () => {
    resetProxyTurnEndForTest()
    const sid = 'ses-proxy-pump-idle'
    const ac = new AbortController()
    trackProxyDispatch(sid, ac, '/repo/a')
    noteProxyBusy(sid)

    expect(pumpTrackedIdle(() => 'idle', 2_000_000)).toEqual([])
    expect(ac.signal.aborted).toBe(false)
    expect(pumpTrackedIdle(() => 'idle', 2_000_000 + 3_000)).toEqual([sid])
    expect(ac.signal.aborted).toBe(true)
  })
})
