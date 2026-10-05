import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@opencode-webui/shared', () => ({
  getWorkspacePath: () => '/ws',
  ENV: {},
}))

vi.mock('../../src/services/opencode-single-server', () => ({
  opencodeServerManager: {
    getUrl: () => 'http://opencode-test',
    reloadAndVerify: vi.fn(async () => true),
  },
}))

vi.mock('../../src/services/opencode-auth', () => ({
  ensureServerAuth: (h: unknown) => h,
}))

vi.mock('../../src/services/reasoning-heal', () => ({
  isReasoningMismatchText: () => false,
  healReasoningTail: vi.fn(),
  healStaleHistoryBeyondLastTurn: vi.fn(),
  truncateFromNthLastUser: vi.fn(),
  sweepPollutedStubs: vi.fn(),
  asOutgoingModel: () => undefined,
  preSendStripIfMismatch: vi.fn(),
  findNewMismatch: () => undefined,
}))

vi.mock('../../src/services/session-message-db', () => ({
  recentSessionMessages: vi.fn(async () => null),
}))

vi.mock('../../src/services/opencode-db', () => ({
  stripAllReasoningParts: vi.fn(async () => null),
  truncateSessionMessages: vi.fn(async () => ({ messagesRemoved: 2, partsRemoved: 3, eventsRemoved: 0, todoRemoved: 0, remainingMessages: 5 })),
  deleteSessionMessage: vi.fn(async () => ({ messagesRemoved: 1, partsRemoved: 2, eventsRemoved: 0, remainingMessages: 4 })),
}))

vi.mock('../../src/services/command-runs', () => ({
  resolveLiveDirectory: (_db: unknown, dir: string) => dir,
  resolveRepoId: () => null,
}))

vi.mock('../../src/db/session-status-queries', () => ({
  getSessionStatusRow: () => undefined,
  setSessionCancelled: vi.fn(),
}))

import {
  enqueueQueuedChat,
  listQueuedChats,
  flushQueueForSession,
  updateQueuedChatsModel,
  dropDeliveredDuplicates,
  moveQueuedChat,
  opItemLabel,
} from '../../src/services/chat-queue'
import { truncateSessionMessages } from '../../src/services/opencode-db'

let n = 0
// 주의: queues는 모듈 레벨 Map이라 테스트 간 유지된다 — sid는 절대 재사용하지 않는다.
const sid = () => `ses-ops-${++n}`

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubIdle(messageImpl?: (url: string) => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const u = String(url)
      if (u.includes('/message') && messageImpl) return messageImpl(u) as never
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => (u.includes('/session/status') ? {} : []),
      }
    }),
  )
}

describe('op enqueue validation', () => {
  it('op는 messageID 필수, 없으면 throw', () => {
    const s = sid()
    expect(() => enqueueQueuedChat(s, '', '/ws', { kind: 'truncate' })).toThrow()
    expect(() => enqueueQueuedChat(s, '', '/ws', { kind: 'delete' })).toThrow()
    expect(listQueuedChats(s)).toEqual([])
  })
  it('op 라벨은 서버에서 합성', () => {
    const s = sid()
    enqueueQueuedChat(s, '', '/ws', { kind: 'truncate', messageID: 'msg_abcdef123456' })
    const item = listQueuedChats(s)[0]!
    expect(item.kind).toBe('truncate')
    expect(item.messageID).toBe('msg_abcdef123456')
    expect(item.text).toBe(opItemLabel('truncate', 'msg_abcdef123456'))
    expect(item.status).toBe('queued')
  })
  it('chat은 빈 텍스트 불가', () => {
    const s = sid()
    expect(() => enqueueQueuedChat(s, '   ', '/ws')).toThrow()
  })
})

describe('op dispatch order (FIFO)', () => {
  it('chat → truncate → chat 순서대로 실행되고 truncate이 실제 돈다', async () => {
    const s = sid()
    stubIdle((u) =>
      u.includes('/message')
        ? { ok: true, status: 200, text: async () => '', json: async () => ({}) }
        : undefined as never,
    )
    enqueueQueuedChat(s, 'first chat', '/ws')
    enqueueQueuedChat(s, '', '/ws', { kind: 'truncate', messageID: 'msg_1' })
    enqueueQueuedChat(s, 'second chat', '/ws')
    expect(listQueuedChats(s).map((q) => q.kind)).toEqual(['chat', 'truncate', 'chat'])

    flushQueueForSession(s)
    await new Promise((r) => setTimeout(r, 800))
    // head chat 발송 → 제거, op가 head로
    expect(listQueuedChats(s).map((q) => q.kind)).toEqual(['truncate', 'chat'])

    flushQueueForSession(s)
    await new Promise((r) => setTimeout(r, 800))
    // op 실행 → 제거, truncateSessionMessages 호출됨
    expect(truncateSessionMessages).toHaveBeenCalledWith(s, 'msg_1')
    expect(listQueuedChats(s).map((q) => q.kind)).toEqual(['chat'])
  })

  it('busy면 op도 대기한다', async () => {
    const s = sid()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const u = String(url)
        if (u.includes('/session/status')) {
          return { ok: true, status: 200, text: async () => '', json: async () => ({ [s]: { type: 'busy' } }) }
        }
        return { ok: true, status: 200, text: async () => '', json: async () => [] }
      }),
    )
    enqueueQueuedChat(s, '', '/ws', { kind: 'delete', messageID: 'msg_9' })
    flushQueueForSession(s)
    await new Promise((r) => setTimeout(r, 400))
    expect(listQueuedChats(s)[0]!.status).toBe('queued')
  })
})

describe('op는 chat 전용 로직에서 제외', () => {
  it('updateQueuedChatsModel이 op를 건드리지 않는다', () => {
    const s = sid()
    enqueueQueuedChat(s, 'hello', '/ws', { model: { providerID: 'p', modelID: 'old' } })
    enqueueQueuedChat(s, '', '/ws', { kind: 'delete', messageID: 'msg_x' })
    updateQueuedChatsModel(s, { providerID: 'p', modelID: 'new' })
    const [chat, op] = listQueuedChats(s)
    expect(chat!.model).toEqual({ providerID: 'p', modelID: 'new' })
    expect(op!.model).toBeUndefined()
  })
  it('dropDeliveredDuplicates가 op를 지우지 않는다', () => {
    const s = sid()
    enqueueQueuedChat(s, '', '/ws', { kind: 'truncate', messageID: 'msg_y' })
    // op 라벨과 같은 텍스트의 chat이 와도 op는 유지
    const label = listQueuedChats(s)[0]!.text
    enqueueQueuedChat(s, label, '/ws')
    expect(dropDeliveredDuplicates(s, label)).toBe(1)
    expect(listQueuedChats(s).map((q) => q.kind)).toEqual(['truncate'])
  })
  it('moveQueuedChat으로 op를 위아래로 옮길 수 있다', () => {
    const s = sid()
    enqueueQueuedChat(s, 'chat a', '/ws')
    enqueueQueuedChat(s, '', '/ws', { kind: 'delete', messageID: 'msg_z' })
    const opId = listQueuedChats(s)[1]!.id
    moveQueuedChat(s, opId, true)
    expect(listQueuedChats(s).map((q) => q.kind)).toEqual(['delete', 'chat'])
  })
})

describe('compact op + toTop enqueue', () => {
  it('compact는 model 필수, 없으면 throw', () => {
    const s = sid()
    expect(() => enqueueQueuedChat(s, '', '/ws', { kind: 'compact' })).toThrow()
    expect(listQueuedChats(s)).toEqual([])
  })
  it('toTop은 맨 앞에 넣는다', () => {
    const s = sid()
    enqueueQueuedChat(s, 'chat a', '/ws')
    enqueueQueuedChat(s, 'chat b', '/ws')
    enqueueQueuedChat(s, '', '/ws', { kind: 'compact', model: { providerID: 'p', modelID: 'm' }, toTop: true })
    expect(listQueuedChats(s).map((q) => q.kind)).toEqual(['compact', 'chat', 'chat'])
  })
  it('toTop도 발송 중 헤드는 건드리지 않는다 (1번에 삽입)', () => {
    const s = sid()
    enqueueQueuedChat(s, 'chat a', '/ws')
    listQueuedChats(s)[0]!.status = 'sending'
    enqueueQueuedChat(s, '', '/ws', { kind: 'compact', model: { providerID: 'p', modelID: 'm' }, toTop: true })
    expect(listQueuedChats(s).map((q) => q.kind)).toEqual(['chat', 'compact'])
  })
  it('compact op가 /summarize로 실행되고 큐가 비워진다', async () => {
    const s = sid()
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const u = String(url)
        seen.push(u)
        if (u.includes('/summarize')) {
          return { ok: true, status: 200, text: async () => 'true', json: async () => ({}) }
        }
        return { ok: true, status: 200, text: async () => '', json: async () => (u.includes('/session/status') ? {} : []) }
      }),
    )
    enqueueQueuedChat(s, '', '/ws', { kind: 'compact', model: { providerID: 'p', modelID: 'm' } })
    flushQueueForSession(s)
    await new Promise((r) => setTimeout(r, 800))
    expect(seen.some((u) => u.includes('/summarize'))).toBe(true)
    expect(listQueuedChats(s)).toEqual([])
  })
  it('compact 500이면 queued 유지 (transient)', async () => {
    const s = sid()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const u = String(url)
        if (u.includes('/summarize')) {
          return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) }
        }
        return { ok: true, status: 200, text: async () => '', json: async () => (u.includes('/session/status') ? {} : []) }
      }),
    )
    enqueueQueuedChat(s, '', '/ws', { kind: 'compact', model: { providerID: 'p', modelID: 'm' } })
    flushQueueForSession(s)
    await new Promise((r) => setTimeout(r, 800))
    expect(listQueuedChats(s)[0]!.status).toBe('queued')
  })
})
