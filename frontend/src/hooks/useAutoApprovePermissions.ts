import { createOpenCodeClient } from '@/api/opencode'
import { OPENCODE_API_ENDPOINT } from '@/config'
import { permissionEvents } from './usePermissionRequests'
import type { Permission, PermissionRule } from '@/api/types'
import { getSessionPermissionRules } from '@/lib/notifications'

const client = createOpenCodeClient(OPENCODE_API_ENDPOINT)

let started = false
const recentlyProcessed = new Set<string>()

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split('**')
    .map(segment =>
      segment
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]'),
    )
    .join('.*')
  return new RegExp(`^${escaped}$`)
}

/** 매칭용 정규화: 역슬래시→슬래시, \\?\ 제거, 후행 슬래시 제거(루트 제외) */
function normalizeMatchValue(value: string): string {
  let s = value.replace(/\\/g, '/')
  s = s.replace(/^\/\/\?\//, '')
  while (s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s)) {
    s = s.slice(0, -1)
  }
  return s
}

function isPathLike(value: string): boolean {
  return value.includes('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)
}

// v0.12.0: v1 ↔ v2 액션명 매핑. 룰은 v1 명칭(bash/task)으로 저장하고,
// 매칭 시점에 v1 canonical로 정규화한다.
const V2_TO_V1_ACTION: Record<string, string> = {
  shell: 'bash',
  subagent: 'task',
}

function getActionName(permission: Permission): string | undefined {
  const raw = (permission as unknown as { action?: unknown }).action
  if (typeof raw === 'string' && raw) return raw
  return permission.permission ?? permission.type
}

function normalizeActionName(action: string | undefined): string | undefined {
  if (!action) return action
  const lower = action.toLowerCase()
  return V2_TO_V1_ACTION[lower] ?? action
}

function getActualPatterns(permission: Permission): string[] {
  const patterns = permission.patterns ?? permission.pattern
  const normalized = Array.isArray(patterns) ? patterns : patterns ? [patterns] : []
  const metadata = (permission.metadata ?? {}) as Record<string, unknown>
  const asString = (v: unknown): string[] => (typeof v === 'string' && v ? [v] : [])
  // opencode는 permission마다 다른 키를 쓴다:
  // bash=command, read/edit=path, webfetch=url,
  // external_directory=metadata.filepath/parentDir (+directories 배열형도 옴)
  const asArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []
  const raw = permission as unknown as { resources?: unknown }
  const metadataPatterns = [
    ...asString(metadata.command),
    ...asString(metadata.path),
    ...asString(metadata.url),
    ...asString(metadata.filepath),
    ...asString(metadata.parentDir),
    ...asString(metadata.directory),
    ...asArray(metadata.directories),
    // v2: 요청 리소스가 최상위 resources[]에 온다
    ...asArray(raw.resources),
  ]
  return [...normalized, ...metadataPatterns]
}

function getCandidatePatterns(permission: Permission): string[] {
  const actual = getActualPatterns(permission)
  if (actual.length > 0) return actual
  // thin ask 방어: 실제 경로 없이 제안(always)만 온 경우 예전처럼 제안으로 판정한다.
  // 실제 요청이 있을 때는 제안을 보지 않는다(허위 제안 과승인 방지).
  // NOTE: permission.always는 다음 턴용 제안이라 최후 수단으로만 쓴다.
  // 하위 경로 prefix 허용은 ruleMatches가 유지한다.
  if (Array.isArray(permission.always)) {
    const suggested = permission.always.filter((p): p is string => typeof p === 'string' && !!p)
    if (suggested.length > 0) return suggested
  }
  return []
}

function ruleMatches(rule: PermissionRule, permission: Permission): boolean {
  const type = normalizeActionName(getActionName(permission))
  const ruleType = normalizeActionName(rule.permission)
  if (ruleType !== '*' && ruleType !== type) return false
  const regex = globToRegex(rule.pattern)
  return getCandidatePatterns(permission).some(candidate => {
    if (!candidate) return false
    if (regex.test(candidate)) return true
    // 하위 경로까지 허용: 룰이 prefix인 경우
    // 예: 룰 "/tmp/foo" → "/tmp/foo/bar" 허용, 룰 "npm run" → "npm run build" 허용
    if (rule.pattern === '*') return true
    // 경로형이면 대소문자 무시(Windows), 아니면 기존처럼 엄격 비교
    const pathLike = isPathLike(rule.pattern) || isPathLike(candidate)
    let normCandidate = normalizeMatchValue(candidate)
    let normRule = normalizeMatchValue(rule.pattern)
    if (pathLike) {
      normCandidate = normCandidate.toLowerCase()
      normRule = normRule.toLowerCase()
    }
    // 슬래시 정규화 후 glob 재검사 (룰 '/'형 vs 후보 '\'형 엇갈림 해소)
    if (normRule !== rule.pattern && globToRegex(normRule).test(normCandidate)) return true
    if (normCandidate === normRule) return true
    if (normCandidate.startsWith(normRule + '/')) return true
    if (normCandidate.startsWith(normRule + ' ')) return true
    // 후행 스타 베이스: 'C:/work/*', 'git status *' → 베이스 prefix.
    // (' *'는 인자 없는 명령도 매칭 — opencode와 동일)
    const starBase = normRule.match(/^(.*?)[/ ]\*+$/)?.[1].replace(/\/+$/, '')
    if (starBase) {
      if (normCandidate === starBase) return true
      if (normCandidate.startsWith(starBase + '/')) return true
      if (normCandidate.startsWith(starBase + ' ')) return true
    }
    return false
  })
}

/** 제안 패턴이 전부 매칭 룰 커버리지 안인지 (백엔드 suggestionsWithinRules와 동일 규칙). */
function suggestionsWithinRules(rules: PermissionRule[], permission: Permission): boolean {
  const raw = (permission as unknown as { always?: unknown }).always
  const suggested = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string' && !!p) : []
  if (suggested.length === 0) return false
  return suggested.every(s =>
    rules.some(rule =>
      ruleMatches(rule as unknown as PermissionRule, {
        ...permission,
        pattern: undefined,
        patterns: [s],
        metadata: {},
        always: undefined,
      } as unknown as Permission),
    ),
  )
}

async function handlePermissionAdd(permission: Permission): Promise<void> {
  if (recentlyProcessed.has(permission.id)) return

  // 세션 로컬 룰 우선 확인 (로컬스토리지) — 매칭될 때만 승인, 나머지는 백엔드가 담당
  if (permission.sessionID) {
    const sessRules = getSessionPermissionRules(permission.sessionID) as unknown as PermissionRule[]
    if (sessRules.length > 0 && sessRules.some(rule => ruleMatches(rule as unknown as PermissionRule, permission))) {
      recentlyProcessed.add(permission.id)
      setTimeout(() => { recentlyProcessed.delete(permission.id) }, 60_000)
      try {
        // v0.12.1: 제안⊆룰이면 'always' 영속, 아니면 'once' (백엔드와 동일)
        const useAlways = suggestionsWithinRules(sessRules, permission)
        const reply = useAlways ? 'always' : 'once'
        if (permission.v2) {
          await client.respondToPermissionV2(permission.id, reply)
        } else {
          await client.respondToPermission(permission.sessionID, permission.id, reply)
        }
        // sessionID 동봉 — 배지 캐시 즉시 정리용 (아래 remove 구독자가 사용)
        permissionEvents.emit({ type: 'remove', permissionID: permission.id, permission })
      } catch (error) {
        recentlyProcessed.delete(permission.id)
        console.error('Failed to auto-approve permission (session):', error)
      }
      return
    }
  }

  // 레포/전역 룰은 백엔드 자동승인자가 담당한다 (탭 무관·단일 처리).
  // 프론트는 세션 로컬(localStorage) 룰만 본다 — 백엔드가 볼 수 없는 값이다.
  return
}

export function isPermissionAutoApprovable(permission: Permission): boolean {
  // 세션 로컬 룰만 본다. 레포/전역 룰은 백엔드 자동승인자가 처리한다.
  if (!permission.sessionID) return false
  const sessRules = getSessionPermissionRules(permission.sessionID) as unknown as PermissionRule[]
  return sessRules.length > 0 && sessRules.some(rule => ruleMatches(rule as unknown as PermissionRule, permission))
}

export function startAutoApprover(): void {
  if (started) return
  started = true
  permissionEvents.subscribe((event) => {
    if (event.type === 'add' && event.permission) {
      void handlePermissionAdd(event.permission)
    }
  })
}
