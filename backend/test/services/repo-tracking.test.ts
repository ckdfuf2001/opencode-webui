import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import {
  sanitizeTrackPath,
  buildManagedExcludeBlock,
  stripManagedExcludeBlock,
  applyRepoTracking,
} from '../../src/services/repo-tracking'
import { executeCommand } from '../../src/utils/process'

describe('repo-tracking', () => {
  let repoPath: string

  beforeEach(() => {
    repoPath = mkdtempSync(path.join(tmpdir(), 'repo-tracking-'))
  })

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true })
  })

  describe('sanitizeTrackPath', () => {
    it('normalizes backslashes and surrounding slashes', () => {
      expect(sanitizeTrackPath(' \\.opencode\\')).toBe('.opencode')
    })

    it('rejects empty and drive-absolute paths', () => {
      expect(sanitizeTrackPath('   ')).toBeNull()
      expect(sanitizeTrackPath('C:\\tmp')).toBeNull()
    })

    it('normalizes a leading slash to repo-relative', () => {
      expect(sanitizeTrackPath('/.opencode')).toBe('.opencode')
    })

    it('rejects traversal segments', () => {
      expect(sanitizeTrackPath('../escape')).toBeNull()
      expect(sanitizeTrackPath('a/./b/../c')).toBeNull()
    })

    it('rejects git metacharacters and .git itself', () => {
      expect(sanitizeTrackPath('my path')).toBeNull()
      expect(sanitizeTrackPath('a[0]')).toBeNull()
      expect(sanitizeTrackPath('.git')).toBeNull()
    })
  })

  describe('buildManagedExcludeBlock', () => {
    it('whitelists only tracked paths', () => {
      const block = buildManagedExcludeBlock(['.opencode', 'docs'])
      expect(block).toContain('/*')
      expect(block).toContain('!/.opencode')
      expect(block).toContain('!/docs')
    })
  })

  describe('stripManagedExcludeBlock', () => {
    it('removes the managed block while preserving user content', () => {
      const existing = '# my rules\n*.log\n'
      const content = existing + buildManagedExcludeBlock(['.opencode'])
      expect(stripManagedExcludeBlock(content)).toBe(existing.trimEnd())
    })

    it('returns content unchanged when no block is present', () => {
      expect(stripManagedExcludeBlock('# user\n*.log\n')).toBe('# user\n*.log\n')
    })
  })

  describe('applyRepoTracking', () => {
    it('writes the managed block into .git/info/exclude', async () => {
      await executeCommand(['git', 'init'], repoPath)

      const applied = await applyRepoTracking(repoPath, ['.opencode'])
      expect(applied).toBe(true)

      const gitDir = (await executeCommand(
        ['git', '-C', repoPath, 'rev-parse', '--absolute-git-dir'],
        { silent: true }
      )).trim()
      const exclude = await readFile(path.join(gitDir, 'info', 'exclude'), 'utf8')

      expect(exclude).toContain('/*')
      expect(exclude).toContain('!/.opencode')
    })

    it('limits change detection to the tracked paths', async () => {
      await executeCommand(['git', 'init'], repoPath)
      await applyRepoTracking(repoPath, ['.opencode'])

      const { writeFile, mkdir } = await import('fs/promises')
      await mkdir(path.join(repoPath, '.opencode', 'commands'), { recursive: true })
      await writeFile(path.join(repoPath, '.opencode', 'commands', 'hello.md'), '# hi')
      await writeFile(path.join(repoPath, 'README.md'), 'ignored')

      const status = await executeCommand(
        ['git', '-C', repoPath, 'status', '--porcelain=v1', '-uall'],
        { silent: true }
      )
      const entries = status.split('\n').filter(Boolean)

      expect(entries).toHaveLength(1)
      expect(entries[0]).toContain('.opencode/commands/hello.md')
    })

    it('replaces an existing managed block without duplicating user rules', async () => {
      await executeCommand(['git', 'init'], repoPath)
      await applyRepoTracking(repoPath, ['.opencode'])
      await applyRepoTracking(repoPath, ['.opencode', 'chat_uploads'])

      const gitDir = (await executeCommand(
        ['git', '-C', repoPath, 'rev-parse', '--absolute-git-dir'],
        { silent: true }
      )).trim()
      const exclude = await readFile(path.join(gitDir, 'info', 'exclude'), 'utf8')

      expect(exclude.match(/# --- opencode-webui repo tracking \(managed\) ---/g)).toHaveLength(1)
      expect(exclude).toContain('!/.opencode')
      expect(exclude).toContain('!/chat_uploads')
    })

    it('clears tracking when the path list is empty', async () => {
      await executeCommand(['git', 'init'], repoPath)
      await applyRepoTracking(repoPath, ['.opencode'])

      const cleared = await applyRepoTracking(repoPath, [])
      expect(cleared).toBe(true)

      const gitDir = (await executeCommand(
        ['git', '-C', repoPath, 'rev-parse', '--absolute-git-dir'],
        { silent: true }
      )).trim()
      const exclude = await readFile(path.join(gitDir, 'info', 'exclude'), 'utf8')
      expect(exclude).not.toContain('/*')
      expect(exclude).not.toContain('!/')
    })

    it('fails gracefully outside a git repository', async () => {
      const plainDir = mkdtempSync(path.join(tmpdir(), 'repo-tracking-plain-'))
      try {
        const applied = await applyRepoTracking(plainDir, ['.opencode'])
        expect(applied).toBe(false)
        expect(existsSync(path.join(plainDir, '.git'))).toBe(false)
      } finally {
        rmSync(plainDir, { recursive: true, force: true })
      }
    })
  })
})
