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

vi.mock('../../src/services/command-runs', () => ({
  resolveLiveDirectory: (_db: unknown, dir: string) => dir,
}))

vi.mock('../../src/db/session-status-queries', () => ({
  getSessionStatusRow: () => undefined,
  setSessionCancelled: vi.fn(),
}))

import { enqueueQueuedChat, listQueuedChats, removeQueuedChat, dropDeliveredDuplicates } from '../../src/services/chat-queue'

let n = 0
// 주의: queues는 모듈 레벨 Map이라 테스트 간 유지된다 — sid는 절대 재사용하지 않는다.
const sid = () => `ses-drop-${++n}`

describe('dropDeliveredDuplicates', () => {
  it('drops a failed duplicate with identical text and keeps the rest', () => {
    const s = sid()
    enqueueQueuedChat(s, 'hello world', '/ws')
    enqueueQueuedChat(s, 'other question', '/ws')
    listQueuedChats(s)[0]!.status = 'failed'
    const removed = dropDeliveredDuplicates(s, 'hello world')
    expect(removed).toBe(1)
    expect(listQueuedChats(s).map((q) => q.text)).toEqual(['other question'])
  })
  it('ignores surrounding whitespace differences', () => {
    const s = sid()
    enqueueQueuedChat(s, '  hello world\n', '/ws')
    listQueuedChats(s)[0]!.status = 'failed'
    expect(dropDeliveredDuplicates(s, '\nhello world  ')).toBe(1)
    expect(listQueuedChats(s)).toEqual([])
  })
  it('never drops a sending item (already handed to opencode)', () => {
    const s = sid()
    enqueueQueuedChat(s, 'hello world', '/ws')
    listQueuedChats(s)[0]!.status = 'sending'
    expect(dropDeliveredDuplicates(s, 'hello world')).toBe(0)
    expect(listQueuedChats(s)).toHaveLength(1)
  })
  it('returns 0 and touches nothing when nothing matches', () => {
    const s = sid()
    enqueueQueuedChat(s, 'hello world', '/ws')
    expect(dropDeliveredDuplicates(s, 'unrelated')).toBe(0)
    expect(listQueuedChats(s)).toHaveLength(1)
    expect(dropDeliveredDuplicates('ses-nonexistent', 'hello world')).toBe(0)
    expect(dropDeliveredDuplicates(s, '   ')).toBe(0)
  })
  it('removes the queue registration when everything is dropped', () => {
    const s = sid()
    enqueueQueuedChat(s, 'same text', '/ws')
    enqueueQueuedChat(s, 'same text', '/ws')
    expect(dropDeliveredDuplicates(s, 'same text')).toBe(2)
    expect(listQueuedChats(s)).toEqual([])
    // teardown hygiene for the module-level map
    expect(removeQueuedChat(s, 'nope')).toBe(false)
  })
})
