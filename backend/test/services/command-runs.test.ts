import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const workspaceBase = { current: '' }

vi.mock('@opencode-webui/shared', () => ({
  getWorkspacePath: () => workspaceBase.current,
  getReposPath: () => path.join(workspaceBase.current, 'repos'),
  getConfigPath: () => path.join(workspaceBase.current, '.config'),
  ENV: { LOGGING: { DEBUG: false } },
}))

import { resolveLiveDirectory, resolveRepoId } from '../../src/services/command-runs'

function mockDb(rows: Record<string, unknown>[]) {
  return {
    prepare: vi.fn(() => ({
      all: () => rows,
      get: () => undefined,
      run: () => ({}),
    })),
  } as any
}

function repoRow(id: number, localPath: string) {
  return {
    id,
    repo_url: null,
    local_path: localPath,
    branch: null,
    default_branch: 'main',
    clone_status: 'ready',
    cloned_at: Date.now(),
    last_pulled: null,
    opencode_config_name: null,
    is_worktree: 0,
    is_local: 1,
    skill_auto_update: 0,
  }
}

describe('resolveLiveDirectory', () => {
  let base: string
  let reposDir: string

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'livedir-ws-'))
    reposDir = path.join(base, 'repos')
    mkdirSync(path.join(reposDir, 'proj'), { recursive: true })
    workspaceBase.current = base
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('keeps a directory that still exists', () => {
    const live = path.join(reposDir, 'proj')
    const db = mockDb([repoRow(7, 'proj')])
    expect(resolveLiveDirectory(db, live, 7)).toBe(live)
  })

  it('rebases a stale directory via repoId', () => {
    const stale = path.join('C:', 'old-root', 'ws', 'repos', 'proj')
    const db = mockDb([repoRow(7, 'proj')])
    expect(resolveLiveDirectory(db, stale, 7)).toBe(path.join(reposDir, 'proj'))
  })

  it('rebases a stale directory via localPath suffix without repoId', () => {
    const stale = path.join('D:', 'renamed', 'repos', 'proj')
    const db = mockDb([repoRow(7, 'proj')])
    expect(resolveLiveDirectory(db, stale, null)).toBe(path.join(reposDir, 'proj'))
  })

  it('returns the stored value when nothing matches', () => {
    const unknown = path.join('D:', 'elsewhere', 'proj')
    const db = mockDb([repoRow(7, 'other')])
    expect(resolveLiveDirectory(db, unknown, 999)).toBe(unknown)
  })

  it('falls back to workspace when empty', () => {
    const db = mockDb([repoRow(7, 'proj')])
    expect(resolveLiveDirectory(db, null, null)).toBe(base)
  })

  it('resolveRepoId still matches the rebased directory', () => {
    const db = mockDb([repoRow(7, 'proj')])
    expect(resolveRepoId(db, path.join(reposDir, 'proj'))).toBe(7)
  })
})
