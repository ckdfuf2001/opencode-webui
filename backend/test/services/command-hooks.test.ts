import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  firePreCommandHooks,
  firePostCommandHooks,
  getRecentHookCalls,
  clearRecentHookCalls,
} from '../../src/services/command-hooks'
import type { CommandRun } from '../../src/db/command-run-queries'

function makeRun(overrides: Partial<CommandRun> = {}): CommandRun {
  return {
    id: 'run-1',
    sessionId: 'sess-1',
    repoId: null,
    commandName: '월간보고',
    args: null,
    directory: null,
    messageId: null,
    status: 'started',
    origin: 'ui',
    startedAt: Date.now(),
    finishedAt: null,
    createdAt: Date.now(),
    ...overrides,
  }
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('command-hooks', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    clearRecentHookCalls()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it('pre hook records and logs the run', async () => {
    firePreCommandHooks(makeRun())
    await flushAsync()

    const calls = getRecentHookCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.phase).toBe('pre')
    expect(calls[0]?.commandName).toBe('월간보고')
    expect(calls[0]?.runId).toBe('run-1')
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[pre-command] 월간보고'))
  })

  it('post hook records the final status', async () => {
    firePostCommandHooks(makeRun(), 'failed')
    await flushAsync()

    const calls = getRecentHookCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.phase).toBe('post')
    expect(calls[0]?.status).toBe('failed')
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('status=failed'))
  })

  it('keeps newest first and caps the buffer', async () => {
    for (let i = 0; i < 60; i++) {
      firePreCommandHooks(makeRun({ id: `run-${i}`, commandName: `cmd-${i}` }))
      await flushAsync()
    }

    const calls = getRecentHookCalls()
    expect(calls.length).toBeLessThanOrEqual(50)
    expect(calls[0]?.commandName).toBe('cmd-59')
  })
})
