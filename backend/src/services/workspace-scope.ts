import type { Database } from 'bun:sqlite'
import { getSessionRepo } from '../db/session-repo-queries'
import { getRepoById } from '../db/queries'
import { resolveRepoId } from './command-runs'

export const WORKSPACE_SCOPE_OPEN = '<workspace-scope>'

// 세션별 repoRoot 캐시 (매핑은 불변이라 세션 수명 내내 유효, 상한 500).
const repoRootCache = new Map<string, string | null>()
const REPO_ROOT_CACHE_MAX = 500

function remember(sessionId: string, root: string | null): string | null {
  repoRootCache.set(sessionId, root)
  if (repoRootCache.size > REPO_ROOT_CACHE_MAX) {
    const oldest = repoRootCache.keys().next().value as string | undefined
    if (oldest !== undefined) repoRootCache.delete(oldest)
  }
  return root
}

/** 세션의 repoRoot(workspaceRel, 예: 'repoA')를 구한다. 모르면 null. */
export function resolveSessionRepoRoot(
  db: Database | null,
  sessionId: string | undefined,
  directory: string | undefined,
): string | null {
  if (!sessionId) return null
  if (repoRootCache.has(sessionId)) return repoRootCache.get(sessionId) ?? null
  if (!db) return remember(sessionId, null)
  try {
    // 1) S1 정본 매핑이 최우선
    const mapped = getSessionRepo(db, sessionId)
    if (mapped != null) {
      const root = getRepoById(db, mapped)?.workspaceRel ?? null
      if (root) return remember(sessionId, root)
    }
    // 2) directory 역산 (S2 이전 세션·매핑 누락 대비)
    if (directory) {
      const repoId = resolveRepoId(db, directory)
      if (repoId != null) {
        const root = getRepoById(db, repoId)?.workspaceRel ?? null
        if (root) return remember(sessionId, root)
      }
    }
  } catch {}
  return remember(sessionId, null)
}

/**
 * S3: 프롬프트 선두에 붙는 workspace 규약 블록.
 * 비어 있으면(레포 미확인) '' — 원문 그대로 보낸다.
 */
export function buildWorkspaceScopeBlock(
  db: Database | null,
  sessionId: string | undefined,
  directory: string | undefined,
): string {
  const root = resolveSessionRepoRoot(db, sessionId, directory)
  if (!root) return ''
  return (
    `${WORKSPACE_SCOPE_OPEN}\n` +
    `CWD is the workspace root. Current session repository: ${root}.\n` +
    `Scope all file operations to ${root}/ unless explicitly instructed otherwise.\n` +
    `</workspace-scope>\n\n`
  )
}
