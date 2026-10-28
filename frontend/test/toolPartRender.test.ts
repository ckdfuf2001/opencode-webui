import { describe, expect, it } from 'vitest'
import { toolPartRenderMode } from '../src/lib/toolPartRender'

const runningBash = {
  type: 'tool',
  tool: 'bash',
  state: { status: 'running', input: { command: 'sleep 30' } },
}

describe('toolPartRenderMode (B0-5)', () => {
  it('SSE off + streaming + running tool renders the full tile (same as SSE on)', () => {
    expect(toolPartRenderMode({ sseOn: false, streaming: true, part: runningBash })).toBe('full')
  })
  it('SSE on + streaming + running tool renders the full tile', () => {
    expect(toolPartRenderMode({ sseOn: true, streaming: true, part: runningBash })).toBe('full')
  })
  it('pure text streaming without tools keeps the Generating placeholder', () => {
    expect(toolPartRenderMode({ sseOn: false, streaming: true, part: null })).toBe('placeholder')
  })
  it('finished tools always render full regardless of SSE', () => {
    const done = { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'ls' } } }
    expect(toolPartRenderMode({ sseOn: false, streaming: false, part: done })).toBe('full')
    expect(toolPartRenderMode({ sseOn: true, streaming: false, part: done })).toBe('full')
  })
})
