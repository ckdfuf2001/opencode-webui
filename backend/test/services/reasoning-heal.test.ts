import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/services/opencode-db', () => ({
  truncateSessionMessages: vi.fn(),
}))

import { healReasoningTail } from '../../src/services/reasoning-heal'
import { truncateSessionMessages } from '../../src/services/opencode-db'

const truncateMock = truncateSessionMessages as unknown as ReturnType<typeof vi.fn>

function userMsg(id: string, text: string, created: number) {
  return {
    info: { id, role: 'user', sessionID: 'ses-1', time: { created } },
    parts: [{ type: 'text', text }],
  }
}

function assistantMsg(id: string, created: number) {
  return {
    info: { id, role: 'assistant', sessionID: 'ses-1', time: { created, completed: created + 1000 } },
    parts: [{ type: 'text', text: 'done' }],
  }
}

function mockMessageList(messages: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => messages })),
  )
}

describe('healReasoningTail', () => {
  beforeEach(() => {
    truncateMock.mockReset()
    truncateMock.mockResolvedValue({
      messagesRemoved: 2,
      partsRemoved: 3,
      eventsRemoved: 0,
      todoRemoved: 0,
      remainingMessages: 4,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('truncates from the last user message when text matches exactly', async () => {
    const now = Date.now()
    mockMessageList([
      userMsg('u1', 'hello', now - 60_000),
      assistantMsg('a1', now - 59_000),
      userMsg('u2', 'fix the bug', now - 5_000),
    ])
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['fix the bug'])
    expect(res.healed).toBe(true)
    expect(res.truncatedMessageId).toBe('u2')
    expect(truncateMock).toHaveBeenCalledWith('ses-1', 'u2')
  })

  it('matches when recall injection was prepended (stored ends with raw text)', async () => {
    const now = Date.now()
    mockMessageList([userMsg('u9', '<memory-recall>stuff</memory-recall>\n\nfix the bug', now - 5_000)])
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['<memory-recall>stuff</memory-recall>\n\nfix the bug', 'fix the bug'])
    expect(res.healed).toBe(true)
    expect(truncateMock).toHaveBeenCalledWith('ses-1', 'u9')
  })

  it('refuses to truncate on text mismatch (not our turn)', async () => {
    const now = Date.now()
    mockMessageList([userMsg('u1', 'something else entirely', now - 5_000)])
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['fix the bug'])
    expect(res.healed).toBe(false)
    expect(res.reason).toMatch(/mismatch/)
    expect(truncateMock).not.toHaveBeenCalled()
  })

  it('refuses to truncate a stale user message', async () => {
    const old = Date.now() - 60 * 60_000
    mockMessageList([userMsg('u1', 'fix the bug', old)])
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['fix the bug'])
    expect(res.healed).toBe(false)
    expect(res.reason).toMatch(/too old/)
    expect(truncateMock).not.toHaveBeenCalled()
  })

  it('returns unhealed when the message list request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 })),
    )
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['fix the bug'])
    expect(res.healed).toBe(false)
    expect(truncateMock).not.toHaveBeenCalled()
  })

  it('returns unhealed for empty candidates', async () => {
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['  '])
    expect(res.healed).toBe(false)
  })
})
