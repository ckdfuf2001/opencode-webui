import { describe, expect, it } from 'vitest'
import {
  consumeProxyIdleReleased,
  noteProxyBusy,
  noteProxyIdle,
  resetProxyTurnEndForTest,
  trackProxyDispatch,
} from '../../src/services/proxy-turn-end'

describe('proxy 직접 전송 — 턴 종료(idle 관측) 시 업스트림 요청을 끊는다 (B0-3)', () => {
  it('발송 뒤 busy를 관측하고 idle이 오면 진행 중 요청을 중단한다', () => {
    resetProxyTurnEndForTest()
    const sid = 'ses-proxy-turnend-1'
    const ac = new AbortController()
    trackProxyDispatch(sid, ac)
    expect(ac.signal.aborted).toBe(false)

    // 턴 진행 중 관측 — 이 관측이 없으면 끊지 않는다(오발 방지).
    noteProxyBusy(sid)
    expect(ac.signal.aborted).toBe(false)

    // 턴 종료(idle) — 붙어 있는 업스트림 요청을 끊는다.
    expect(noteProxyIdle(sid)).toBe(true)
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
})
