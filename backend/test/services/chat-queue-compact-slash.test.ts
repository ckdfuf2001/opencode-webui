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
  recordRunStartSafe: vi.fn(async () => ({ id: 'run-compact-1' })),
  finishRunSafe: vi.fn(async () => {}),
}))

vi.mock('../../src/db/session-status-queries', () => ({
  getSessionStatusRow: () => undefined,
  setSessionCancelled: vi.fn(),
  markSessionStatusIdle: vi.fn(),
}))

import {
  enqueueQueuedChat,
  listQueuedChats,
  flushQueueForSession,
  matchCompactionSlash,
  setChatQueueDb,
} from '../../src/services/chat-queue'
import { recordRunStartSafe, finishRunSafe } from '../../src/services/command-runs'

let n = 0
const sid = () => `ses-compact-slash-${++n}`
const MODEL = { providerID: 'p', modelID: 'm' }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function stubFetch(summarizeImpl?: (u: string) => unknown) {
  const seen: string[] = []
  const bodies: Array<{ url: string; body: unknown }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      const u = String(url)
      seen.push(u)
      if (typeof init?.body === 'string') {
        try {
          bodies.push({ url: u, body: JSON.parse(init.body) })
        } catch {
          bodies.push({ url: u, body: init.body })
        }
      }
      if (u.includes('/summarize')) {
        if (summarizeImpl) return summarizeImpl(u) as never
        return { ok: true, status: 200, text: async () => 'true', json: async () => true }
      }
      return { ok: true, status: 200, text: async () => '', json: async () => (u.includes('/session/status') ? {} : []) }
    }),
  )
  return { seen, bodies }
}

describe('matchCompactionSlash', () => {
  it('compact/summarize만 매칭 (정확히 소문자)', () => {
    expect(matchCompactionSlash('compact')).toBe('compact')
    expect(matchCompactionSlash('summarize')).toBe('summarize')
    expect(matchCompactionSlash(' compact ')).toBe('compact')
  })
  it('그 외는 null', () => {
    expect(matchCompactionSlash('Compact')).toBeNull()
    expect(matchCompactionSlash('COMPACT')).toBeNull()
    expect(matchCompactionSlash('init')).toBeNull()
    expect(matchCompactionSlash('compaction')).toBeNull()
    expect(matchCompactionSlash('')).toBeNull()
  })
})

describe('채팅 /compact·/summarize 가로채기', () => {
  it('/compact는 /command가 아니라 /summarize로 실행된다', async () => {
    const s = sid()
    const { seen, bodies } = stubFetch()
    enqueueQueuedChat(s, '/compact', '/ws', { model: MODEL })
    flushQueueForSession(s)
    await new Promise((r) => setTimeout(r, 800))
    expect(seen.some((u) => u.includes('/summarize'))).toBe(true)
    expect(seen.some((u) => u.includes('/command'))).toBe(false)
    expect(seen.some((u) => u.includes('/message'))).toBe(false)
    const sent = bodies.find((b) => b.url.includes('/summarize'))
    expect(sent?.body).toMatchObject({ providerID: 'p', modelID: 'm' })
    expect(listQueuedChats(s)).toEqual([])
    expect(recordRunStartSafe).not.toHaveBeenCalled()
  })
  it('/summarize 인자는 무시하고 요약한다', async () => {
    const s = sid()
    const { seen } = stubFetch()
    enqueueQueuedChat(s, '/summarize focus on auth', '/ws', { model: MODEL })
    flushQueueForSession(s)
    await new Promise((r) => setTimeout(r, 800))
    expect(seen.some((u) => u.includes('/summarize'))).toBe(true)
    expect(listQueuedChats(s)).toEqual([])
  })
  it('run 생애주기: command 기록 후 completed', async () => {
    setChatQueueDb({} as never)
    try {
      const s = sid()
      stubFetch()
      enqueueQueuedChat(s, '/compact', '/ws', { model: MODEL })
      flushQueueForSession(s)
      await new Promise((r) => setTimeout(r, 800))
      expect(recordRunStartSafe).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ commandName: 'compact', kind: 'command', origin: 'chat' }),
      )
      expect(finishRunSafe).toHaveBeenCalledWith(expect.anything(), 'run-compact-1', 'completed')
    } finally {
      setChatQueueDb(null as never)
    }
  })
  it('모델이 없으면 failed + /summarize 호출 없음', async () => {
    setChatQueueDb({} as never)
    try {
      const s = sid()
      const { seen } = stubFetch()
      enqueueQueuedChat(s, '/compact', '/ws')
      flushQueueForSession(s)
      await new Promise((r) => setTimeout(r, 800))
      expect(seen.some((u) => u.includes('/summarize'))).toBe(false)
      expect(listQueuedChats(s)[0]!.status).toBe('failed')
      expect(finishRunSafe).toHaveBeenCalledWith(expect.anything(), 'run-compact-1', 'failed')
    } finally {
      setChatQueueDb(null as never)
    }
  })
  it('summarize 500이면 queued 유지 (transient)', async () => {
    const s = sid()
    const { seen } = stubFetch(() => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) }))
    enqueueQueuedChat(s, '/compact', '/ws', { model: MODEL })
    flushQueueForSession(s)
    await new Promise((r) => setTimeout(r, 800))
    expect(seen.some((u) => u.includes('/summarize'))).toBe(true)
    expect(listQueuedChats(s)[0]!.status).toBe('queued')
  })
  it('일반 채팅은 /message 경로 그대로', async () => {
    const s = sid()
    const { seen } = stubFetch()
    enqueueQueuedChat(s, 'hello there', '/ws', { model: MODEL })
    flushQueueForSession(s)
    await new Promise((r) => setTimeout(r, 800))
    expect(seen.some((u) => u.includes('/message'))).toBe(true)
    expect(seen.some((u) => u.includes('/summarize'))).toBe(false)
    expect(listQueuedChats(s)).toEqual([])
  })
  it('대소문자 변형(/Compact)은 기존 /command 경로 유지', async () => {
    const s = sid()
    const { seen } = stubFetch()
    enqueueQueuedChat(s, '/Compact', '/ws', { model: MODEL })
    flushQueueForSession(s)
    await new Promise((r) => setTimeout(r, 800))
    expect(seen.some((u) => u.includes('/command'))).toBe(true)
    expect(seen.some((u) => u.includes('/summarize'))).toBe(false)
    expect(listQueuedChats(s)).toEqual([])
  })
})
