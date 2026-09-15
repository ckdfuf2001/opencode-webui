import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/services/opencode-db', () => ({
  truncateSessionMessages: vi.fn(),
  deleteSingleChildlessMessage: vi.fn(),
}))

import { healReasoningTail } from '../../src/services/reasoning-heal'
import { truncateSessionMessages, deleteSingleChildlessMessage } from '../../src/services/opencode-db'

const truncateMock = truncateSessionMessages as unknown as ReturnType<typeof vi.fn>
const deleteMock = deleteSingleChildlessMessage as unknown as ReturnType<typeof vi.fn>

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

function mismatchErrorMsg(id: string, created: number) {
  return {
    info: {
      id,
      role: 'assistant',
      sessionID: 'ses-1',
      time: { created, completed: created + 1000 },
      error: { name: 'APIError', data: { message: "Upstream request failed: [invalid_request_error] reasoning `encrypted_content` was not issued to this caller" } },
    },
    parts: [{ type: 'reasoning', text: '...' }],
  }
}

function otherErrorMsg(id: string, created: number) {
  return {
    info: {
      id,
      role: 'assistant',
      sessionID: 'ses-1',
      time: { created, completed: created + 1000 },
      error: { name: 'APIError', data: { message: 'insufficient_quota' } },
    },
    parts: [{ type: 'text', text: '...' }],
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
    deleteMock.mockReset()
    deleteMock.mockResolvedValue({ messagesRemoved: 1, partsRemoved: 1, eventsRemoved: 0, remainingMessages: 3 })
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

  it('sweeps an older trailing mismatch stub after truncating our turn', async () => {
    // 실제 케이스 재현: [u_old, err_old(poison), u_new] + 실패 → u_new 절단 후 err_old 단건 삭제
    const now = Date.now()
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [
      userMsg('u_old', 'old question', now - 300_000),
      mismatchErrorMsg('err_old', now - 290_000),
      userMsg('u_new', 'new question', now - 5_000),
    ] })
    // truncate 이후 꼬리: [u_old, err_old] → err_old 삭제 → [u_old] → stop
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [
      userMsg('u_old', 'old question', now - 300_000),
      mismatchErrorMsg('err_old', now - 290_000),
    ] })
    fetchMock.mockResolvedValue({ ok: true, json: async () => [
      userMsg('u_old', 'old question', now - 300_000),
    ] })
    vi.stubGlobal('fetch', fetchMock)
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['new question'])
    expect(res.healed).toBe(true)
    expect(res.truncatedMessageId).toBe('u_new')
    expect(deleteMock).toHaveBeenCalledWith('ses-1', 'err_old')
    expect(res.stubsRemoved).toBe(1)
  })

  it('does not delete trailing errors of other kinds', async () => {
    const now = Date.now()
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [
      userMsg('u_old', 'old question', now - 300_000),
      otherErrorMsg('err_quota', now - 290_000),
      userMsg('u_new', 'new question', now - 5_000),
    ] })
    fetchMock.mockResolvedValue({ ok: true, json: async () => [
      userMsg('u_old', 'old question', now - 300_000),
      otherErrorMsg('err_quota', now - 290_000),
    ] })
    vi.stubGlobal('fetch', fetchMock)
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['new question'])
    expect(res.healed).toBe(true)
    expect(deleteMock).not.toHaveBeenCalled()
    expect(res.stubsRemoved).toBe(0)
  })

  it('stops the sweep when delete is refused (has children)', async () => {
    const now = Date.now()
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [
      userMsg('u_old', 'old question', now - 300_000),
      mismatchErrorMsg('err_old', now - 290_000),
      userMsg('u_new', 'new question', now - 5_000),
    ] })
    // truncate로 u_new이 사라진 뒤 꼬리: [u_old, err_old] → 삭제 시도 → 거부(null)
    fetchMock.mockResolvedValue({ ok: true, json: async () => [
      userMsg('u_old', 'old question', now - 300_000),
      mismatchErrorMsg('err_old', now - 290_000),
    ] })
    deleteMock.mockResolvedValue(null)
    vi.stubGlobal('fetch', fetchMock)
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['new question'])
    expect(res.healed).toBe(true)
    expect(deleteMock).toHaveBeenCalledTimes(1)
    expect(res.stubsRemoved).toBe(0)
  })

  it('removes a buried mismatch stub behind a kept user message', async () => {
    // 실제 세션 재현: [u1, err_old, u2, quotaErr, u3new] → u3 절단 후 err_old만 삭제
    const now = Date.now()
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [
      userMsg('u1', 'q1', now - 600_000),
      mismatchErrorMsg('err_old', now - 590_000),
      userMsg('u2', 'q2', now - 300_000),
      otherErrorMsg('err_quota', now - 290_000),
      userMsg('u3new', 'q3', now - 5_000),
    ] })
    fetchMock.mockResolvedValue({ ok: true, json: async () => [
      userMsg('u1', 'q1', now - 600_000),
      mismatchErrorMsg('err_old', now - 590_000),
      userMsg('u2', 'q2', now - 300_000),
      otherErrorMsg('err_quota', now - 290_000),
    ] })
    vi.stubGlobal('fetch', fetchMock)
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['q3'])
    expect(res.healed).toBe(true)
    expect(deleteMock).toHaveBeenCalledTimes(1)
    expect(deleteMock).toHaveBeenCalledWith('ses-1', 'err_old')
    expect(res.stubsRemoved).toBe(1)
  })

  it('does not touch a mismatch stub behind a healthy assistant turn', async () => {
    const now = Date.now()
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [
      mismatchErrorMsg('err_ancient', now - 600_000),
      assistantMsg('good', now - 300_000),
      userMsg('u_new', 'new question', now - 5_000),
    ] })
    fetchMock.mockResolvedValue({ ok: true, json: async () => [
      mismatchErrorMsg('err_ancient', now - 600_000),
      assistantMsg('good', now - 300_000),
    ] })
    vi.stubGlobal('fetch', fetchMock)
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['new question'])
    expect(res.healed).toBe(true)
    expect(deleteMock).not.toHaveBeenCalled()
    expect(res.stubsRemoved).toBe(0)
  })
})
