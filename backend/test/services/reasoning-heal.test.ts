import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/services/opencode-db', () => ({
  truncateSessionMessages: vi.fn(),
  deleteSingleChildlessMessage: vi.fn(),
}))

vi.mock('../../src/services/session-message-db', () => ({
  recentSessionMessages: vi.fn(),
}))

import { healReasoningTail, healMismatchTailManual, classifyTail, isIncompleteAssistant, isReasoningMismatchText } from '../../src/services/reasoning-heal'
import { truncateSessionMessages, deleteSingleChildlessMessage } from '../../src/services/opencode-db'
import { recentSessionMessages } from '../../src/services/session-message-db'

const truncateMock = truncateSessionMessages as unknown as ReturnType<typeof vi.fn>
const deleteMock = deleteSingleChildlessMessage as unknown as ReturnType<typeof vi.fn>
const recentMock = recentSessionMessages as unknown as ReturnType<typeof vi.fn>

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

function securityMismatchErrorMsg(id: string, created: number) {
  return {
    info: {
      id,
      role: 'assistant',
      sessionID: 'ses-1',
      time: { created, completed: created + 1000 },
      error: { name: 'APIError', data: { message: 'security reasoning `encrypted_content` was not issued to this caller' } },
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

function interruptedMsg(id: string, created: number) {
  // NW 중단으로 step-finish 없이 저장된 오염 턴 — info.error가 비어 있다.
  // 실DB 실측: reasoning part는 {type,text,time}만 저장되고 서명 필드가 없으므로
  // 완료 여부로만 판별한다.
  return {
    info: {
      id,
      role: 'assistant',
      sessionID: 'ses-1',
      time: { created },
    },
    parts: [{ type: 'step-start' }, { type: 'reasoning', text: 'partial thinking...' }],
  }
}

function mockMessageList(messages: unknown[]) {
  recentMock.mockResolvedValue({ total: messages.length, messages })
}

function mockMessageListSequence(lists: unknown[][]) {
  for (const messages of lists) {
    recentMock.mockResolvedValueOnce({ total: messages.length, messages })
  }
  const last = lists[lists.length - 1] ?? []
  recentMock.mockResolvedValue({ total: last.length, messages: last })
}

describe('isReasoningMismatchText', () => {
  it('matches security reasoning blocks too', () => {
    expect(isReasoningMismatchText('security reasoning `encrypted_content` was not issued')).toBe(true)
    expect(isReasoningMismatchText('reasoning `encrypted_content` was not issued')).toBe(true)
    expect(isReasoningMismatchText('plain quota error')).toBe(false)
  })
})

describe('isIncompleteAssistant', () => {
  it('detects interrupted turns by missing completed (parts are irrelevant)', () => {
    expect(isIncompleteAssistant(interruptedMsg('u', Date.now()) as never)).toBe(true)
    expect(isIncompleteAssistant(assistantMsg('a', Date.now()) as never)).toBe(false)
    expect(isIncompleteAssistant(userMsg('u', 'hi', Date.now()) as never)).toBe(false)
  })
})

describe('healReasoningTail', () => {
  beforeEach(() => {
    recentMock.mockReset()
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

  it('returns unhealed when the message store is unavailable', async () => {
    recentMock.mockRejectedValueOnce(new Error('db down'))
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
    mockMessageListSequence([[
      userMsg('u_old', 'old question', now - 300_000),
      mismatchErrorMsg('err_old', now - 290_000),
      userMsg('u_new', 'new question', now - 5_000),
    ],
    // truncate 이후 꼬리: [u_old, err_old] → err_old 삭제 → [u_old] → stop
    [
      userMsg('u_old', 'old question', now - 300_000),
      mismatchErrorMsg('err_old', now - 290_000),
    ],
    [
      userMsg('u_old', 'old question', now - 300_000),
    ]])
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['new question'])
    expect(res.healed).toBe(true)
    expect(res.truncatedMessageId).toBe('u_new')
    expect(deleteMock).toHaveBeenCalledWith('ses-1', 'err_old')
    expect(res.stubsRemoved).toBe(1)
  })

  it('sweeps an interrupted turn left by an NW interruption', async () => {
    // NW 중단 케이스 (실DB ses_f61e43e4 재현): [u_old, interrupted(poison, no error, no completed), u_new]
    // → u_new 절단 후 interrupted 삭제
    const now = Date.now()
    mockMessageListSequence([[
      userMsg('u_old', 'old question', now - 300_000),
      interruptedMsg('err_old', now - 290_000),
      userMsg('u_new', 'new question', now - 5_000),
    ],
    [
      userMsg('u_old', 'old question', now - 300_000),
      interruptedMsg('err_old', now - 290_000),
    ],
    [
      userMsg('u_old', 'old question', now - 300_000),
    ]])
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['new question'])
    expect(res.healed).toBe(true)
    expect(deleteMock).toHaveBeenCalledWith('ses-1', 'err_old')
    expect(res.stubsRemoved).toBe(1)
    expect(res.stubsPending).toEqual([])
  })

  it('reports kept stubs explicitly when delete is refused', async () => {
    const now = Date.now()
    mockMessageListSequence([[
      userMsg('u_old', 'old question', now - 300_000),
      mismatchErrorMsg('err_old', now - 290_000),
      userMsg('u_new', 'new question', now - 5_000),
    ],
    [
      userMsg('u_old', 'old question', now - 300_000),
      mismatchErrorMsg('err_old', now - 290_000),
    ]])
    deleteMock.mockResolvedValue(null)
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['new question'])
    expect(res.healed).toBe(true)
    expect(res.stubsRemoved).toBe(0)
    expect(res.stubsPending).toEqual(['err_old'])
  })

  it('does not delete trailing errors of other kinds', async () => {
    const now = Date.now()
    mockMessageListSequence([[
      userMsg('u_old', 'old question', now - 300_000),
      otherErrorMsg('err_quota', now - 290_000),
      userMsg('u_new', 'new question', now - 5_000),
    ],
    [
      userMsg('u_old', 'old question', now - 300_000),
      otherErrorMsg('err_quota', now - 290_000),
    ]])
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['new question'])
    expect(res.healed).toBe(true)
    expect(deleteMock).not.toHaveBeenCalled()
    expect(res.stubsRemoved).toBe(0)
  })

  it('stops the sweep when delete is refused (has children)', async () => {
    const now = Date.now()
    mockMessageListSequence([[
      userMsg('u_old', 'old question', now - 300_000),
      mismatchErrorMsg('err_old', now - 290_000),
      userMsg('u_new', 'new question', now - 5_000),
    ],
    // truncate로 u_new이 사라진 뒤 꼬리: [u_old, err_old] → 삭제 시도 → 거부(null)
    [
      userMsg('u_old', 'old question', now - 300_000),
      mismatchErrorMsg('err_old', now - 290_000),
    ]])
    deleteMock.mockResolvedValue(null)
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['new question'])
    expect(res.healed).toBe(true)
    expect(deleteMock).toHaveBeenCalledTimes(1)
    expect(res.stubsRemoved).toBe(0)
  })

  it('removes a buried mismatch stub behind a kept user message', async () => {
    // 실제 세션 재현: [u1, err_old, u2, quotaErr, u3new] → u3 절단 후 err_old만 삭제
    const now = Date.now()
    mockMessageListSequence([[
      userMsg('u1', 'q1', now - 600_000),
      mismatchErrorMsg('err_old', now - 590_000),
      userMsg('u2', 'q2', now - 300_000),
      otherErrorMsg('err_quota', now - 290_000),
      userMsg('u3new', 'q3', now - 5_000),
    ],
    [
      userMsg('u1', 'q1', now - 600_000),
      mismatchErrorMsg('err_old', now - 590_000),
      userMsg('u2', 'q2', now - 300_000),
      otherErrorMsg('err_quota', now - 290_000),
    ]])
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['q3'])
    expect(res.healed).toBe(true)
    expect(deleteMock).toHaveBeenCalledTimes(1)
    expect(deleteMock).toHaveBeenCalledWith('ses-1', 'err_old')
    expect(res.stubsRemoved).toBe(1)
  })

  it('does not touch a completed reasoning turn behind a healthy assistant turn', async () => {
    const now = Date.now()
    const completedReasoning = {
      info: { id: 'good_reason', role: 'assistant', sessionID: 'ses-1', time: { created: now - 600_000, completed: now - 599_000 } },
      parts: [{ type: 'reasoning', text: 'thinking...' }],
    }
    mockMessageListSequence([[
      completedReasoning,
      assistantMsg('good', now - 300_000),
      userMsg('u_new', 'new question', now - 5_000),
    ],
    [
      completedReasoning,
      assistantMsg('good', now - 300_000),
    ]])
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['new question'])
    expect(res.healed).toBe(true)
    expect(deleteMock).not.toHaveBeenCalled()
    expect(res.stubsRemoved).toBe(0)
  })
})

describe('classifyTail', () => {
  const now = Date.now()
  it('classifies mismatch as healable', () => {
    expect(classifyTail([mismatchErrorMsg('e1', now)]).healable).toBe(true)
    expect(classifyTail([mismatchErrorMsg('e1', now)]).kind).toBe('mismatch')
  })
  it('classifies security mismatch as healable', () => {
    expect(classifyTail([securityMismatchErrorMsg('e1', now)]).healable).toBe(true)
    expect(classifyTail([securityMismatchErrorMsg('e1', now)]).kind).toBe('mismatch')
  })
  it('prefers mismatch over non-healable keywords in the same body', () => {
    const mixed = {
      info: {
        id: 'e1',
        role: 'assistant',
        sessionID: 'ses-1',
        time: { created: now, completed: now + 1000 },
        error: { name: 'APIError', status: 400, data: { message: 'reasoning `encrypted_content` was not issued (authentication context req_429_x)' } },
      },
      parts: [{ type: 'reasoning', text: '...' }],
    }
    expect(classifyTail([mixed]).kind).toBe('mismatch')
  })
  it('reads statusCode nested in data (real opencode shape)', () => {
    const nested = {
      info: {
        id: 'e1',
        role: 'assistant',
        sessionID: 'ses-1',
        time: { created: now, completed: now + 1000 },
        error: { name: 'APIError', data: { message: 'rate limited', statusCode: 429 } },
      },
      parts: [{ type: 'text', text: '...' }],
    }
    expect(classifyTail([nested]).kind).toBe('non-healable')
  })
  it('classifies quota/billing errors as non-healable', () => {
    expect(classifyTail([otherErrorMsg('e2', now)]).healable).toBe(false)
    expect(classifyTail([otherErrorMsg('e2', now)]).kind).toBe('non-healable')
  })
  it('classifies clean history', () => {
    const r = classifyTail([assistantMsg('a1', now)])
    expect(r.kind).toBe('clean')
    expect(r.healable).toBe(false)
  })
})

describe('healMismatchTailManual', () => {
  beforeEach(() => {
    recentMock.mockReset()
    truncateMock.mockReset()
    truncateMock.mockResolvedValue({ messagesRemoved: 2, partsRemoved: 1, eventsRemoved: 0, todoRemoved: 0, remainingMessages: 3 })
    deleteMock.mockReset()
    deleteMock.mockResolvedValue({ messagesRemoved: 1, partsRemoved: 1, eventsRemoved: 0, remainingMessages: 3 })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  it('heals a mismatch tail without text candidates', async () => {
    const now = Date.now()
    mockMessageListSequence([[
      userMsg('u1', 'hello', now - 60_000),
      mismatchErrorMsg('e1', now - 50_000),
    ],
    [
      userMsg('u1', 'hello', now - 60_000),
    ]])
    const res = await healMismatchTailManual('ses-1')
    expect(res.healed).toBe(true)
    expect(res.truncatedMessageId).toBe('u1')
    expect(truncateMock).toHaveBeenCalledWith('ses-1', 'u1')
  })
  it('refuses clean history', async () => {
    const now = Date.now()
    mockMessageList([
      userMsg('u1', 'hi', now - 60_000),
      assistantMsg('a1', now - 59_000),
    ])
    const res = await healMismatchTailManual('ses-1')
    expect(res.healed).toBe(false)
    expect(res.reason).toMatch(/clean/)
    expect(truncateMock).not.toHaveBeenCalled()
  })
  it('refuses non-healable tails (quota preserved)', async () => {
    const now = Date.now()
    mockMessageList([
      userMsg('u1', 'hello', now - 60_000),
      otherErrorMsg('e_quota', now - 50_000),
    ])
    const res = await healMismatchTailManual('ses-1')
    expect(res.healed).toBe(false)
    expect(truncateMock).not.toHaveBeenCalled()
  })
})
