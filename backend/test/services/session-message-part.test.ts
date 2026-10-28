import { describe, expect, it } from 'vitest'
import { buildCappedToolState } from '../../src/services/session-message-part'

function row(overrides = {}) {
  return {
    status: 'running',
    title: null,
    timejson: null,
    statetime: null,
    hasout: 1,
    outhead: 'line1\nline2',
    metahead: null,
    inputjson: null,
    len: 70000,
    ...overrides,
  }
}

describe('buildCappedToolState (B0-5, 64KB+ capped path)', () => {
  it('preserves state.input so the tile can show the command', () => {
    const state = buildCappedToolState(
      row({ inputjson: JSON.stringify({ command: 'sleep 30', timeout: 5000 }) }),
    )
    expect((state.input as { command: string }).command).toBe('sleep 30')
    expect(state.status).toBe('running')
  })
  it('omits input larger than 32KB (title fallback stays)', () => {
    const big = JSON.stringify({ content: 'x'.repeat(40_000) })
    const state = buildCappedToolState(row({ inputjson: big, title: 'edit big.ts' }))
    expect(state.input).toBeUndefined()
    expect(state.title).toBe('edit big.ts')
  })
  it('keeps output head and time', () => {
    const state = buildCappedToolState(row({ timejson: '{"start":1}', statetime: '{"start":1}' }))
    expect(state.output).toContain('line1')
    expect(state.time).toEqual({ start: 1 })
  })
})
