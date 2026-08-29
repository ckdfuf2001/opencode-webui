import { createOpenCodeClient } from '@/api/opencode'
import { listPermissionRules } from '@/api/permission-rules'
import { listRepos } from '@/api/repos'
import { OPENCODE_API_ENDPOINT } from '@/config'
import { permissionEvents } from './usePermissionRequests'
import type { Permission, PermissionRule } from '@/api/types'

const client = createOpenCodeClient(OPENCODE_API_ENDPOINT)

let started = false
let repoByDirectory = new Map<string, number>()
let rulesByRepo = new Map<number, PermissionRule[]>()
const recentlyProcessed = new Set<string>()

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split('**')
    .map(segment => segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*')
  return new RegExp(`^${escaped}$`)
}

function getCandidatePatterns(permission: Permission): string[] {
  const patterns = permission.patterns ?? permission.pattern
  const normalized = Array.isArray(patterns) ? patterns : patterns ? [patterns] : []
  const metadataValue = permission.metadata?.command ?? permission.metadata?.path ?? permission.metadata?.url
  const metadataPatterns = typeof metadataValue === 'string' ? [metadataValue] : []
  return [...normalized, ...metadataPatterns]
}

function ruleMatches(rule: PermissionRule, permission: Permission): boolean {
  const type = permission.permission ?? permission.type
  if (rule.permission !== '*' && rule.permission !== type) return false
  const regex = globToRegex(rule.pattern)
  return getCandidatePatterns(permission).some(candidate => candidate && regex.test(candidate))
}

async function refreshData(): Promise<void> {
  try {
    const [repos, rules] = await Promise.all([listRepos(), listPermissionRules()])
    const nextRepos = new Map<string, number>()
    for (const repo of repos) {
      if (repo.fullPath) {
        nextRepos.set(repo.fullPath, repo.id)
      }
    }
    const nextRules = new Map<number, PermissionRule[]>()
    for (const rule of rules) {
      const list = nextRules.get(rule.repoId) ?? []
      list.push(rule)
      nextRules.set(rule.repoId, list)
    }
    repoByDirectory = nextRepos
    rulesByRepo = nextRules
  } catch (error) {
    console.error('Failed to load permission rules for auto-approve:', error)
  }
}

async function handlePermissionAdd(permission: Permission): Promise<void> {
  if (recentlyProcessed.has(permission.id)) return

  // directory 정규화: 윈도우 백슬래시, 트레일링 슬래시, 대소문자 무시
  const normalizeDir = (d: string) => d.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  let candidateRules: PermissionRule[] | undefined
  if (permission.directory) {
    const normalized = normalizeDir(permission.directory)
    let repoId: number | undefined
    for (const [dir, id] of repoByDirectory.entries()) {
      if (normalizeDir(dir) === normalized) {
        repoId = id
        break
      }
    }
    if (repoId) candidateRules = rulesByRepo.get(repoId)
  }
  // directory가 없거나 매칭 실패 시(재기동 후 세션-디렉토리 매핑 유실 등) 전체 룰에서 매칭 시도
  if (!candidateRules || candidateRules.length === 0) {
    const all = Array.from(rulesByRepo.values()).flat()
    if (all.length === 0) return
    candidateRules = all
  }
  if (!candidateRules.some(rule => ruleMatches(rule, permission))) return

  recentlyProcessed.add(permission.id)
  setTimeout(() => {
    recentlyProcessed.delete(permission.id)
  }, 60_000)

  try {
    if (permission.v2) {
      await client.respondToPermissionV2(permission.id, 'always')
    } else {
      await client.respondToPermission(permission.sessionID, permission.id, 'always')
    }
    permissionEvents.emit({ type: 'remove', permissionID: permission.id })
  } catch (error) {
    recentlyProcessed.delete(permission.id)
    console.error('Failed to auto-approve permission:', error)
  }
}

export function refreshAutoApproveData(): void {
  void refreshData()
}

export function startAutoApprover(): void {
  if (started) return
  started = true
  refreshAutoApproveData()
  setInterval(refreshAutoApproveData, 60_000)
  permissionEvents.subscribe((event) => {
    if (event.type === 'add' && event.permission) {
      void handlePermissionAdd(event.permission)
    }
  })
}
