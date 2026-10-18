import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { YCollabSession } from '../src/lib/ycollab'

/**
 * A1′ P1: transport 모드 계약.
 *
 * C7이 이 파일의 존재 이유다 — transport 세션은 lib이 만든 doc/awareness를 그대로 쓴다.
 * 새로 만들면 ycs.awareness !== session.awareness가 되어 소유권이 갈리고,
 * provider가 쓰는 presence를 서버에 보낼 수 없다.
 */
describe('YCollabSession transport mode (A1′ P1)', () => {
  const user = { name: 'ada', color: '#123456' }

  it('C7: transport mode adopts the host doc and awareness (no new Awareness)', () => {
    const doc = new Y.Doc()
    const awareness = new Awareness(doc)
    const ycs = new YCollabSession('ws://127.0.0.1:1/room', user, {
      mode: 'transport',
      doc,
      awareness,
    })
    expect(ycs.mode).toBe('transport')
    expect(ycs.doc).toBe(doc)
    expect(ycs.awareness).toBe(awareness)
    // 리셋해도 동일 객체여야 한다 (Awareness가 doc.clientID를 가진다).
    expect(ycs.awareness.doc).toBe(doc)
    ycs.destroy()
    // destroy가 빌려온 doc를 죽이지 않는다 — 소유자는 lib session이다.
    expect(doc.isDestroyed).toBe(false)
    awareness.destroy()
  })

  it('C7: own mode still creates and owns its own doc and awareness', () => {
    const ycs = new YCollabSession('ws://127.0.0.1:1/room', user)
    expect(ycs.mode).toBe('own')
    expect(ycs.awareness).toBeInstanceOf(Awareness)
    expect(ycs.awareness.doc).toBe(ycs.doc)
    // own 모드는 예전처럼 app 신원을 처음부터 게시한다.
    const app = (ycs.awareness.getLocalState() ?? {}).app as Record<string, unknown>
    expect(app.name).toBe('ada')
    ycs.destroy()
    expect(ycs.doc.isDestroyed).toBe(true)
  })

  it('transport mode never touches awareness app state (the lib owns it)', () => {
    const doc = new Y.Doc()
    const awareness = new Awareness(doc)
    const ycs = new YCollabSession('ws://127.0.0.1:1/room', user, { mode: 'transport', doc, awareness })
    // lib이 PRESENCE_FIELD를 갖고, app는 우리가 아니다.
    awareness.setLocalStateField('presence', { userName: 'ada' })
    expect((ycs.awareness.getLocalState() ?? {}).app).toBeUndefined()
    expect((ycs.awareness.getLocalState() ?? {}).presence).toBeDefined()
    ycs.destroy()
    awareness.destroy()
  })

  it('asTransport exposes the lib Transport shape and is inert before connect', () => {
    const doc = new Y.Doc()
    const awareness = new Awareness(doc)
    const ycs = new YCollabSession('ws://127.0.0.1:1/room', user, { mode: 'transport', doc, awareness })
    const t = ycs.asTransport()
    expect(typeof t.connect).toBe('function')
    expect(typeof t.send).toBe('function')
    expect(typeof t.disconnect).toBe('function')
    // connect 전 send는 조용히 버려진다(소켓이 없으므로 예외도 없다).
    expect(() => t.send(new Uint8Array([0, 0]))).not.toThrow()
    t.disconnect()
    ycs.destroy()
    awareness.destroy()
  })
})