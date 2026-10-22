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
  preSendStripIfMismatch: vi.fn(async () => ({ tailIds: [] })),
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
  markSessionStatusIdle: vi.fn(),
}))

import {
  enqueueQueuedChat,
  listQueuedChats,
  flushQueueForSession,
  flushReadyQueues,
} from '../../src/services/chat-queue'

let n = 0
// queues는 모듈 레벨 Map이라 테스트 간 유지된다 — sid는 절대 재사용하지 않는다.
const sid = () => `ses-turnend-${++n}`

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * 턴이 끝났는데(opencode 응답이 안 왔는데) 백단이 계속 대기하면 안 된다.
 *
 * 재현: 큐 발송의 /message 응답이 유실된 상태에서 세션이 busy → idle 로 바뀐다.
 * 이전 구현은 붙어 있는 요청을 끝까지 기다렸다(SEND_HEADERS_TIMEOUT_MS=600s).
 */
describe('큐 발송 — 턴 종료(idle 관측) 시 업스트림 요청을 끊는다', () => {
  it('idle 로 확인되면 진행 중이던 요청이 중단된다 (무한 대기 없음)', async () => {
    const s = sid()
    // 0: 발송 허용(idle) → 1: 턴 진행 중(busy) → 2: 턴 종료(idle)
    let phase = 0
    let upstreamAborted = false

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: { signal?: AbortSignal }) => {
        const u = String(url)
        if (u.includes('/message')) {
          // 응답을 끝내지 않는다 — 턴 응답이 유실된 상태.
          return new Promise((_resolve, reject) => {
            const signal = init?.signal
            const onAbort = () => {
              upstreamAborted = true
              reject(new DOMException('This operation was aborted', 'AbortError'))
            }
            if (signal?.aborted) onAbort()
            else signal?.addEventListener('abort', onAbort, { once: true })
          })
        }
        if (u.includes('/session/status')) {
          return {
            ok: true,
            status: 200,
            text: async () => '',
            json: async () => (phase === 1 ? { [s]: { type: 'busy' } } : {}),
          }
        }
        // permission/question — 대기 없음
        return { ok: true, status: 200, text: async () => '', json: async () => [] }
      }),
    )

    enqueueQueuedChat(s, 'long running task', '/ws')
    flushQueueForSession(s)
    await new Promise((r) => setTimeout(r, 200))
    expect(listQueuedChats(s)[0]?.status).toBe('sending')
    expect(upstreamAborted).toBe(false)

    // 턴 진행 중 관측 (busy) — 이 관측이 없으면 idle 로 판단해 끊지 않는다(오발 방지).
    phase = 1
    flushReadyQueues(new Set())
    await new Promise((r) => setTimeout(r, 100))
    expect(upstreamAborted).toBe(false)

    // 턴 종료(idle) — 진행 중이던 업스트림 요청을 끊는다.
    phase = 2
    flushReadyQueues(new Set())
    await new Promise((r) => setTimeout(r, 300))

    expect(upstreamAborted).toBe(true)
    // 확정은 다음 idle 관찰에서 난다(발송 결과 미확정 상태로 항목을 남긴다).
    flushReadyQueues(new Set())
    await new Promise((r) => setTimeout(r, 200))
    expect(listQueuedChats(s).length).toBe(0)
  }, 20000)

  it('busy 를 한 번도 관측하지 못하면 idle 이여도 끊지 않는다 (오발 방지)', async () => {
    const s = sid()
    let upstreamAborted = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: { signal?: AbortSignal }) => {
        const u = String(url)
        if (u.includes('/message')) {
          return new Promise((_resolve, reject) => {
            const signal = init?.signal
            const onAbort = () => {
              upstreamAborted = true
              reject(new DOMException('This operation was aborted', 'AbortError'))
            }
            if (signal?.aborted) onAbort()
            else signal?.addEventListener('abort', onAbort, { once: true })
          })
        }
        if (u.includes('/session/status')) {
          return { ok: true, status: 200, text: async () => '', json: async () => ({}) }
        }
        return { ok: true, status: 200, text: async () => '', json: async () => [] }
      }),
    )

    enqueueQueuedChat(s, 'never observed busy', '/ws')
    flushQueueForSession(s)
    await new Promise((r) => setTimeout(r, 200))
    flushReadyQueues(new Set())
    await new Promise((r) => setTimeout(r, 300))

    // 항목을 제거하지도 않는다 — 발송 결과가 미확정이므로(유실 방지).
    expect(upstreamAborted).toBe(false)
    expect(listQueuedChats(s)[0]?.status).toBe('sending')
  }, 20000)
})
