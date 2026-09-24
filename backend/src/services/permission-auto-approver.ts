import type { Database } from 'bun:sqlite'
import { logger } from '../utils/logger'
import { listApplicableRules } from '../db/permission-rule-queries'
import { getSessionRepo } from '../db/session-repo-queries'
import { listRepos } from '../db/queries'
import type { PermissionRule } from '../types/permission-rule'
import { resolveRepoId } from './command-runs'
import { getWorkspacePath } from '@opencode-webui/shared'

/**
 * 서버 측 자동승인자 — opencode /event를 직접 구독해 권한 요청을 규칙대로 응답한다.
 * 프론트 폴링 방식의 문제(탭 닫힘·중복 탭·2초 지연·60초 규칙 lag)를 없앤다.
 *
 * 설계 원칙 (v0.12.1: webui 단일 소유 + 퍼레이드 방지):
 * - 판단은 여기서, 표시는 프론트 (다이얼로그·뱃지는 그대로 living 목록을 보여준다).
 * - 세션 로컬스토리지 룰은 백엔드가 볼 수 없어 프론트가 계속 담당한다 (빠른 경로).
 * - 응답은 제안⊆룰이면 'always', 아니면 'once'.
 *   'always'는 opencode 세션 메모리에 제안 패턴을 저장할 뿐 소유권은 webui DB가
 *   유지한다 (재시작 시 휘발 → live 승인자가 재시딩). once 일변도에서는
 *   디렉터리별 체크마다 새 ask가 떠서 등록된 경로도 계속 묻는다.
 *   60초 TTL dedupe로 중복 응답 방지.
 * - repo 스코프가 확정될 때만 승인한다. directory 해석 실패 시에는
 *   응답하지 않고 다이얼로그에 맡긴다 (다른 레포 규칙 오승인 방지).
 * - 실패해도 조용히 넘긴다 — 사용자가 다이얼로그에서 직접 처리할 수 있다.
 */

export interface AskedPermission {
  id: string
  sessionID: string
  permission?: string
  type?: string
  pattern?: string | string[]
  patterns?: string[]
  always?: string[]
  metadata?: Record<string, unknown>
  // v2 shape (opencode v2: action/resources). 있으면 v2 응답 경로를 쓴다.
  action?: string
  resources?: string[]
  v2?: boolean
}

// v1 ↔ v2 액션명 매핑. DB 룰은 v1 명칭(bash/task)으로 저장하고,
// 매칭 시점에 양쪽을 v1 canonical로 정규화한다.
const V2_TO_V1_ACTION: Record<string, string> = {
  shell: 'bash',
  subagent: 'task',
}

export function normalizeActionName(action: string | undefined): string | undefined {
  if (!action) return action
  const lower = action.toLowerCase()
  return V2_TO_V1_ACTION[lower] ?? action
}

const ASK_TYPES = new Set(['permission.asked', 'permission.updated', 'permission.v2.asked'])

// 응답済み dedupe (60초 TTL, 상한 500 — 탭 중복이 아니라 프로세스 단일이라 충분)
const respondedRecently = new Map<string, number>()
const RESPONDED_TTL_MS = 60_000
const RESPONDED_MAX = 500

function markResponded(id: string): void {
  // wasResponded가 TTL 만료를 검사하므로 별도 타이머 정리 불필요
  respondedRecently.set(id, Date.now())
  if (respondedRecently.size > RESPONDED_MAX) {
    const oldest = respondedRecently.keys().next().value as string | undefined
    if (oldest !== undefined) respondedRecently.delete(oldest)
  }
}

function wasResponded(id: string): boolean {
  const at = respondedRecently.get(id)
  if (!at) return false
  if (Date.now() - at > RESPONDED_TTL_MS) {
    respondedRecently.delete(id)
    return false
  }
  return true
}

/** 응답 실패 시 dedupe를 풀어 다음 이벤트에서 재시도할 수 있게 한다. */
function unmarkResponded(id: string): void {
  respondedRecently.delete(id)
}

export function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split('**')
    .map((segment) =>
      segment
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]'),
    )
    .join('.*')
  return new RegExp(`^${escaped}$`)
}

/** 매칭용 정규화: 역슬래시→슬래시, \\?\ 제거, 후행 슬래시 제거(루트 제외) */
export function normalizeMatchValue(value: string): string {
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

function getActualPatterns(permission: AskedPermission): string[] {
  const patterns = permission.patterns ?? permission.pattern
  const normalized = Array.isArray(patterns) ? patterns : patterns ? [patterns] : []
  const metadata = (permission.metadata ?? {}) as Record<string, unknown>
  const asString = (v: unknown): string[] => (typeof v === 'string' && v ? [v] : [])
  // opencode는 permission마다 다른 키를 쓴다:
  // bash=command, read/edit=path, webfetch=url,
  // external_directory=metadata.filepath/parentDir (+directories 배열형도 옴)
  const asArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []
  const metadataPatterns = [
    ...asString(metadata.command),
    ...asString(metadata.path),
    ...asString(metadata.url),
    ...asString(metadata.filepath),
    ...asString(metadata.parentDir),
    ...asString(metadata.directory),
    ...asArray(metadata.directories),
    // v2: 요청 리소스가 최상위 resources[]에 온다
    ...asArray(permission.resources),
  ]
  return [...normalized, ...metadataPatterns]
}

function getCandidatePatterns(permission: AskedPermission): string[] {
  const actual = getActualPatterns(permission)
  if (actual.length > 0) return actual
  // thin ask 방어: 실제 경로 없이 제안(always)만 온 경우 예전처럼 제안으로 판정한다.
  // 실제 요청이 있을 때는 제안을 보지 않는다(허위 제안 과승인 방지).
  // NOTE: 제안 단독 매칭은 최후 수단 — 로그에 남겨 추적한다.
  if (Array.isArray(permission.always)) {
    const suggested = permission.always.filter((p): p is string => typeof p === 'string' && !!p)
    if (suggested.length > 0) {
      logger.debug(`Auto-approve using always-suggestions (no actual patterns): ${permission.id}`)
      return suggested
    }
  }
  return []
  // 하위 경로 prefix 허용(룰 "/tmp/foo" → "/tmp/foo/bar")은 ruleMatches가 유지한다.
}

/**
 * 제안 패턴이 전부 매칭 룰 커버리지 안에 있는지.
 * opencode의 'always'는 제안 패턴을 세션 메모리에 저장하므로, 제안이 룰보다
 * 넓으면 과승인이 영속된다. 커버리지 안일 때만 always, 아니면 once.
 * actual 없이 제안만 온 thin ask는 getCandidatePatterns가 제안을 쓰므로
 * 여기서도 동일하게 제안으로 판정한다 (단독 판정 금지 원칙과 충돌 없음 —
 * 호출자는 이미 ruleMatches 통과분을 대상으로 한다).
 */
export function suggestionsWithinRules(rules: PermissionRule[], permission: AskedPermission): boolean {
  const suggested = Array.isArray(permission.always)
    ? permission.always.filter((p): p is string => typeof p === 'string' && !!p)
    : []
  if (suggested.length === 0) return false
  return suggested.every((s) =>
    rules.some((rule) =>
      ruleMatches(rule, {
        ...permission,
        pattern: undefined,
        patterns: [s],
        metadata: undefined,
        always: undefined,
      }),
    ),
  )
}

export function ruleMatches(rule: PermissionRule, permission: AskedPermission): boolean {
  // v1(shell→bash, subagent→task) 명칭 차이를 흡수한다. 룰은 v1 명칭으로 저장.
  const type = normalizeActionName(permission.action ?? permission.permission ?? permission.type)
  const ruleType = normalizeActionName(rule.permission)
  if (ruleType !== '*' && ruleType !== type) return false
  const regex = globToRegex(rule.pattern)
  return getCandidatePatterns(permission).some((candidate) => {
    if (!candidate) return false
    if (regex.test(candidate)) return true
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
    if (normCandidate.startsWith(`${normRule}/`)) return true
    if (normCandidate.startsWith(`${normRule} `)) return true
    // 후행 스타 베이스: 'C:/work/*', 'git status *' → 베이스 prefix.
    // (' *'는 인자 없는 명령도 매칭 — opencode와 동일)
    const starBase = normRule.match(/^(.*?)[/ ]\*+$/)?.[1]?.replace(/\/+$/, '')
    if (starBase) {
      if (normCandidate === starBase) return true
      if (normCandidate.startsWith(`${starBase}/`)) return true
      if (normCandidate.startsWith(`${starBase} `)) return true
    }
    return false
  })
}

function normalizePermission(raw: unknown): AskedPermission | null {
  const r = raw as {
    id?: unknown
    sessionID?: unknown
    permission?: unknown
    type?: unknown
    pattern?: unknown
    patterns?: unknown
    always?: unknown
    metadata?: unknown
    action?: unknown
    resources?: unknown
  }
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.sessionID !== 'string' || !r.sessionID) return null
  const rawPatterns = r.patterns ?? r.pattern
  const patterns = Array.isArray(rawPatterns)
    ? rawPatterns.filter((p): p is string => typeof p === 'string')
    : typeof rawPatterns === 'string'
      ? [rawPatterns]
      : undefined
  const always = Array.isArray(r.always)
    ? r.always.filter((p): p is string => typeof p === 'string')
    : undefined
  // v2 shape: { action, resources[] }. 필드 유무로 판정한다 (이벤트명과 무관하게).
  const action = typeof r.action === 'string' ? r.action : undefined
  const resources = Array.isArray(r.resources)
    ? r.resources.filter((p): p is string => typeof p === 'string')
    : undefined
  return {
    id: r.id,
    sessionID: r.sessionID,
    permission: typeof r.permission === 'string' ? r.permission : undefined,
    type: typeof r.type === 'string' ? r.type : undefined,
    pattern: typeof r.pattern === 'string' ? r.pattern : undefined,
    patterns,
    always,
    metadata:
      r.metadata && typeof r.metadata === 'object'
        ? (r.metadata as Record<string, unknown>)
        : undefined,
    action,
    resources,
    v2: action !== undefined && resources !== undefined ? true : undefined,
  }
}

// 세션 디렉터리는 바뀌지 않으므로 캐시한다 (권한마다 세션 조회 1회가 붙던 문제 해소).
// 실패(undefined)는 캐시하지 않는다 — 일시 장애가 영구 미승인으로 굳는 것을 막는다.
const sessionDirectoryCache = new Map<string, string>()
const SESSION_DIR_CACHE_MAX = 1000
// 진행 중인 조회 공유 — 같은 세션의 동시 권한이 각자 HTTP를 쏘지 않게 한다
const sessionDirectoryInflight = new Map<string, Promise<string | undefined>>()

async function getSessionDirectoryCached(
  sessionID: string,
  resolveBase: () => Promise<string>,
): Promise<string | undefined> {
  const cached = sessionDirectoryCache.get(sessionID)
  if (cached !== undefined) return cached
  const inflight = sessionDirectoryInflight.get(sessionID)
  if (inflight) return inflight
  const pending = fetchSessionDirectory(sessionID, resolveBase)
    .then((directory) => {
      if (directory) {
        sessionDirectoryCache.set(sessionID, directory)
        if (sessionDirectoryCache.size > SESSION_DIR_CACHE_MAX) {
          const oldest = sessionDirectoryCache.keys().next().value as string | undefined
          if (oldest !== undefined) sessionDirectoryCache.delete(oldest)
        }
      }
      return directory
    })
    .finally(() => {
      if (sessionDirectoryInflight.get(sessionID) === pending) {
        sessionDirectoryInflight.delete(sessionID)
      }
    })
  sessionDirectoryInflight.set(sessionID, pending)
  return pending
}

type BaseUrlResolver = () => string

async function defaultBaseUrl(): Promise<string> {
  const { opencodeServerManager } = await import('./opencode-single-server')
  return opencodeServerManager.getUrl()
}

async function fetchSessionDirectory(
  sessionID: string,
  resolveBase: () => Promise<string>,
): Promise<string | undefined> {
  const { ensureServerAuth } = await import('./opencode-auth')
  const base = await resolveBase()
  const res = await fetch(`${base}/session/${encodeURIComponent(sessionID)}`, {
    headers: ensureServerAuth({}),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) return undefined
  const info = (await res.json()) as { directory?: string }
  return typeof info?.directory === 'string' && info.directory ? info.directory : undefined
}

async function replyPermission(
  sessionID: string,
  permissionID: string,
  isV2: boolean,
  resolveBase: () => Promise<string>,
  reply: 'once' | 'always' = 'once',
  directory?: string,
): Promise<void> {
  const { ensureServerAuth } = await import('./opencode-auth')
  const base = await resolveBase()
  const headers = ensureServerAuth({ 'Content-Type': 'application/json' })
  const dirQuery = directory ? `?directory=${encodeURIComponent(directory)}` : ''
  // 'always'는 opencode 세션 메모리에 제안 패턴을 저장한다 (재시작 시 휘발 —
  // 소유권은 webui DB가 유지하고 live 승인자가 재시딩한다).
  if (isV2) {
    const res = await fetch(`${base}/permission/${encodeURIComponent(permissionID)}/reply${dirQuery}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reply }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`v2 reply HTTP ${res.status}`)
    return
  }
  const res = await fetch(
    `${base}/session/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(permissionID)}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ response: reply }),
      signal: AbortSignal.timeout(10_000),
    },
  )
  if (!res.ok) throw new Error(`v1 reply HTTP ${res.status}`)
}

async function handleAskedPermission(
  db: Database,
  raw: unknown,
  eventType: string,
  resolveBase: () => Promise<string>,
  opts?: { quiet?: boolean },
): Promise<void> {
  const permission = normalizePermission(raw)
  if (!permission) return
  if (wasResponded(permission.id)) return
  // v2 판정: 페이로드 shape 우선, 이벤트명 보조 (sweep는 v1형으로 들어오므로)
  const isV2 = permission.v2 === true || eventType === 'permission.v2.asked'
  // sweep(재조정)에서는 미승인 사유를 debug로 낮춘다 — 매 주기 info/warn이 쌓이는 것을 막는다.
  // 이벤트 경로(실시간 첫 처리)는 기존대로 info/warn을 유지한다.
  const logSkip = opts?.quiet
    ? (msg: string) => logger.debug(msg)
    : (msg: string) => logger.info(msg)
  // 진단용: 왜 승인/스킵됐는지 info에 남긴다 (ask는 사용자 다이얼로그급이라 info가 적당)
  const describe = (): string => {
    const cands = getCandidatePatterns(permission)
    const shown = cands.slice(0, 4).join(' | ').slice(0, 300)
    const alwaysHint = Array.isArray(permission.always) && permission.always.length > 0
      ? ` alwaysSuggestions=${permission.always.length}(excluded from match)`
      : ''
    return `${permission.id} type=${permission.action ?? permission.permission ?? permission.type} session=${permission.sessionID} candidates=[${shown}]${cands.length > 4 ? ` +${cands.length - 4}` : ''}${alwaysHint}`
  }
  // directory → repo 스코프가 확정될 때만 승인한다.
  // 해석 실패 시 전체 규칙 폴백은 다른 레포의 규칙으로 승인할 수 있어 금지 —
  // 이 경우 응답하지 않고 사용자 다이얼로그에 맡긴다.
  // S1 정본(session_repo_map)을 먼저 보고, 없으면 directory 역산 + session_status 순.
  let repoId: number | null = null
  let sessionDir: string | undefined
  try {
    try {
      repoId = getSessionRepo(db, permission.sessionID)
    } catch {}
    const directory = await getSessionDirectoryCached(permission.sessionID, resolveBase)
    sessionDir = directory
    if (repoId == null) {
      if (!directory) {
        logSkip(`Auto-approve skip (no session directory): ${describe()}`)
        return
      }
      repoId = resolveRepoId(db, directory)
    }
    if (repoId == null) {
      // 폴백: 폴러가 session_status에 기록한 repo_id. 디렉터리 표기 차이
      // (대소문자·심링크·이동)로 resolveRepoId가 빗나간 경우를 구한다.
      try {
        const { getSessionStatusRow } = await import('../db/session-status-queries')
        const row = getSessionStatusRow(db, permission.sessionID)
        if (row?.repoId != null) {
          repoId = row.repoId
          logSkip(`Auto-approve repo fallback via session_status (repo ${repoId}): ${describe()} dir=${directory}`)
        }
      } catch {}
    }
    if (repoId == null) {
      logSkip(`Auto-approve skip (no repo for dir): ${describe()} dir=${directory}`)
      return
    }
  } catch (e) {
    // 조회 실패는 조용히 넘기면 원인을 알 수 없으니 warn (404 등 미해석은 위에서 return)
    if (opts?.quiet) logger.debug(`Auto-approve directory resolve failed for session ${permission.sessionID}:`, e)
    else logger.warn(`Auto-approve directory resolve failed for session ${permission.sessionID}:`, e)
    return
  }
  let candidateRules: PermissionRule[]
  try {
    candidateRules = listApplicableRules(db, repoId)
  } catch (e) {
    if (opts?.quiet) logger.debug(`Auto-approve rules read failed (repo ${repoId}):`, e)
    else logger.warn(`Auto-approve rules read failed (repo ${repoId}):`, e)
    return
  }
  if (candidateRules.length === 0) {
    logSkip(`Auto-approve skip (no rules for repo ${repoId}): ${describe()}`)
    return
  }
  if (!candidateRules.some((rule) => ruleMatches(rule, permission))) {
    logSkip(`Auto-approve no-match (${candidateRules.length} repo+global rules): ${describe()}`)
    return
  }
  // 제안이 룰 커버리지 안이면 always로 영속시켜 다이얼로그 퍼레이드를 끊는다.
  // 제안이 더 넓으면 once (opencode에 과승인을 저장하지 않는다).
  // once 일변도에서는 디렉터리별 체크마다 새 ask가 떠서 등록된 경로도 계속 묻는다.
  const useAlways = suggestionsWithinRules(candidateRules, permission)
  markResponded(permission.id)
  try {
    await replyPermission(permission.sessionID, permission.id, isV2, resolveBase, useAlways ? 'always' : 'once', sessionDir)
    logger.info(`Auto-approved(${useAlways ? 'always' : 'once'}) permission ${permission.id} (${permission.action ?? permission.permission ?? permission.type}) for session ${permission.sessionID}`)
  } catch (e) {
    // 응답 실패(404/409 등)는 dedupe를 풀어 다음 이벤트에서 재시도한다.
    // 성공 전에 mark하면 실패가 영구 미승인으로 굳는다.
    unmarkResponded(permission.id)
    logger.debug(`Auto-approve reply failed for ${permission.id} (will retry on next event):`, e)
  }
}

/**
 * 재조정 sweep: SSE로 놓친 ask를 잡는다.
 * ask 생성 이벤트를 못 받으면(백엔드 재시작·단절 구간) 프론트 폴링에만 보이고
 * 자동승인이 영원히 안 돈다. 살아있는 목록을 주기로 읽어 같은 판정기로 처리한다.
 * - v2 shape 페이로드는 normalize에서 감지해 v2 응답 경로를 쓴다.
 * - 응답 성공/실패 처리는 handleAskedPermission과 동일(dedupe+재시도).
 * - 미승인 사유 로그는 quiet로 낮춰 스팸을 막는다. 승인은 info 유지.
 */
const SWEEP_INTERVAL_MS = 45_000
const SWEEP_START_DELAY_MS = 3_000
let sweepRunning = false

/**
 * 감시 디렉터리 목록: workspace 루트 + 등록 레포 fullPath.
 * opencode v1.18+는 /event·/permission을 ?directory= 스코프로 serve하므로
 * 전역 조회(GET /permission)에는 디렉터리별 ask가 안 잡힌다.
 * (프론트는 axios 인터셉터가 항상 directory를 붙여서 보였다.)
 */
export function resolveWatchDirectories(db: Database): string[] {
  const out = new Set<string>()
  try {
    const ws = getWorkspacePath()
    if (ws) out.add(ws)
  } catch (e) {
    logger.debug('Auto-approve watch workspace unreadable:', e instanceof Error ? e.message : e)
  }
  try {
    for (const repo of listRepos(db)) {
      if (repo?.fullPath) out.add(repo.fullPath)
    }
  } catch (e) {
    logger.debug('Auto-approve watch repos unreadable:', e instanceof Error ? e.message : e)
  }
  return [...out]
}

/**
 * 룰 CRUD 직후 즉시 재조정 (다음 45초 주기를 기다리지 않는다).
 * ask가 룰보다 먼저 뜬 경우 — 사용자가 다이얼로그 보고 룰을 등록하는
 * 바로 그 흐름 — 가만히 두면 최대 45초간 다이얼로그가 잔류한다.
 * 실행 중이면 주기 tick이 처리하므로 중복 실행하지 않는다.
 */
export function kickPermissionSweep(
  db: Database,
  opts?: { getBaseUrl?: BaseUrlResolver; getDirectories?: () => string[] },
): void {
  if (sweepRunning) return
  const resolveBase = async (): Promise<string> =>
    opts?.getBaseUrl ? opts.getBaseUrl() : defaultBaseUrl()
  void (async () => {
    let dirs: string[] = []
    try {
      dirs = [...new Set(((opts?.getDirectories ? opts.getDirectories() : resolveWatchDirectories(db)) ?? []).filter(Boolean))]
    } catch {}
    if (dirs.length === 0) {
      await sweepPendingPermissions(db, resolveBase)
      return
    }
    for (const directory of dirs) {
      await sweepPendingPermissions(db, resolveBase, directory)
    }
  })().catch((e) => {
    logger.debug('Auto-approve kick sweep failed:', e instanceof Error ? e.message : e)
  })
}

async function sweepPendingPermissions(
  db: Database,
  resolveBase: () => Promise<string>,
  directory?: string,
): Promise<void> {
  if (sweepRunning) return
  sweepRunning = true
  try {
    const { ensureServerAuth } = await import('./opencode-auth')
    const base = await resolveBase()
    const url = directory ? `${base}/permission?directory=${encodeURIComponent(directory)}` : `${base}/permission`
    const res = await fetch(url, {
      headers: ensureServerAuth({}),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      logger.debug(`Auto-approve sweep: permission list HTTP ${res.status}`)
      return
    }
    const list = (await res.json()) as unknown[]
    if (!Array.isArray(list) || list.length === 0) return
    let approved = 0
    for (const raw of list) {
      const r = raw as { id?: unknown; sessionID?: unknown }
      if (typeof r.id !== 'string' || !r.id || typeof r.sessionID !== 'string' || !r.sessionID) continue
      if (wasResponded(r.id)) continue
      try {
        await handleAskedPermission(db, raw, 'permission.asked', resolveBase, { quiet: true })
        approved++
      } catch (e) {
        logger.debug(`Auto-approve sweep: item ${r.id} failed:`, e instanceof Error ? e.message : e)
      }
    }
    if (approved > 0) logger.info(`Auto-approve sweep processed ${approved}/${list.length} pending permission(s)`)
  } catch (e) {
    logger.debug('Auto-approve sweep failed:', e instanceof Error ? e.message : e)
  } finally {
    sweepRunning = false
  }
}

interface SseSubscriber {
  stop: () => void
}

function parseSseFrame(block: string): { name: string; data: string } | null {
  let name = ''
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    else if (line.startsWith(':')) continue
    else if (line.trim() === '') continue
  }
  if (dataLines.length === 0) return null
  return { name, data: dataLines.join('\n') }
}

function extractEventType(name: string, data: unknown): string {
  if (name && name !== 'message') return name
  if (data && typeof data === 'object' && typeof (data as { type?: unknown }).type === 'string') {
    return (data as { type: string }).type
  }
  return ''
}

/**
 * 단일 피드 구독: 디렉터리 스코프 SSE + 해당 디렉터리 sweep.
 * directory가 없으면 전역 피드(레거시 동작 — 테스트·구버전 서버용).
 */
function startSingleFeed(
  db: Database,
  opts: { onEvent?: (type: string) => void; getBaseUrl?: BaseUrlResolver } | undefined,
  directory: string | undefined,
): SseSubscriber {
  const tag = directory ?? 'global'
  let stopped = false
  let abort: AbortController | null = null
  let lastSeen = 0
  let watchdog: ReturnType<typeof setInterval> | null = null
  // 주입된 base가 있으면 그대로 쓰고, 없으면 매니저에서 매번 해석한다 (재시작 대응)
  const resolveBase = async (): Promise<string> =>
    opts?.getBaseUrl ? opts.getBaseUrl() : defaultBaseUrl()
  const eventUrl = async (): Promise<string> => {
    const base = await resolveBase()
    return directory ? `${base}/event?directory=${encodeURIComponent(directory)}` : `${base}/event`
  }

  const pump = async (): Promise<void> => {
    while (!stopped) {
      try {
        const { ensureServerAuth } = await import('./opencode-auth')
        abort = new AbortController()
        const res = await fetch(await eventUrl(), {
          headers: { ...ensureServerAuth({}), Accept: 'text/event-stream' },
          signal: abort.signal,
        })
        if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`)
        lastSeen = Date.now()
        // (재)연결 직후 1회 sweep — 단절 구간에 생긴 ask를 즉시 잡는다 (45초 대기 제거).
        void sweepPendingPermissions(db, resolveBase, directory)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done || stopped) break
          lastSeen = Date.now()
          buf += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const frame = parseSseFrame(block)
            if (!frame) continue
            let data: unknown = null
            try {
              data = JSON.parse(frame.data)
            } catch {
              continue
            }
            const type = extractEventType(frame.name, data)
            try {
              opts?.onEvent?.(type)
            } catch {}
            if (!ASK_TYPES.has(type)) continue
            const props = (data as { properties?: unknown }).properties ?? data
            void handleAskedPermission(db, props, type, resolveBase)
          }
        }
      } catch (e) {
        if (stopped) return
        logger.debug(`Permission event stream [${tag}] dropped, reconnecting:`, e instanceof Error ? e.message : e)
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  }

  void pump()
  // 놓친 ask 재조정: 부팅 직후 1회 + 45초 주기. SSE 미수신분도 자동승인 대상이면 처리된다.
  let sweepTimer: ReturnType<typeof setInterval> | null = null
  const sweepOnce = () => {
    if (stopped) return
    void sweepPendingPermissions(db, resolveBase, directory)
  }
  const sweepStart = setTimeout(() => {
    if (stopped) return
    sweepOnce()
    sweepTimer = setInterval(sweepOnce, SWEEP_INTERVAL_MS)
    if (typeof (sweepTimer as unknown as { unref?: unknown }).unref === 'function') {
      ;(sweepTimer as unknown as { unref: () => void }).unref()
    }
  }, SWEEP_START_DELAY_MS)
  if (typeof (sweepStart as unknown as { unref?: unknown }).unref === 'function') {
    ;(sweepStart as unknown as { unref: () => void }).unref()
  }
  watchdog = setInterval(() => {
    if (stopped) return
    // 2분 무소식은 단절로 보고 재연결한다 (heartbeat 포함 어떤 프레임도 없으면)
    if (lastSeen !== 0 && Date.now() - lastSeen > 120_000) {
      logger.warn(`Permission event stream [${tag}] stale, reconnecting`)
      try {
        abort?.abort()
      } catch {}
    }
  }, 30_000)
  if (typeof (watchdog as unknown as { unref?: unknown }).unref === 'function') {
    ;(watchdog as unknown as { unref: () => void }).unref()
  }

  return {
    stop: () => {
      stopped = true
      try {
        abort?.abort()
      } catch {}
      if (watchdog) clearInterval(watchdog)
      if (sweepTimer) clearInterval(sweepTimer)
      clearTimeout(sweepStart)
    },
  }
}

/**
 * opencode /event를 직접 구독한다. fetch 기반이라 런타임에 무관하고, heartbeat 단절을 감시한다.
 * getDirectories가 있으면 디렉터리별 피드를 열고(신규 레포는 30초 supervisor가
 * 추가, 사라진 디렉터리는 정리), 없으면 전역 피드 1개(레거시 동작).
 */
export function subscribeOpencodeEvents(
  db: Database,
  opts?: { onEvent?: (type: string) => void; getBaseUrl?: BaseUrlResolver; getDirectories?: () => string[] },
): SseSubscriber {
  if (!opts?.getDirectories) return startSingleFeed(db, opts, undefined)
  const feeds = new Map<string, SseSubscriber>()
  let stopped = false
  const sync = (): void => {
    if (stopped) return
    let dirs: string[] = []
    try {
      dirs = [...new Set((opts.getDirectories?.() ?? []).filter((d): d is string => typeof d === 'string' && !!d))]
    } catch {}
    for (const directory of dirs) {
      if (!feeds.has(directory)) {
        try {
          feeds.set(directory, startSingleFeed(db, opts, directory))
        } catch {}
      }
    }
    for (const [directory, sub] of [...feeds]) {
      if (!dirs.includes(directory)) {
        try {
          sub.stop()
        } catch {}
        feeds.delete(directory)
      }
    }
  }
  sync()
  const supervisor = setInterval(sync, 30_000)
  if (typeof (supervisor as unknown as { unref?: unknown }).unref === 'function') {
    ;(supervisor as unknown as { unref: () => void }).unref()
  }
  return {
    stop: () => {
      stopped = true
      clearInterval(supervisor)
      for (const sub of feeds.values()) {
        try {
          sub.stop()
        } catch {}
      }
      feeds.clear()
    },
  }
}

let started = false
let subscriber: SseSubscriber | null = null

export function startPermissionAutoApprover(db: Database): void {
  if (started) return
  started = true
  subscriber = subscribeOpencodeEvents(db, { getDirectories: () => resolveWatchDirectories(db) })
  logger.info('Permission auto-approver subscribed to opencode events')
}

export function stopPermissionAutoApprover(): void {
  started = false
  try {
    subscriber?.stop()
  } catch {}
  subscriber = null
}
