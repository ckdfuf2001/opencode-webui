import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/services/opencode-db', () => ({
  truncateSessionMessages: vi.fn(),
  deleteSingleChildlessMessage: vi.fn(),
  stripReasoningParts: vi.fn(),
  stripAllReasoningParts: vi.fn(),
}))

vi.mock('../../src/services/session-message-db', () => ({
  recentSessionMessages: vi.fn(),
  historyReasoningModels: vi.fn(),
}))

import { healReasoningTail, healMismatchTailManual, healStaleHistoryBeyondLastTurn, truncateFromNthLastUser, classifyTail, isIncompleteAssistant, isReasoningMismatchText, findLastGoodModel, asOutgoingModel, preSendStripIfMismatch, findNewMismatch, clearStripAllMarks } from '../../src/services/reasoning-heal'
import { truncateSessionMessages, deleteSingleChildlessMessage, stripReasoningParts, stripAllReasoningParts } from '../../src/services/opencode-db'
import { recentSessionMessages, historyReasoningModels } from '../../src/services/session-message-db'

const truncateMock = truncateSessionMessages as unknown as ReturnType<typeof vi.fn>
const deleteMock = deleteSingleChildlessMessage as unknown as ReturnType<typeof vi.fn>
const stripMock = stripReasoningParts as unknown as ReturnType<typeof vi.fn>
const stripAllMock = stripAllReasoningParts as unknown as ReturnType<typeof vi.fn>
const recentMock = recentSessionMessages as unknown as ReturnType<typeof vi.fn>
const historyMock = historyReasoningModels as unknown as ReturnType<typeof vi.fn>

/** opencode 조회 stub — 상태는 idle, 세션 모델은 opencode/m-1.3, 테스트별 override */
function mockSessionIdle() {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const u = String(url)
    if (u.includes('/session/status')) return { ok: true, json: async () => ({}) }
    if (u.includes('/session/')) return { ok: true, json: async () => ({ model: { providerID: 'opencode', id: 'm-1.3' } }) }
    return { ok: false, json: async () => ({}) }
  }))
}
function mockSessionBusy() {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ 'ses-1': { type: 'busy' } }) })))
}
function mockNoSessionModel() {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const u = String(url)
    if (u.includes('/session/status')) return { ok: true, json: async () => ({}) }
    return { ok: false, json: async () => ({}) }
  }))
}
/** 세션에 기록된 모델을 지정 — outgoing 우선순위 테스트용 */
function mockSessionModel(providerID: string, id: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const u = String(url)
    if (u.includes('/session/status')) return { ok: true, json: async () => ({}) }
    if (u.includes('/session/')) return { ok: true, json: async () => ({ model: { providerID, id } }) }
    return { ok: false, json: async () => ({}) }
  }))
}

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

/** 모델 정보가 박힌 성공 턴 — suggestedModel(마지막 성공 모델) 제어용 */
function goodAssistantWithModel(id: string, created: number, providerID: string, modelID: string) {
  return {
    info: { id, role: 'assistant', sessionID: 'ses-1', providerID, modelID, time: { created, completed: created + 1000 } },
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

describe('asOutgoingModel', () => {
  it('accepts {providerID, modelID} objects', () => {
    expect(asOutgoingModel({ providerID: 'opencode', modelID: 'm-1.3' }))
      .toEqual({ providerID: 'opencode', modelID: 'm-1.3' })
  })
  it('accepts opencode session shape {providerID, id}', () => {
    expect(asOutgoingModel({ providerID: 'opencode', id: 'm-1.2' }))
      .toEqual({ providerID: 'opencode', modelID: 'm-1.2' })
  })
  it('accepts "provider/model" strings', () => {
    expect(asOutgoingModel('opencode/m-1.3'))
      .toEqual({ providerID: 'opencode', modelID: 'm-1.3' })
  })
  it('rejects missing or blank fields', () => {
    expect(asOutgoingModel(undefined)).toBeUndefined()
    expect(asOutgoingModel(null)).toBeUndefined()
    expect(asOutgoingModel({})).toBeUndefined()
    expect(asOutgoingModel({ providerID: 'opencode' })).toBeUndefined()
    expect(asOutgoingModel({ providerID: ' ', modelID: 'm' })).toBeUndefined()
    expect(asOutgoingModel('noslash')).toBeUndefined()
    expect(asOutgoingModel('/m')).toBeUndefined()
  })
})

describe('healReasoningTail', () => {
  beforeEach(() => {
    recentMock.mockReset()
    historyMock.mockReset()
    historyMock.mockResolvedValue([])
    mockSessionIdle()
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
    stripMock.mockReset()
    stripMock.mockResolvedValue(null)
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

  it('refuses everything while the session is busy (live turn guard)', async () => {
    const now = Date.now()
    mockSessionBusy()
    mockMessageList([
      userMsg('u1', 'hello', now - 60_000),
      mismatchErrorMsg('e1', now - 50_000),
      userMsg('u2', 'fix the bug', now - 5_000),
    ])
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['fix the bug'])
    expect(res.healed).toBe(false)
    expect(res.reason).toMatch(/busy/)
    expect(truncateMock).not.toHaveBeenCalled()
    expect(deleteMock).not.toHaveBeenCalled()
  })

  it('skips cross-model history without touching the DB when strip finds nothing', async () => {
    const now = Date.now()
    historyMock.mockResolvedValue([
      { providerID: 'opencode', modelID: 'muse-spark-1.2', turns: 12 },
      { providerID: 'opencode', modelID: 'muse-spark-1.3', turns: 3 },
    ])
    mockNoSessionModel()
    mockMessageList([
      userMsg('u1', 'hello', now - 60_000),
      assistantMsg('a1', now - 59_000),
      userMsg('u2', 'fix the bug', now - 5_000),
    ])
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['fix the bug'])
    expect(res.healed).toBe(false)
    expect(res.kind).toBe('cross-model')
    expect(res.models).toHaveLength(2)
    expect(stripMock).not.toHaveBeenCalled()
    expect(truncateMock).not.toHaveBeenCalled()
    expect(deleteMock).not.toHaveBeenCalled()
  })

  it('strips foreign reasoning then truncates the failed turn (single shot)', async () => {
    const now = Date.now()
    historyMock.mockResolvedValue([
      { providerID: 'opencode', modelID: 'm-1.2', turns: 8 },
      { providerID: 'opencode', modelID: 'm-1.3', turns: 2 },
    ])
    stripMock.mockResolvedValue({ partsRemoved: 6, messagesAffected: 4 })
    mockMessageListSequence([[
      userMsg('u1', 'hello', now - 60_000),
      assistantMsg('a1', now - 59_000),
      userMsg('u2', 'fix the bug', now - 5_000),
    ],
    [
      userMsg('u1', 'hello', now - 60_000),
      assistantMsg('a1', now - 59_000),
    ]])
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['fix the bug'])
    expect(stripMock).toHaveBeenCalledTimes(1)
    expect(stripMock).toHaveBeenCalledWith('ses-1', { providerID: 'opencode', modelID: 'm-1.3' })
    expect(truncateMock).toHaveBeenCalledWith('ses-1', 'u2')
    expect(res.healed).toBe(true)
    expect(res.kind).toBe('cross-model')
    expect(res.strippedParts).toBe(6)
    expect(res.strippedMessages).toBe(4)
    expect(res.truncatedMessageId).toBe('u2')
  })

  it('prefers the outgoing model over the session model for strip keep', async () => {
    const now = Date.now()
    historyMock.mockResolvedValue([
      { providerID: 'opencode', modelID: 'm-1.2', turns: 8 },
      { providerID: 'opencode', modelID: 'm-1.3', turns: 2 },
    ])
    stripMock.mockResolvedValue({ partsRemoved: 6, messagesAffected: 4 })
    // 세션 기록은 1.2인데 실제 전송은 1.3 — f5b72 세션 재현
    mockSessionModel('opencode', 'm-1.2')
    mockMessageListSequence([[
      userMsg('u1', 'hello', now - 60_000),
      assistantMsg('a1', now - 59_000),
      userMsg('u2', 'fix the bug', now - 5_000),
    ],
    [
      userMsg('u1', 'hello', now - 60_000),
      assistantMsg('a1', now - 59_000),
    ]])
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['fix the bug'],
      { force: true, outgoingModel: { providerID: 'opencode', modelID: 'm-1.3' } })
    expect(stripMock).toHaveBeenCalledTimes(1)
    expect(stripMock).toHaveBeenCalledWith('ses-1', { providerID: 'opencode', modelID: 'm-1.3' })
    expect(res.healed).toBe(true)
  })

  it('ignores suggestedModel: keep comes from outgoing even when the last good turn is another model', async () => {
    const now = Date.now()
    historyMock.mockResolvedValue([
      { providerID: 'opencode', modelID: 'm-1.2', turns: 8 },
      { providerID: 'opencode', modelID: 'm-1.3', turns: 2 },
    ])
    stripMock.mockResolvedValue({ partsRemoved: 6, messagesAffected: 4 })
    mockNoSessionModel()
    // 마지막 성공 턴이 1.2지만 보내려는 건 1.3 — suggested를 쓰면 반대를 지운다
    mockMessageListSequence([[
      userMsg('u1', 'hello', now - 60_000),
      goodAssistantWithModel('a1', now - 59_000, 'opencode', 'm-1.2'),
      userMsg('u2', 'fix the bug', now - 5_000),
    ],
    [
      userMsg('u1', 'hello', now - 60_000),
      goodAssistantWithModel('a1', now - 59_000, 'opencode', 'm-1.2'),
    ]])
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['fix the bug'],
      { force: true, outgoingModel: { providerID: 'opencode', modelID: 'm-1.3' } })
    expect(stripMock).toHaveBeenCalledTimes(1)
    expect(stripMock).toHaveBeenCalledWith('ses-1', { providerID: 'opencode', modelID: 'm-1.3' })
    expect(res.healed).toBe(true)
    expect(res.suggestedModel).toEqual({ providerID: 'opencode', modelID: 'm-1.2' })
  })

  it('does not sweep a recently-active incomplete turn (presumed live)', async () => {
    const now = Date.now()
    const liveGhost = {
      info: { id: 'live', role: 'assistant', sessionID: 'ses-1', time: { created: now - 10_000 } },
      parts: [{ type: 'reasoning', text: '...', time: { created: now - 5_000 } }],
    }
    mockMessageListSequence([[
      userMsg('u_old', 'old question', now - 300_000),
      mismatchErrorMsg('err_old', now - 290_000),
      userMsg('u_new', 'new question', now - 5_000),
    ],
    [
      userMsg('u_old', 'old question', now - 300_000),
      mismatchErrorMsg('err_old', now - 290_000),
      liveGhost,
    ]])
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['new question'])
    expect(res.healed).toBe(true)
    // 오래된 mismatch stub은 지우되, 방금 활동한 미완성 턴은 건드리지 않는다
    expect(deleteMock).toHaveBeenCalledWith('ses-1', 'err_old')
    expect(deleteMock).not.toHaveBeenCalledWith('ses-1', 'live')
    expect(res.stubsRemoved).toBe(1)
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

describe('sweep depth', () => {
  beforeEach(() => {
    recentMock.mockReset()
    historyMock.mockReset()
    historyMock.mockResolvedValue([])
    mockSessionIdle()
    truncateMock.mockReset()
    truncateMock.mockResolvedValue({ messagesRemoved: 1, partsRemoved: 1, eventsRemoved: 0, todoRemoved: 0, remainingMessages: 5 })
    deleteMock.mockReset()
    deleteMock.mockResolvedValue({ messagesRemoved: 1, partsRemoved: 1, eventsRemoved: 0, remainingMessages: 4 })
    stripMock.mockReset()
    stripMock.mockResolvedValue(null)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  it('removes at most 2 trailing stubs per run', async () => {
    const now = Date.now()
    mockMessageListSequence([[
      userMsg('u_new', 'q', now - 5_000),
    ],
    [
      userMsg('u1', 'q1', now - 600_000),
      mismatchErrorMsg('e1', now - 590_000),
      userMsg('u2', 'q2', now - 500_000),
      mismatchErrorMsg('e2', now - 490_000),
      userMsg('u3', 'q3', now - 400_000),
      mismatchErrorMsg('e3', now - 390_000),
    ]])
    const res = await healReasoningTail('http://x', 'ses-1', '/ws', ['q'])
    expect(res.healed).toBe(true)
    expect(deleteMock).toHaveBeenCalledTimes(2)
    expect(res.stubsRemoved).toBe(2)
  })
})

describe('findLastGoodModel', () => {
  const now = Date.now()
  it('returns the last completed successful assistant model', () => {
    const good = {
      info: { id: 'g1', role: 'assistant', sessionID: 'ses-1', time: { created: now, completed: now + 1 }, modelID: 'm-1.2', providerID: 'opencode' },
      parts: [{ type: 'text', text: 'ok' }],
    }
    const bad = mismatchErrorMsg('e1', now + 10)
    expect(findLastGoodModel([good, bad])).toEqual({ providerID: 'opencode', modelID: 'm-1.2' })
  })
  it('skips incomplete turns (no completed yet)', () => {
    const live = {
      info: { id: 'l1', role: 'assistant', sessionID: 'ses-1', time: { created: now }, modelID: 'm-new', providerID: 'opencode' },
      parts: [{ type: 'reasoning', text: '...' }],
    }
    const good = {
      info: { id: 'g1', role: 'assistant', sessionID: 'ses-1', time: { created: now - 1000, completed: now - 999 }, modelID: 'm-old', providerID: 'opencode' },
      parts: [{ type: 'text', text: 'ok' }],
    }
    expect(findLastGoodModel([good, live])).toEqual({ providerID: 'opencode', modelID: 'm-old' })
  })
  it('returns undefined when no successful turn exists', () => {
    expect(findLastGoodModel([mismatchErrorMsg('e1', now)])).toBeUndefined()
  })
})

describe('preSendStripIfMismatch', () => {
  beforeEach(() => {
    clearStripAllMarks()
    recentMock.mockReset()
    historyMock.mockReset()
    historyMock.mockResolvedValue([])
    mockSessionIdle()
    truncateMock.mockReset()
    deleteMock.mockReset()
    deleteMock.mockResolvedValue({ messagesRemoved: 1, partsRemoved: 1, eventsRemoved: 0, remainingMessages: 3 })
    stripMock.mockReset()
    stripMock.mockResolvedValue({ partsRemoved: 6, messagesAffected: 4 })
    stripAllMock.mockReset()
    stripAllMock.mockResolvedValue(null)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  it('strips with the outgoing model and sweeps stubs without truncating', async () => {
    const now = Date.now()
    mockMessageList([
      userMsg('u1', 'hello', now - 60_000),
      mismatchErrorMsg('e1', now - 50_000),
    ])
    const res = await preSendStripIfMismatch('http://x', 'ses-1', '/ws', { providerID: 'opencode', modelID: 'm-1.3' })
    expect(res.checked).toBe(true)
    expect(stripMock).toHaveBeenCalledWith('ses-1', { providerID: 'opencode', modelID: 'm-1.3' })
    expect(res.strippedParts).toBe(6)
    expect(deleteMock).toHaveBeenCalledWith('ses-1', 'e1')
    expect(truncateMock).not.toHaveBeenCalled()
  })
  it('does nothing when the tail is not a mismatch', async () => {
    const now = Date.now()
    mockMessageList([
      userMsg('u1', 'hi', now - 60_000),
      assistantMsg('a1', now - 59_000),
    ])
    const res = await preSendStripIfMismatch('http://x', 'ses-1', '/ws', { providerID: 'opencode', modelID: 'm-1.3' })
    expect(res.checked).toBe(true)
    expect(res.reason).toMatch(/no mismatch/)
    expect(stripMock).not.toHaveBeenCalled()
    expect(deleteMock).not.toHaveBeenCalled()
    expect(truncateMock).not.toHaveBeenCalled()
  })
  it('fires when a newer user message sits on top of the mismatch stub', async () => {
    const now = Date.now()
    // stub 뒤에 새 user가 얹혀 꼬리가 mismatch가 아니게 된 경우 — 그래도 오염은 남아 있다
    mockMessageList([
      userMsg('u1', 'hello', now - 60_000),
      mismatchErrorMsg('e1', now - 50_000),
      userMsg('u2', 'another question', now - 5_000),
    ])
    const res = await preSendStripIfMismatch('http://x', 'ses-1', '/ws', { providerID: 'opencode', modelID: 'm-1.3' })
    expect(res.checked).toBe(true)
    expect(stripMock).toHaveBeenCalledWith('ses-1', { providerID: 'opencode', modelID: 'm-1.3' })
    expect(truncateMock).not.toHaveBeenCalled()
  })
  it('never falls back to the session model in pre-send (outgoing only)', async () => {
    const now = Date.now()
    // 세션 기록에 모델이 있어도 outgoing 없으면 외국 strip 금지 — 정상 전송 보호.
    // 단 keep 무관한 strip-all 폴백은 동작한다 (반대를 지울 위험이 없음).
    stripAllMock.mockResolvedValue({ partsRemoved: 0, messagesAffected: 0 })
    mockMessageList([
      userMsg('u1', 'hello', now - 60_000),
      mismatchErrorMsg('e1', now - 50_000),
    ])
    const res = await preSendStripIfMismatch('http://x', 'ses-1', '/ws', undefined)
    expect(res.checked).toBe(true)
    expect(stripMock).not.toHaveBeenCalled()
    expect(stripAllMock).toHaveBeenCalledWith('ses-1')
    expect(deleteMock).toHaveBeenCalledWith('ses-1', 'e1')
    expect(res.reason).toMatch(/sweep only/)
  })
  it('sweeps without stripping when keep is unknown', async () => {
    const now = Date.now()
    mockNoSessionModel()
    stripAllMock.mockResolvedValue({ partsRemoved: 0, messagesAffected: 0 })
    mockMessageList([
      userMsg('u1', 'hello', now - 60_000),
      mismatchErrorMsg('e1', now - 50_000),
    ])
    const res = await preSendStripIfMismatch('http://x', 'ses-1', '/ws', undefined)
    expect(res.checked).toBe(true)
    expect(stripMock).not.toHaveBeenCalled()
    expect(deleteMock).toHaveBeenCalledWith('ses-1', 'e1')
    expect(res.reason).toMatch(/sweep only/)
  })
  it('falls back to strip-all when foreign strip yields 0 (same-model stale)', async () => {
    const now = Date.now()
    // 동일모델 stale: 외국 strip 0건 → cutoff 이전 reasoning 전체 제거
    stripMock.mockResolvedValue({ partsRemoved: 0, messagesAffected: 0 })
    stripAllMock.mockResolvedValue({ partsRemoved: 9, messagesAffected: 5 })
    mockMessageList([
      userMsg('u1', 'hello', now - 60_000),
      mismatchErrorMsg('e1', now - 50_000),
    ])
    const res = await preSendStripIfMismatch('http://x', 'ses-1', '/ws', { providerID: 'opencode', modelID: 'm-1.3' })
    expect(res.checked).toBe(true)
    expect(stripMock).toHaveBeenCalledWith('ses-1', { providerID: 'opencode', modelID: 'm-1.3' })
    expect(stripAllMock).toHaveBeenCalledWith('ses-1')
    expect(res.strippedAllParts).toBe(9)
    expect(res.strippedAllMessages).toBe(5)
    expect(res.reason).toBeUndefined()
    expect(truncateMock).not.toHaveBeenCalled()
  })
  it('skips strip-all when foreign strip already removed parts', async () => {
    const now = Date.now()
    stripAllMock.mockReset()
    mockMessageList([
      userMsg('u1', 'hello', now - 60_000),
      mismatchErrorMsg('e1', now - 50_000),
    ])
    const res = await preSendStripIfMismatch('http://x', 'ses-1', '/ws', { providerID: 'opencode', modelID: 'm-1.3' })
    expect(res.strippedParts).toBe(6)
    expect(stripAllMock).not.toHaveBeenCalled()
    expect(res.strippedAllParts).toBe(0)
  })
  it('strip-alls without keep when keep is unknown and history is stale', async () => {
    const now = Date.now()
    stripAllMock.mockResolvedValue({ partsRemoved: 3, messagesAffected: 2 })
    mockMessageList([
      userMsg('u1', 'hello', now - 60_000),
      mismatchErrorMsg('e1', now - 50_000),
    ])
    const res = await preSendStripIfMismatch('http://x', 'ses-1', '/ws', undefined)
    expect(res.checked).toBe(true)
    expect(stripMock).not.toHaveBeenCalled()
    expect(stripAllMock).toHaveBeenCalledWith('ses-1')
    expect(res.strippedAllParts).toBe(3)
    expect(res.keep).toBeUndefined()
    expect(truncateMock).not.toHaveBeenCalled()
  })
  it('fires strip-all only once per stub (no repeated wipe)', async () => {
    const now = Date.now()
    // 외국 strip 0건 → strip-all 발동. 같은 stub이 남 o아 있어도 2회째는 스킵.
    stripMock.mockResolvedValue({ partsRemoved: 0, messagesAffected: 0 })
    stripAllMock.mockResolvedValue({ partsRemoved: 9, messagesAffected: 5 })
    mockMessageList([
      userMsg('u1', 'hello', now - 60_000),
      mismatchErrorMsg('e1', now - 50_000),
    ])
    const first = await preSendStripIfMismatch('http://x', 'ses-1', '/ws', { providerID: 'opencode', modelID: 'm-1.3' })
    expect(first.strippedAllParts).toBe(9)
    stripAllMock.mockClear()
    const second = await preSendStripIfMismatch('http://x', 'ses-1', '/ws', { providerID: 'opencode', modelID: 'm-1.3' })
    expect(stripAllMock).not.toHaveBeenCalled()
    expect(second.strippedAllParts).toBe(0)
    expect(second.strippedParts).toBe(0)
  })
  it('skips sweep while the session is busy', async () => {
    const now = Date.now()
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url)
      if (u.includes('/session/status')) return { ok: true, json: async () => ({ 'ses-1': { type: 'busy' } }) }
      return { ok: false, json: async () => ({}) }
    }))
    // fetchMessageList는 DB 경로라 위 stub과 무관하게 따로 mock돼 있음 — 메시지 목록만 재지정
    stripMock.mockResolvedValue({ partsRemoved: 0, messagesAffected: 0 })
    stripAllMock.mockResolvedValue({ partsRemoved: 0, messagesAffected: 0 })
    mockMessageList([
      userMsg('u1', 'hello', now - 60_000),
      mismatchErrorMsg('e1', now - 50_000),
    ])
    const res = await preSendStripIfMismatch('http://x', 'ses-1', '/ws', { providerID: 'opencode', modelID: 'm-1.3' })
    expect(res.checked).toBe(true)
    expect(res.reason).toMatch(/busy/)
    expect(deleteMock).not.toHaveBeenCalled()
    expect(res.stubsRemoved).toBe(0)
  })
})

describe('findNewMismatch', () => {
  it('finds a mismatch whose id was absent before the send', () => {
    const now = Date.now()
    const msgs = [
      userMsg('u1', 'hi', now - 60_000),
      mismatchErrorMsg('e_old', now - 50_000),
      userMsg('u2', 'hey', now - 1_000),
      mismatchErrorMsg('e_new', now - 500),
    ] as never[]
    const known = new Set(['u1', 'e_old', 'u2'])
    expect(findNewMismatch(msgs as never, known)?.info?.id).toBe('e_new')
  })
  it('ignores mismatches already present before the send (no clock involved)', () => {
    const now = Date.now()
    const msgs = [
      userMsg('u1', 'hi', now - 60_000),
      mismatchErrorMsg('e_old', now - 500),
    ] as never[]
    // created가 방금이어도 발송 전 꼬리에 있었으면 이번 턴과 무관
    expect(findNewMismatch(msgs as never, new Set(['u1', 'e_old']))).toBeUndefined()
  })
  it('returns undefined when there is no mismatch', () => {
    const now = Date.now()
    const msgs = [
      userMsg('u1', 'hi', now - 60_000),
      assistantMsg('a1', now - 1_000),
    ] as never[]
    expect(findNewMismatch(msgs as never, new Set(['u1']))).toBeUndefined()
  })
})
describe('healMismatchTailManual', () => {
  beforeEach(() => {
    recentMock.mockReset()
    historyMock.mockReset()
    historyMock.mockResolvedValue([])
    mockSessionIdle()
    truncateMock.mockReset()
    truncateMock.mockResolvedValue({ messagesRemoved: 2, partsRemoved: 1, eventsRemoved: 0, todoRemoved: 0, remainingMessages: 3 })
    deleteMock.mockReset()
    deleteMock.mockResolvedValue({ messagesRemoved: 1, partsRemoved: 1, eventsRemoved: 0, remainingMessages: 3 })
    stripMock.mockReset()
    stripMock.mockResolvedValue(null)
    stripAllMock.mockReset()
    stripAllMock.mockResolvedValue(null)
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
    const res = await healMismatchTailManual('http://x', 'ses-1', '/ws')
    expect(res.healed).toBe(true)
    expect(res.truncatedMessageId).toBe('u1')
    expect(truncateMock).toHaveBeenCalledWith('ses-1', 'u1')
  })
  it('strip-alls stale reasoning on single-model tails before truncating', async () => {
    const now = Date.now()
    // 단일모델 stale: 외국 strip 대상이 없어 stripMock은 안 돌고 strip-all이 돈다
    historyMock.mockResolvedValue([
      { providerID: 'opencode', modelID: 'm-1.3', turns: 12 },
    ])
    stripAllMock.mockResolvedValue({ partsRemoved: 7, messagesAffected: 6 })
    mockMessageListSequence([[
      userMsg('u1', 'hello', now - 60_000),
      mismatchErrorMsg('e1', now - 50_000),
    ],
    [
      userMsg('u1', 'hello', now - 60_000),
    ]])
    const res = await healMismatchTailManual('http://x', 'ses-1', '/ws', { providerID: 'opencode', modelID: 'm-1.3' })
    expect(res.healed).toBe(true)
    expect(stripMock).not.toHaveBeenCalled()
    expect(stripAllMock).toHaveBeenCalledWith('ses-1')
    expect(res.strippedAllParts).toBe(7)
    expect(truncateMock).toHaveBeenCalledWith('ses-1', 'u1')
  })
  it('refuses cross-model tails without an outgoing model (no session fallback)', async () => {
    const now = Date.now()
    historyMock.mockResolvedValue([
      { providerID: 'opencode', modelID: 'm-1.2', turns: 5 },
      { providerID: 'opencode', modelID: 'm-1.3', turns: 2 },
    ])
    mockMessageListSequence([[
      userMsg('u1', 'hello', now - 60_000),
      mismatchErrorMsg('e1', now - 50_000),
    ],
    [
      userMsg('u1', 'hello', now - 60_000),
    ]])
    const res = await healMismatchTailManual('http://x', 'ses-1', '/ws')
    expect(res.healed).toBe(false)
    expect(res.kind).toBe('cross-model')
    expect(res.reason).toMatch(/cannot help/)
    expect(stripMock).not.toHaveBeenCalled()
    expect(stripAllMock).not.toHaveBeenCalled()
    expect(truncateMock).not.toHaveBeenCalled()
  })
  it('refuses cross-model tails when nothing was stripped (prompt preserved)', async () => {
    const now = Date.now()
    historyMock.mockResolvedValue([
      { providerID: 'opencode', modelID: 'm-1.2', turns: 5 },
      { providerID: 'opencode', modelID: 'm-1.3', turns: 2 },
    ])
    stripMock.mockResolvedValue({ partsRemoved: 0, messagesAffected: 0 })
    stripAllMock.mockResolvedValue({ partsRemoved: 0, messagesAffected: 0 })
    mockMessageListSequence([[
      userMsg('u1', 'hello', now - 60_000),
      mismatchErrorMsg('e1', now - 50_000),
    ],
    [
      userMsg('u1', 'hello', now - 60_000),
    ]])
    const res = await healMismatchTailManual('http://x', 'ses-1', '/ws', { providerID: 'opencode', modelID: 'm-1.3' })
    expect(res.healed).toBe(false)
    expect(res.reason).toMatch(/cannot help/)
    expect(truncateMock).not.toHaveBeenCalled()
  })
  it('manual heal prefers the passed outgoing model over the session model', async () => {
    const now = Date.now()
    historyMock.mockResolvedValue([
      { providerID: 'opencode', modelID: 'm-1.2', turns: 5 },
      { providerID: 'opencode', modelID: 'm-1.3', turns: 2 },
    ])
    stripMock.mockResolvedValue({ partsRemoved: 4, messagesAffected: 3 })
    mockSessionModel('opencode', 'm-1.2')
    mockMessageListSequence([[
      userMsg('u1', 'hello', now - 60_000),
      mismatchErrorMsg('e1', now - 50_000),
    ],
    [
      userMsg('u1', 'hello', now - 60_000),
    ]])
    const res = await healMismatchTailManual('http://x', 'ses-1', '/ws', { providerID: 'opencode', modelID: 'm-1.3' })
    expect(res.healed).toBe(true)
    expect(stripMock).toHaveBeenCalledWith('ses-1', { providerID: 'opencode', modelID: 'm-1.3' })
  })
  it('refuses clean history', async () => {
    const now = Date.now()
    mockMessageList([
      userMsg('u1', 'hi', now - 60_000),
      assistantMsg('a1', now - 59_000),
    ])
    const res = await healMismatchTailManual('http://x', 'ses-1', '/ws')
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
    const res = await healMismatchTailManual('http://x', 'ses-1', '/ws')
    expect(res.healed).toBe(false)
    expect(truncateMock).not.toHaveBeenCalled()
  })
})

describe('truncateFromNthLastUser + healStaleHistoryBeyondLastTurn', () => {
  beforeEach(() => {
    recentMock.mockReset()
    historyMock.mockReset()
    historyMock.mockResolvedValue([])
    mockSessionIdle()
    truncateMock.mockReset()
    truncateMock.mockResolvedValue({ messagesRemoved: 2, partsRemoved: 1, eventsRemoved: 0, todoRemoved: 0, remainingMessages: 3 })
    deleteMock.mockReset()
    deleteMock.mockResolvedValue({ messagesRemoved: 1, partsRemoved: 1, eventsRemoved: 0, remainingMessages: 3 })
    stripMock.mockReset()
    stripAllMock.mockReset()
    stripAllMock.mockResolvedValue(null)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  it('cuts from the 2nd-last user for deep truncate', async () => {
    const now = Date.now()
    mockMessageList([
      userMsg('u_old', 'first question', now - 600_000),
      assistantMsg('a_old', now - 590_000),
      userMsg('u_new', 'second question', now - 5_000),
      mismatchErrorMsg('e_new', now - 4_000),
    ])
    const res = await truncateFromNthLastUser('ses-1', 2)
    expect('truncatedMessageId' in res && res.truncatedMessageId).toBe('u_old')
    expect(truncateMock).toHaveBeenCalledWith('ses-1', 'u_old')
  })
  it('n=1 behaves like the last-user truncate', async () => {
    const now = Date.now()
    mockMessageList([
      userMsg('u_old', 'first question', now - 600_000),
      userMsg('u_new', 'second question', now - 5_000),
    ])
    const res = await truncateFromNthLastUser('ses-1', 1)
    expect('truncatedMessageId' in res && res.truncatedMessageId).toBe('u_new')
  })
  it('rejects depths beyond 2 (loss cap)', async () => {
    const now = Date.now()
    mockMessageList([userMsg('u1', 'q', now - 5_000)])
    const res = await truncateFromNthLastUser('ses-1', 3)
    expect('reason' in res && res.reason).toMatch(/max 2/)
    expect(truncateMock).not.toHaveBeenCalled()
  })
  it('stage2 truncates the failed turn, strip-alls, then sweeps', async () => {
    const now = Date.now()
    mockMessageListSequence([[
      userMsg('u_old', 'first question', now - 600_000),
      assistantMsg('a_old', now - 590_000),
      userMsg('u_new', 'second question', now - 5_000),
      mismatchErrorMsg('e_new', now - 4_000),
    ],
    [
      userMsg('u_old', 'first question', now - 600_000),
      assistantMsg('a_old', now - 590_000),
    ]])
    stripAllMock.mockResolvedValue({ partsRemoved: 11, messagesAffected: 7 })
    const res = await healStaleHistoryBeyondLastTurn('ses-1')
    expect(res.truncatedMessageId).toBe('u_new')
    expect(truncateMock).toHaveBeenCalledWith('ses-1', 'u_new')
    expect(stripAllMock).toHaveBeenCalledWith('ses-1')
    expect(res.strippedAllParts).toBe(11)
    expect(res.strippedAllMessages).toBe(7)
  })
})
