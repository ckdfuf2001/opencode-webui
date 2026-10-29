import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  sameMessageList,
  sameMessageContent,
  textPartsLength,
  toolOutputLength,
  reasoningPartsLength,
  runningToolCount,
  isCompleted,
} from '../src/lib/messageListEquality'

/**
 * D35: 유휴 상태 렌더 0회.
 *
 * - 데이터가 바뀌지 않으면 렌더하지 않는다(캐시 참조 유지).
 * - 1Hz 시각 tick 은 시각을 그리는 컴포넌트 하위에만 공급한다.
 *
 * 근거: M7-2 실측에서 슬라이드 점 paint 자기 루프와 usePeers 1Hz tick 이 유휴 재렌더의
 * 원인이었다. 레이아웃 8.6/s → 0/s, DOM mutation 73~147/s → 0/s, PptxViewer 렌더 2.6/s → 0/s.
 */

type AnyMsg = {
  info: { id: string; role: string; time: Record<string, unknown> }
  parts: Array<{ type?: string; text?: string; state?: { status?: string; output?: string; metadata?: { output?: string } } }>
}

function msg(id: string, parts: AnyMsg['parts'], time: Record<string, unknown> = {}): AnyMsg {
  return { info: { id, role: 'assistant', time }, parts } as unknown as MessageWithParts
}

describe('D35 같은 데이터면 렌더가 늘지 않는다', () => {
  it('내용이 같으면 sameMessageList 가 true (캐시 참조 유지 → 렌더 0)', () => {
    const a = [msg('m1', [{ type: 'text', text: '안녕' }])] as unknown as MessageListResponse
    const b = [msg('m1', [{ type: 'text', text: '안녕' }])] as unknown as MessageListResponse
    expect(a).not.toBe(b) // 다른 배열 참조
    expect(sameMessageList(a, b)).toBe(true)
  })

  it('텍스트가 길어지면 false', () => {
    const a = [msg('m1', [{ type: 'text', text: '안녕' }])] as unknown as MessageListResponse
    const b = [msg('m1', [{ type: 'text', text: '안녕하세요' }])] as unknown as MessageListResponse
    expect(sameMessageList(a, b)).toBe(false)
  })

  it('메시지 id 가 다르면 false', () => {
    const a = [msg('m1', [])] as unknown as MessageListResponse
    const b = [msg('m2', [])] as unknown as MessageListResponse
    expect(sameMessageList(a, b)).toBe(false)
  })

  it('개수가 다르면 false', () => {
    const a = [msg('m1', [])] as unknown as MessageListResponse
    const b = [msg('m1', []), msg('m2', [])] as unknown as MessageListResponse
    expect(sameMessageList(a, b)).toBe(false)
  })

  it('running → completed 전이는 false (길이가 같아도 상태가 다르면 바꾼다)', () => {
    const running = msg('m1', [{ type: 'tool', state: { status: 'running', output: 'x' } }])
    const done = msg('m1', [{ type: 'tool', state: { status: 'completed', output: 'x' } }], { completed: 1 })
    expect(sameMessageContent(running as never, done as never)).toBe(false)
  })

  it('종료/진행 판정과 길이 집계가 각각 동작한다', () => {
    const parts = [
      { type: 'text', text: 'abc' },
      { type: 'tool', state: { status: 'running', output: 'toolout' } },
      { type: 'reasoning', text: 'r' },
    ] as unknown as MessageWithParts['parts']
    expect(textPartsLength(parts)).toBe(3)
    expect(toolOutputLength(parts)).toBe(7)
    expect(reasoningPartsLength(parts)).toBe(1)
    expect(runningToolCount(parts)).toBe(1)
    expect(isCompleted({ time: { completed: 5 } } as never)).toBe(true)
    expect(isCompleted({ time: {} } as never)).toBe(false)
  })
})

describe('D35 1Hz tick 은 시각을 그리는 하위에만 공급한다', () => {
  const SRC = path.resolve(__dirname, '..', 'src')

  it('usePeers 의 tick 기본값은 0 (끊긴 상태)', () => {
    const src = fs.readFileSync(path.join(SRC, 'lib', 'usePeers.ts'), 'utf8')
    // readPeersTickMs() 는 기본 0 을 돌려주고, tickMs > 0 일 때만 setInterval 을 만든다
    expect(src).toMatch(/tickMs\s*>\s*0/)
    expect(src).toMatch(/readPeersTickMs\(\)/)
  })

  it('NowProvider 는 1초/5초 주기만 쓴다 (C1: 공용 CollabPresence로 이동)', () => {
    const src = fs.readFileSync(path.join(SRC, 'components', 'collab', 'CollabPresence.tsx'), 'utf8')
    expect(src).toMatch(/const ms = active \? 1000 : 5000/)
    // PptxViewer는 공용 컴포넌트를 가져다 쓴다(중복 정의 금지).
    const viewer = fs.readFileSync(path.join(SRC, 'components', 'file-browser', 'PptxViewer.tsx'), 'utf8')
    expect(viewer).toMatch(/from '@\/components\/collab\/CollabPresence'/)
    expect(viewer).not.toMatch(/const ms = active \? 1000 : 5000/)
  })
})
