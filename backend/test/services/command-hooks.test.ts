import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  firePreCommandHooks,
  firePostCommandHooks,
  getRecentHookCalls,
  clearRecentHookCalls,
  TODO_PROTOCOL,
  resolveCommandKind,
  buildSkillCheckBlock,
  isReviewSession,
  maybeSpawnReviewChild,
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

  it('TODO_PROTOCOL declares todo-first, todo-only updates, todo-based failure', () => {
    expect(TODO_PROTOCOL).toMatch(/todo tool is available/i)
    expect(TODO_PROTOCOL).toMatch(/only via todo updates/i)
    expect(TODO_PROTOCOL).toMatch(/only if a todo fails/i)
  })

  it('resolveCommandKind defaults to command without skill files', () => {
    expect(resolveCommandKind(null, 'review')).toBe('command')
    expect(resolveCommandKind('/nonexistent-dir-xyz', 'review')).toBe('command')
    expect(resolveCommandKind(null, '')).toBe('command')
  })

  it('buildSkillCheckBlock returns empty without pending and consumes once', async () => {
    expect(buildSkillCheckBlock({ sessionId: 'sess-empty' })).toBe('')
    // post 훅으로 pending을 쌓으면 1회만 블록이 나온다 (plan 문구 = 자동 변경 OFF 기본)
    firePostCommandHooks(makeRun({ sessionId: 'sess-1', kind: 'command', directory: '/tmp' }), 'completed')
    await flushAsync()
    const first = buildSkillCheckBlock({ sessionId: 'sess-1' })
    expect(first).toContain('<skill-memory-check>')
    expect(first).toContain('ask the user in chat for approval')
    expect(buildSkillCheckBlock({ sessionId: 'sess-1' })).toBe('')
  })

  it('maybeSpawnReviewChild returns null without review toggle/db', async () => {
    // 리뷰 세션 가드: 존재하지 않는 ID는 false
    expect(isReviewSession('sess-1')).toBe(false)
    const spawned = await maybeSpawnReviewChild({
      sessionId: 'sess-1',
      directory: '/tmp',
      repoId: null,
      commandName: 'review',
      kind: 'command',
      status: 'completed',
    })
    expect(spawned).toBeNull()
    // 실패 턴은 리뷰 대상이 아니다
    const failed = await maybeSpawnReviewChild({
      sessionId: 'sess-1',
      directory: '/tmp',
      repoId: 1,
      commandName: 'review',
      kind: 'command',
      status: 'failed',
    })
    expect(failed).toBeNull()
  })
})
