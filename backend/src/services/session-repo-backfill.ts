import type { Database } from 'bun:sqlite'
import path from 'node:path'
import { getReposPath } from '@opencode-webui/shared'
import { listRepos } from '../db/queries'
import { setSessionRepoIfAbsent } from '../db/session-repo-queries'
import { listSessionDirectories } from './command-runs'
import { opencodeServerManager } from './opencode-single-server'
import { ensureServerAuth } from './opencode-auth'
import { logger } from '../utils/logger'

const DIR_TIMEOUT_MS = 10_000

/**
 * S1 백필: 기존 세션의 소속 레포를 현재 directory(아직 레포별인 시점 값)로
 * 역산해 session_repo_map에 1회 기록한다. S2(workspace cwd) 이전에 돌려야
 * 역산이 유효하다. 전부 best-effort — 실패해도 부팅을 막지 않는다.
 */
export async function backfillSessionRepoMap(db: Database): Promise<number> {
  let recorded = 0
  let repos: ReturnType<typeof listRepos>
  try {
    repos = listRepos(db)
  } catch (e) {
    logger.debug('session-repo backfill skipped (repos unreadable):', e)
    return 0
  }
  if (repos.length === 0) return 0
  const base = opencodeServerManager.getUrl()
  for (const repo of repos) {
    let dirs: string[]
    try {
      const currentDir = path.resolve(getReposPath(), path.basename(repo.localPath))
      dirs = listSessionDirectories(db, repo.id, currentDir)
    } catch {
      continue
    }
    for (const dir of dirs) {
      let list: Array<{ id?: string }>
      try {
        const res = await fetch(`${base}/session?directory=${encodeURIComponent(dir)}`, {
          headers: ensureServerAuth({}),
          signal: AbortSignal.timeout(DIR_TIMEOUT_MS),
        })
        if (!res.ok) continue
        const parsed = (await res.json().catch(() => null)) as Array<{ id?: string }> | null
        if (!Array.isArray(parsed)) continue
        list = parsed
      } catch {
        continue
      }
      for (const s of list) {
        if (!s?.id) continue
        try {
          if (setSessionRepoIfAbsent(db, s.id, repo.id)) recorded++
        } catch {}
      }
    }
  }
  if (recorded > 0) logger.info(`session-repo backfill: recorded ${recorded} session(s)`)
  return recorded
}
