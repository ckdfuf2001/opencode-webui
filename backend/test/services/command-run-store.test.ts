import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import {
  appendToDir,
  updateInDir,
  listFromDir,
  monthKey,
} from '../../src/services/command-run-store'
import type { CommandRun } from '../../src/db/command-run-queries'

function makeRun(overrides: Partial<CommandRun> = {}): CommandRun {
  return {
    id: 'run-1',
    sessionId: 'sess-1',
    repoId: 1,
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

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('command-run-store', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'run-history-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('formats month keys', () => {
    expect(monthKey(new Date(2026, 7, 23).getTime())).toBe('2026-08')
  })

  it('appends runs as jsonl lines into a monthly file', async () => {
    await appendToDir(dir, makeRun())
    await flush()

    const file = path.join(dir, `${monthKey(Date.now())}.jsonl`)
    expect(existsSync(file)).toBe(true)

    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 'run-1', commandName: '월간보고' })
  })

  it('updates a run in place and reports the updated record', async () => {
    await appendToDir(dir, makeRun())

    const updated = await updateInDir(
      dir,
      'run-1',
      (r) => (r.status !== 'started' ? r : { ...r, status: 'completed', finishedAt: 1234 }),
    )
    expect(updated?.status).toBe('completed')
    expect(updated?.finishedAt).toBe(1234)

    const runs = await listFromDir(dir, () => true)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).toBe('completed')
  })

  it('sets messageId only once', async () => {
    await appendToDir(dir, makeRun())

    await updateInDir(dir, 'run-1', (r) => (r.messageId ? r : { ...r, messageId: 'msg-a' }))
    await updateInDir(dir, 'run-1', (r) => (r.messageId ? r : { ...r, messageId: 'msg-b' }))

    const runs = await listFromDir(dir, () => true)
    expect(runs[0]?.messageId).toBe('msg-a')
  })

  it('removes a run when the updater returns null', async () => {
    await appendToDir(dir, makeRun())
    await appendToDir(dir, makeRun({ id: 'run-2' }))

    await updateInDir(dir, 'run-1', () => null)

    const runs = await listFromDir(dir, () => true)
    expect(runs.map((r) => r.id)).toEqual(['run-2'])
  })

  it('filters and sorts descending by startedAt', async () => {
    await appendToDir(dir, makeRun({ id: 'a', sessionId: 's1', startedAt: 100 }))
    await appendToDir(dir, makeRun({ id: 'b', sessionId: 's1', startedAt: 300 }))
    await appendToDir(dir, makeRun({ id: 'c', sessionId: 's2', startedAt: 200 }))
    await flush()

    const s1 = await listFromDir(dir, (r) => r.sessionId === 's1')
    expect(s1.map((r) => r.id)).toEqual(['b', 'a'])

    const inRange = await listFromDir(dir, (r) => r.startedAt >= 150 && r.startedAt <= 250)
    expect(inRange.map((r) => r.id)).toEqual(['c'])
  })

  it('keeps the kind field through a write/read cycle and treats missing kind as command on read', async () => {
    await appendToDir(dir, makeRun({ id: 'cmd-1', kind: 'command' }))
    await appendToDir(dir, makeRun({ id: 'skill-1', kind: 'skill' }))
    // 레거시 레코드: kind 필드 자체가 없던 시절 라인을 시뮬레이션한다.
    await appendToDir(dir, makeRun({ id: 'legacy-1' }))
    await flush()

    const file = path.join(dir, `${monthKey(Date.now())}.jsonl`)
    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    const legacyLine = JSON.parse(lines[2]!) as Record<string, unknown>
    expect(legacyLine).not.toHaveProperty('kind')

    const runs = await listFromDir(dir, () => true)
    expect(runs.map((r) => r.id).sort()).toEqual(['cmd-1', 'legacy-1', 'skill-1'])

    // /view 와 동일한 규칙: kind 가 'skill' 인 것만 걸러낸다(없음/undefined 는 통과).
    const visible = runs.filter((r) => r.kind !== 'skill')
    expect(visible.map((r) => r.id).sort()).toEqual(['cmd-1', 'legacy-1'])
  })
})
