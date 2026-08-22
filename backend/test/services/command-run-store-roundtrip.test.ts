import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { appendToDir, updateInDir, listFromDir } from '../../src/services/command-run-store'
import type { CommandRun } from '../../src/db/command-run-queries'

// /view 데이터 경로(insert -> finish -> list)를 파일 레벨에서 검증한다.
describe('command-run-store round-trip', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'store-roundtrip-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeRun(id: string): CommandRun {
    return {
      id,
      sessionId: 'sess-x',
      repoId: null,
      commandName: 'cmd',
      args: null,
      directory: null,
      messageId: null,
      status: 'started',
      origin: 'ui',
      startedAt: Date.now(),
      finishedAt: null,
      createdAt: Date.now(),
    }
  }

  it('append, finish, list returns final status', async () => {
    const run = makeRun('rt-1')
    await appendToDir(dir, run)

    const started = await listFromDir(dir, () => true)
    expect(started.map((r) => r.status)).toEqual(['started'])

    await updateInDir(dir, run.id, (r) =>
      r.status === 'started' ? { ...r, status: 'completed', finishedAt: Date.now() } : r,
    )

    const done = await listFromDir(dir, () => true)
    expect(done[0]?.status).toBe('completed')
    expect(done[0]?.finishedAt).not.toBeNull()
  })
})
