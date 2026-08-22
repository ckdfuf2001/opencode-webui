import { mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import type { Database } from 'bun:sqlite'
import { listRepos } from '../db/queries'
import { getReposPath } from '@opencode-webui/shared'
import { SettingsService } from './settings'
import { executeCommand } from '../utils/process'
import { logger } from '../utils/logger'

const BEGIN_MARKER = '# --- opencode-webui repo tracking (managed) ---'
const END_MARKER = '# --- end opencode-webui repo tracking ---'

export function sanitizeTrackPath(entry: string): string | null {
  const cleaned = entry.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!cleaned || path.isAbsolute(cleaned)) return null
  const segments = cleaned.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  if (/[\s[\]*?!]/.test(cleaned)) return null
  if (cleaned.toLowerCase() === '.git') return null
  return cleaned
}

export function buildManagedExcludeBlock(trackPaths: string[]): string {
  const lines = ['/*', ...trackPaths.map((p) => `!/${p}`)]
  return [BEGIN_MARKER, ...lines, END_MARKER, ''].join('\n')
}

export function stripManagedExcludeBlock(content: string): string {
  const begin = content.indexOf(BEGIN_MARKER)
  if (begin === -1) return content
  const end = content.indexOf(END_MARKER, begin)
  if (end === -1) return content.slice(0, begin)
  const remainder = content.slice(end + END_MARKER.length)
  return `${content.slice(0, begin)}${remainder}`.replace(/\s+$/, '')
}

async function resolveGitDir(fullPath: string): Promise<string | null> {
  try {
    const output = await executeCommand(
      ['git', '-C', fullPath, 'rev-parse', '--absolute-git-dir'],
      { silent: true }
    )
    const gitDir = output.trim()
    return gitDir || null
  } catch {
    return null
  }
}

export async function applyRepoTracking(fullPath: string, trackPaths: string[]): Promise<boolean> {
  const sanitized = trackPaths
    .map(sanitizeTrackPath)
    .filter((entry): entry is string => entry !== null)

  const gitDir = await resolveGitDir(fullPath)
  if (!gitDir) {
    logger.warn(`Repo tracking skipped (not a git repository): ${fullPath}`)
    return false
  }

  const excludePath = path.join(gitDir, 'info', 'exclude')
  let existing = ''
  try {
    existing = await readFile(excludePath, 'utf8')
  } catch {
    existing = ''
  }

  const base = stripManagedExcludeBlock(existing).replace(/\s+$/, '')
  const next =
    sanitized.length === 0
      ? base ? `${base}\n` : ''
      : `${base ? `${base}\n\n` : ''}${buildManagedExcludeBlock(sanitized)}`

  await mkdir(path.dirname(excludePath), { recursive: true })
  await writeFile(excludePath, next, 'utf8')
  logger.info(`Repo tracking updated for ${fullPath}: [${sanitized.join(', ')}]`)
  return true
}

export async function applyRepoTrackingForAllRepos(db: Database): Promise<number> {
  const { preferences } = new SettingsService(db).getSettings()
  const trackPaths = preferences.repoTrackPaths ?? []
  const repos = listRepos(db)

  let applied = 0
  for (const repo of repos) {
    const fullPath = path.resolve(getReposPath(), repo.localPath)
    try {
      if (await applyRepoTracking(fullPath, trackPaths)) applied++
    } catch (error) {
      logger.warn(`Failed to apply repo tracking to ${repo.localPath}:`, error)
    }
  }
  return applied
}
