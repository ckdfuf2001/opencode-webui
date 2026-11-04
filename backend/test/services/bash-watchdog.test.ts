import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('bun:sqlite', () => ({
  Database: vi.fn(),
}))

vi.mock('@opencode-webui/shared', () => ({
  getWorkspacePath: () => '/ws',
  ENV: {},
}))

vi.mock('../../src/services/opencode-single-server', () => ({
  opencodeServerManager: { getUrl: () => 'http://opencode-test' },
}))

vi.mock('../../src/services/opencode-auth', () => ({
  ensureServerAuth: (h: unknown) => h,
}))

vi.mock('../../src/services/chat-queue', () => ({
  abortQueueInFlight: vi.fn(),
}))

vi.mock('../../src/services/command-runs', () => ({
  resolveLiveDirectory: (_db: unknown, dir: string) => dir,
  resolveRepoId: () => null,
}))

vi.mock('../../src/services/session-message-db', () => ({
  listRunningBashDetails: vi.fn(async () => []),
}))

vi.mock('../../src/services/proxy-turn-end', () => ({
  sweepAbortTracked: vi.fn(() => true),
}))

vi.mock('../../src/db/session-status-queries', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/db/session-status-queries')>()
  return mod
})
import {
  createBashWatchdog,
  isBashTimedOut,
  bashTimeoutMs,
  BASH_GRACE_MS,
  type BashWatchdogPart,
} from '../../src/services/bash-watchdog'

function part(over: Partial<BashWatchdogPart> = {}): BashWatchdogPart {
  const now = Date.now()
  return {
    sessionId: 's1',
    messageId: 'm1',
    partId: 'p1',
    tool: 'bash',
    command: 'sleep 300',
    rawTimeout: 120_000,
    rawStart: now - 300_000,
    timeUpdated: now - 300_000,
    messageCreated: now - 300_000,
    ...over,
  }
}

function makeDeps(over: Partial<Parameters<typeof createBashWatchdog>[0]> = {}) {
  const calls = { idle: [] as string[], orphan: [] as string[], abort: [] as string[], infos: [] as string[] }
  const deps: Parameters<typeof createBashWatchdog>[0] = {
    listBusySessions: () => [{ sessionId: 's1', directory: '/repo', pendingPermissions: 0 }],
    fetchOpencodeBusy: async () => false,
    listBashParts: async () => [part()],
    markIdle: (sid: string) => calls.idle.push(sid),
    markOrphan: (p: BashWatchdogPart) => calls.orphan.push(p.partId),
    abortInFlight: (sid: string) => calls.abort.push(sid),
    logInfo: (m: string) => calls.infos.push(m),
    logWarn: () => {},
    now: () => Date.now(),
    ...over,
  }
  return { deps, calls }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('bash-watchdog (backend)', () => {
  it('timeout 기본 120s + grace 30s 이전에는 손대지 않는다', () => {
    const now = Date.now()
    // 100s 경과 — 아직 만료 아님 (120s+30s=150s 필요)
    expect(isBashTimedOut(part({ rawStart: now - 100_000, timeUpdated: now - 100_000, messageCreated: now - 100_000 }), now)).toBe(false)
  })

  it('timeout 상한 600s를 넘지 않는다', () => {
    expect(bashTimeoutMs(999_999_999)).toBe(600_000)
    expect(bashTimeoutMs(null)).toBe(120_000)
  })

  it('opencode idle + 만료 bash면 idle+orphan+abort 한다', async () => {
    const { deps, calls } = makeDeps()
    const wd = createBashWatchdog(deps, { intervalMs: 10_000 })
    const cleared = await wd.runOnce()
    expect(cleared).toEqual(['s1'])
    expect(calls.idle).toEqual(['s1'])
    expect(calls.orphan).toEqual(['p1'])
    expect(calls.abort).toEqual(['s1'])
    expect(calls.infos.some((m) => m.includes('[bash-watchdog]'))).toBe(true)
  })

  it('opencode가 아직 busy면 건드리지 않는다', async () => {
    const { deps, calls } = makeDeps({ fetchOpencodeBusy: async () => true })
    const wd = createBashWatchdog(deps)
    expect(await wd.runOnce()).toEqual([])
    expect(calls.idle).toEqual([])
    expect(calls.abort).toEqual([])
  })

  it('만료 전이면 opencode idle이라도 기다린다', async () => {
    const now = Date.now()
    const fresh = part({ rawStart: now - 10_000, timeUpdated: now - 10_000, messageCreated: now - 10_000 })
    const { deps, calls } = makeDeps({ listBashParts: async () => [fresh] })
    const wd = createBashWatchdog(deps)
    expect(await wd.runOnce()).toEqual([])
    expect(calls.idle).toEqual([])
  })

  it('승인 대기 중이면 강제 종료하지 않는다', async () => {
    const { deps, calls } = makeDeps({
      listBusySessions: () => [{ sessionId: 's1', directory: '/repo', pendingPermissions: 1 }],
    })
    const wd = createBashWatchdog(deps)
    expect(await wd.runOnce()).toEqual([])
    expect(calls.idle).toEqual([])
  })

  it('fetch 실패(unknown)는 idle로 오판하지 않는다', async () => {
    const { deps, calls } = makeDeps({
      fetchOpencodeBusy: async () => {
        throw new Error('down')
      },
    })
    const wd = createBashWatchdog(deps)
    expect(await wd.runOnce()).toEqual([])
    expect(calls.idle).toEqual([])
  })

  it('bash 파트가 없으면 손대지 않는다 (일반 정리는 poller/sweep 영역)', async () => {
    const { deps, calls } = makeDeps({ listBashParts: async () => [] })
    const wd = createBashWatchdog(deps)
    expect(await wd.runOnce()).toEqual([])
    expect(calls.idle).toEqual([])
  })

  it('grace 경계: timeout+grace 정확히 넘기면 고착으로 본다', () => {
    const now = Date.now()
    const timeout = 120_000
    const at = now - (timeout + BASH_GRACE_MS + 1000)
    expect(isBashTimedOut(part({ rawTimeout: timeout, rawStart: at, timeUpdated: at, messageCreated: at }), now)).toBe(true)
  })
})
