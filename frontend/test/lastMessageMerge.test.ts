import { describe, expect, it } from 'vitest'
import { shouldReplaceLastMessage } from '../src/lib/lastMessageMerge'

function part(status: string, output = 'out') {
  return { type: 'tool', state: { status, output, input: { command: 'sleep 30' }, time: { start: 1 } } }
}

function msg(id: string, p: unknown, completed = false) {
  return { info: { id, time: completed ? { created: 1, completed: 2 } : { created: 1 } }, parts: [p] }
}

describe('lastMessageMerge (B0-5 확장)', () => {
  it('running → completed 전이는 출력이 같아도 교체한다 (상태 뒤집힘 누락 방지)', () => {
    expect(shouldReplaceLastMessage(msg('m1', part('running')) as never, msg('m1', part('completed')) as never)).toBe(true)
  })
  it('완전히 같으면 유지한다 (D35 렌더 0회)', () => {
    expect(shouldReplaceLastMessage(msg('m1', part('running')) as never, msg('m1', part('running')) as never)).toBe(false)
  })
  it('캐시가 앞서면 유지한다 (서버 lagging 보호)', () => {
    expect(
      shouldReplaceLastMessage(msg('m1', part('running', 'long-output')) as never, msg('m1', part('running', 'out')) as never),
    ).toBe(false)
  })
})
