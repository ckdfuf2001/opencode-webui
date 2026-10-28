import { describe, expect, it } from 'vitest'
import { sameMessageContent } from '../src/lib/messageListEquality'

function toolPart(status: string, output = '', command = 'sleep 30') {
  return {
    type: 'tool',
    tool: 'bash',
    state: { status, output, input: { command }, time: { start: 1 } },
  }
}

function msgWith(part: unknown) {
  return { info: { time: { created: 1 } }, parts: [part] }
}

describe('messageListEquality (B0-5 확장)', () => {
  it('pending → running 전이는 "변경됨"으로 판정한다', () => {
    expect(sameMessageContent(msgWith(toolPart('pending')) as never, msgWith(toolPart('running')) as never)).toBe(false)
  })
  it('running → completed 전이는 "변경됨"으로 판정한다 (같은 출력이어도)', () => {
    expect(
      sameMessageContent(msgWith(toolPart('running', 'out')) as never, msgWith(toolPart('completed', 'out')) as never),
    ).toBe(false)
  })
})
