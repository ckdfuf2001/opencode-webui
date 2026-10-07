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
  isTimeoutFailure,
  recordTransientTimeout,
} from '../../src/services/chat-queue'

let n = 0
// 주의: queues는 모듈 레벨 Map이라 테스트 간 유지된다 — sid는 절대 재사용하지 않는다.
const sid = () => `ses-timeout-${++n}`

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isTimeoutFailure (opencode 5분 내부 타임아웃 판정)', () => {
  it('504/408은 본문 없이도 타임아웃', () => {
    expect(isTimeoutFailure(504)).toBe(true)
    expect(isTimeoutFailure(504, '')).toBe(true)
    expect(isTimeoutFailure(408, 'whatever')).toBe(true)
  })
  it('timeout 문구의 5xx는 타임아웃', () => {
    expect(isTimeoutFailure(500, 'Gateway Timeout: request timed out')).toBe(true)
    expect(isTimeoutFailure(502, 'deadline exceeded')).toBe(true)
    expect(isTimeoutFailure(503, 'OpenCode internal timeout (300s / 5분)')).toBe(true)
  })
  it('timeout과 무관한 상태는 타임아웃이 아니다', () => {
    expect(isTimeoutFailure(500, 'internal error')).toBe(false)
    expect(isTimeoutFailure(500, '')).toBe(false)
    expect(isTimeoutFailure(400, 'encrypted_content was not issued')).toBe(false)
    expect(isTimeoutFailure(429, 'quota exceeded, timed out? no')).toBe(false)
    expect(isTimeoutFailure(undefined, 'timed out')).toBe(false)
    expect(isTimeoutFailure(undefined, undefined)).toBe(false)
  })
})

describe('recordTransientTimeout (상한 전까지 queued 유지)', () => {
  it('상한 전까지는 queued 유지, 상한부터 failed 고정', () => {
    const s = sid()
    enqueueQueuedChat(s, 'long turn prompt', '/ws')
    const id = listQueuedChats(s)[0]!.id
    recordTransientTimeout(s, id)
    expect(listQueuedChats(s)[0]!.status).toBe('queued')
    recordTransientTimeout(s, id)
    expect(listQueuedChats(s)[0]!.status).toBe('queued')
    // 3번째 연속 타임아웃: 무한 재시도 대신 failed 고정
    recordTransientTimeout(s, id)
    const head = listQueuedChats(s)[0]!
    expect(head.status).toBe('failed')
    expect(head.attempts).toBe(3)
    expect(head.failedAt).toBeDefined()
  })
})

describe('504 응답 시 큐가 즉시 failed가 되지 않는다', () => {
  it('첫 504는 queued 유지 + 백오프로 자동 재시도 예약', async () => {
    const s = sid()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const u = String(url)
        if (u.includes('/message')) {
          return {
            ok: false,
            status: 504,
            text: async () => 'Gateway Timeout (504): OpenCode internal timeout (300s / 5분). timed out',
            json: async () => ({}),
          }
        }
        // status/permission/question — idle, 대기 없음
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => (u.includes('/session/status') ? {} : []),
        }
      }),
    )
    enqueueQueuedChat(s, 'please do the 6-minute analysis', '/ws')
    flushQueueForSession(s)
    await new Promise((r) => setTimeout(r, 500))
    const head = listQueuedChats(s)[0]
    expect(head).toBeDefined()
    // 기존 버그: MAX_CONSECUTIVE_FAILURES=1에 즉시 failed. 수정 후: queued 유지.
    expect(head!.status).toBe('queued')
  })

  it('timeout 문구 없는 500도 queued 유지 (5xx는 서버측 실패로 간주)', async () => {
    const s = sid()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const u = String(url)
        if (u.includes('/message')) {
          return {
            ok: false,
            status: 500,
            text: async () => 'Internal server error',
            json: async () => ({}),
          }
        }
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => (u.includes('/session/status') ? {} : []),
        }
      }),
    )
    enqueueQueuedChat(s, 'another long task', '/ws')
    flushQueueForSession(s)
    await new Promise((r) => setTimeout(r, 500))
    expect(listQueuedChats(s)[0]!.status).toBe('queued')
  })

  it('코드 없는 전송 오류(TypeError)도 queued 유지', async () => {
    const s = sid()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const u = String(url)
        if (u.includes('/message')) {
          throw new TypeError('fetch failed')
        }
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => (u.includes('/session/status') ? {} : []),
        }
      }),
    )
    enqueueQueuedChat(s, 'yet another long task', '/ws')
    flushQueueForSession(s)
    await new Promise((r) => setTimeout(r, 500))
    expect(listQueuedChats(s)[0]!.status).toBe('queued')
  })

  it('400 같은 4xx는 그대로 failed (클라이언트 오류)', async () => {
    const s = sid()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const u = String(url)
        if (u.includes('/message')) {
          return {
            ok: false,
            status: 400,
            text: async () => 'bad request: unknown part type',
            json: async () => ({}),
          }
        }
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => (u.includes('/session/status') ? {} : []),
        }
      }),
    )
    enqueueQueuedChat(s, 'broken prompt', '/ws')
    flushQueueForSession(s)
    await new Promise((r) => setTimeout(r, 500))
    expect(listQueuedChats(s)[0]!.status).toBe('failed')
  })
})
