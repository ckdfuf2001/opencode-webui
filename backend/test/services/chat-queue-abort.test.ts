import { describe, it, expect, vi } from 'vitest'

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
  removeQueuedChat,
  clearSendingOnAbort,
  clearQueuedChats,
  isQuotaRejection,
} from '../../src/services/chat-queue'

let n = 0
const sid = () => `ses-abort-${++n}`

describe('isQuotaRejection', () => {
  it('402 is always quota', () => {
    expect(isQuotaRejection(402, 'anything')).toBe(true)
    expect(isQuotaRejection(402, '')).toBe(true)
  })
  it('429 with billing text is quota, plain rate-limit is not', () => {
    expect(isQuotaRejection(429, 'exceeded your current quota, add credits')).toBe(true)
    expect(isQuotaRejection(429, 'insufficient_quota')).toBe(true)
    expect(isQuotaRejection(429, 'too many requests, slow down')).toBe(false)
    expect(isQuotaRejection(429, '')).toBe(false)
  })
  it('400 with billing text is quota', () => {
    expect(isQuotaRejection(400, 'FreeUsageLimit exceeded')).toBe(true)
    expect(isQuotaRejection(400, 'bad request syntax')).toBe(false)
  })
  it('other statuses are not quota', () => {
    expect(isQuotaRejection(500, 'quota exceeded')).toBe(false)
    expect(isQuotaRejection(undefined, 'quota exceeded')).toBe(true)
  })
})

describe('abort clears sending', () => {
  it('clearSendingOnAbort removes the sending item so cancel is visible', () => {
    const s = sid()
    enqueueQueuedChat(s, 'quota stuck message', '/ws')
    listQueuedChats(s)[0]!.status = 'sending'
    clearSendingOnAbort(s)
    expect(listQueuedChats(s)).toHaveLength(0)
  })
  it('removeQueuedChat can delete a sending item (strip X button)', () => {
    const s = sid()
    const [item] = enqueueQueuedChat(s, 'sending cancel me', '/ws')
    listQueuedChats(s)[0]!.status = 'sending'
    expect(removeQueuedChat(s, item!.id)).toBe(true)
    expect(listQueuedChats(s)).toHaveLength(0)
  })
  it('clearQueuedChats clears everything', () => {
    const s = sid()
    enqueueQueuedChat(s, 'one', '/ws')
    enqueueQueuedChat(s, 'two', '/ws')
    expect(clearQueuedChats(s)).toBe(2)
    expect(listQueuedChats(s)).toHaveLength(0)
  })
})
