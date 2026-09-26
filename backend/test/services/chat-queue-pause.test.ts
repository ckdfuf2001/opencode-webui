import { describe, it, expect, afterEach, vi } from 'vitest'

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

// chat-queue가 직접 import한다 (bun:sqlite 런타임 — vitest node에서 로드 불가).
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
  clearQueuedChats,
  flushQueueForSession,
  setQueuePaused,
  isQueuePaused,
} from '../../src/services/chat-queue'

/**
 * 일시정지: 진행 중 generation은 유지, 큐 신규 발송만 멈춘다.
 * 네트워크를 타기 전(dispatchHead 게이트)에 막히므로 stub 서버 없이 검증한다.
 */
describe('queue pause', () => {
  const sid = 'test-pause-session'

  afterEach(() => {
    setQueuePaused(sid, false)
    try { clearQueuedChats(sid) } catch {}
  })

  it('set/is roundtrip', () => {
    expect(isQueuePaused(sid)).toBe(false)
    setQueuePaused(sid, true)
    expect(isQueuePaused(sid)).toBe(true)
    setQueuePaused(sid, false)
    expect(isQueuePaused(sid)).toBe(false)
  })

  it('paused면 flush해도 발송하지 않고 queued 유지', async () => {
    enqueueQueuedChat(sid, 'hello paused')
    expect(listQueuedChats(sid)).toHaveLength(1)
    setQueuePaused(sid, true)
    flushQueueForSession(sid)
    await new Promise((r) => setTimeout(r, 300))
    const items = listQueuedChats(sid)
    expect(items).toHaveLength(1)
    expect(items[0]?.status).toBe('queued')
  })

  it('unpause는 플래그만 내린다 (재개 발송은 라우터가 flush)', () => {
    setQueuePaused(sid, true)
    setQueuePaused(sid, false)
    expect(isQueuePaused(sid)).toBe(false)
  })
})
