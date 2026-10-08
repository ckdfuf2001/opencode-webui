import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  processNotifyTick,
  resetNotifyWatcherState,
  resolvePushEnabled,
  decideCompletionLabel,
  ABORT_WINDOW_MS,
  type NotifyTickInput,
} from '../../src/services/notify-watcher'
import { showOsToast } from '../../src/services/os-notify'

vi.mock('../../src/services/settings', () => ({
  SettingsService: class {
    getSettings() {
      return { preferences: { pushNotificationEnabled: true, pushNotificationDuration: 0 } }
    }
  },
}))

const notifyState = { lastSendAt: 0, lastAbortAt: 0 }
vi.mock('../../src/db/notify-queries', () => ({
  getNotifyOverride: () => null,
  getNotifyState: () => ({ ...notifyState }),
  touchNotifySend: vi.fn(),
  touchNotifyAbort: vi.fn(),
}))

vi.mock('../../src/db/session-status-queries', () => ({
  getSessionStatusRow: () => null,
}))

vi.mock('../../src/db/session-permission-rule-queries', () => ({
  listSessionPermissionRules: () => sessionRules,
}))

vi.mock('../../src/db/queries', () => ({
  listRepos: () => [],
}))

let sessionRules: Array<{ id: string; sessionId: string; permission: string; pattern: string; createdAt: number }> = []

let queued: Array<{ status: string }> = []
vi.mock('../../src/services/chat-queue', () => ({
  listQueuedChats: () => queued,
}))

let lastMessage: { info: { role: string; time: { completed?: number } } } | null = null
vi.mock('../../src/services/session-message-db', () => ({
  recentSessionMessages: vi.fn(async () => (lastMessage ? { total: 1, messages: [lastMessage] } : null)),
}))

vi.mock('../../src/services/opencode-single-server', () => ({
  opencodeServerManager: { getUrl: () => 'http://opencode-test' },
}))

vi.mock('../../src/services/opencode-auth', () => ({
  ensureServerAuth: (h: unknown) => h,
}))

vi.mock('../../src/services/os-notify', () => ({
  showOsToast: vi.fn(() => true),
}))

vi.stubGlobal(
  'fetch',
  vi.fn(async (url: unknown) =>
    String(url).includes('/permission')
      ? { ok: true, json: async () => [{ id: 'perm-1', sessionID: 's1', permission: 'bash', patterns: ['git status'] }] }
      : { ok: false },
  ),
)

const toast = vi.mocked(showOsToast)

function tickInput(sessionId: string, busy: boolean, extra?: Partial<{ perm: number; question: number }>): NotifyTickInput {
  return {
    busyNow: busy ? new Set([sessionId]) : new Set(),
    info: new Map([
      [sessionId, { repoId: null, directory: 'global', perm: extra?.perm ?? 0, question: extra?.question ?? 0 }],
    ]),
  }
}

const flush = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  vi.clearAllMocks()
  resetNotifyWatcherState()
  queued = []
  lastMessage = null
  sessionRules = []
  notifyState.lastSendAt = 0
  notifyState.lastAbortAt = 0
})

describe('resolvePushEnabled', () => {
  const ov = (pushEnabled: boolean | null) => ({
    scope: 'session' as const,
    target: 'x',
    pushEnabled,
    soundEnabled: null,
    soundOnCancelEnabled: null,
    skillAutoEnabled: null,
    skillReviewEnabled: null,
    updatedAt: 0,
  })
  it('session > repo > global', () => {
    expect(resolvePushEnabled(ov(false), ov(true), true)).toBe(false)
    expect(resolvePushEnabled(ov(null), ov(true), false)).toBe(true)
    expect(resolvePushEnabled(null, null, true)).toBe(true)
    expect(resolvePushEnabled(null, null, false)).toBe(false)
  })
})

describe('decideCompletionLabel', () => {
  it('abort가 마지막 send 이후 window 안이면 cancelled', () => {
    const now = 1_000_000
    expect(decideCompletionLabel(100, now - 5_000, now)).toBe('cancelled')
  })
  it('abort가 오래됐으면 completed (stale)', () => {
    const now = 1_000_000
    expect(decideCompletionLabel(100, now - ABORT_WINDOW_MS - 1, now)).toBe('completed')
  })
  it('send가 abort보다 최근이면 completed', () => {
    const now = 1_000_000
    expect(decideCompletionLabel(now - 1_000, now - 5_000, now)).toBe('completed')
  })
  it('기록 없으면 completed', () => {
    expect(decideCompletionLabel(0, 0, 1_000_000)).toBe('completed')
  })
})

describe('processNotifyTick completion', () => {
  it('busy→idle + 완료 메시지면 완료 토스트', async () => {
    const now = 1_000_000
    processNotifyTick({} as never, tickInput('s1', true), now)
    lastMessage = { info: { role: 'assistant', time: { completed: now } } }
    processNotifyTick({} as never, tickInput('s1', false), now + 1_000)
    await flush()
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0]![0]).toBe('응답이 완료되었습니다')
  })

  it('미완료 메시지면 알리지 않는다', async () => {
    const now = 1_000_000
    processNotifyTick({} as never, tickInput('s1', true), now)
    lastMessage = { info: { role: 'assistant', time: {} } }
    processNotifyTick({} as never, tickInput('s1', false), now + 1_000)
    await flush()
    expect(toast).not.toHaveBeenCalled()
  })

  it('큐에 후속 턴이 있으면 알리지 않는다', async () => {
    const now = 1_000_000
    processNotifyTick({} as never, tickInput('s1', true), now)
    queued = [{ status: 'queued' }]
    lastMessage = { info: { role: 'assistant', time: { completed: now } } }
    processNotifyTick({} as never, tickInput('s1', false), now + 1_000)
    await flush()
    expect(toast).not.toHaveBeenCalled()
  })

  it('abort가 최신이면 취소 토스트 (lastDone 검증 없이)', async () => {
    const now = 1_000_000
    notifyState.lastSendAt = now - 30_000
    notifyState.lastAbortAt = now - 2_000
    processNotifyTick({} as never, tickInput('s1', true), now)
    lastMessage = null
    processNotifyTick({} as never, tickInput('s1', false), now + 1_000)
    await flush()
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0]![0]).toBe('응답이 취소되었습니다')
  })
})

describe('processNotifyTick pending', () => {
  it('승인 대기는 grace 후 1회만 알린다', async () => {
    const now = 1_000_000
    processNotifyTick({} as never, tickInput('s1', true, { perm: 1 }), now)
    await flush()
    expect(toast).not.toHaveBeenCalled()
    processNotifyTick({} as never, tickInput('s1', true, { perm: 1 }), now + 5_000)
    await flush()
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0]![0]).toBe('승인이 필요합니다')
    // 같은 수는 반복 알림 없음
    processNotifyTick({} as never, tickInput('s1', true, { perm: 1 }), now + 10_000)
    await flush()
    expect(toast).toHaveBeenCalledTimes(1)
  })

  it('해소 후 새 대기는 다시 알린다', async () => {
    const now = 1_000_000
    processNotifyTick({} as never, tickInput('s1', true, { perm: 1 }), now)
    processNotifyTick({} as never, tickInput('s1', true, { perm: 1 }), now + 5_000)
    await flush()
    expect(toast).toHaveBeenCalledTimes(1)
    processNotifyTick({} as never, tickInput('s1', true, { perm: 0 }), now + 6_000)
    processNotifyTick({} as never, tickInput('s1', true, { question: 1 }), now + 7_000)
    await flush()
    expect(toast).toHaveBeenCalledTimes(1) // grace 전
    processNotifyTick({} as never, tickInput('s1', true, { question: 1 }), now + 12_000)
    await flush()
    expect(toast).toHaveBeenCalledTimes(2)
    expect(toast.mock.calls[1]![0]).toBe('질문이 도착했습니다')
  })

  it('자동승인 대상 승인은 토스트하지 않는다', async () => {
    sessionRules = [{ id: 'sess-1', sessionId: 's1', permission: 'bash', pattern: 'git status', createdAt: 0 }]
    const now = 1_000_000
    processNotifyTick({} as never, tickInput('s1', true, { perm: 1 }), now)
    processNotifyTick({} as never, tickInput('s1', true, { perm: 1 }), now + 5_000)
    await flush()
    processNotifyTick({} as never, tickInput('s1', true, { perm: 1 }), now + 10_000)
    await flush()
    expect(toast).not.toHaveBeenCalled()
  })
})
