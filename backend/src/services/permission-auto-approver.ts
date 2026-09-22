import type { Database } from 'bun:sqlite'
import { logger } from '../utils/logger'
import { listApplicableRules } from '../db/permission-rule-queries'
import { getSessionRepo } from '../db/session-repo-queries'
import type { PermissionRule } from '../types/permission-rule'
import { resolveRepoId } from './command-runs'

/**
 * 서버 측 자동승인자 — opencode /event를 직접 구독해 권한 요청을 규칙대로 응답한다.
 * 프론트 폴링 방식의 문제(탭 닫힘·중복 탭·2초 지연·60초 규칙 lag)를 없앤다.
 *
 * 설계 원칙:
 * - 판단은 여기서, 표시는 프론트 (다이얼로그·뱃지는 그대로 living 목록을 보여준다).
 * - 세션 로컬스토리지 룰은 백엔드가 볼 수 없어 프론트가 계속 담당한다 (빠른 경로).
 * - 응답은 'always' 1회 (60초 TTL dedupe로 중복 응답 방지).
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

export function ruleMatches(rule: PermissionRule, permission: AskedPermission): boolean {
  const type = permission.permission ?? permission.type
  if (rule.permission !== '*' && rule.permission !== type) return false
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

/**
 * S2 veto 예외: 룰 패턴이 구체 경로를 명시하면 레포 밖이어도 승인한다.
 * veto는 전역 `*` 같은 광범위 룰의 타 레포 오승인만 막는다.
 * 사용자가 외부 경로를 콕 집어 등록한 룰까지 막으면 등록해도 계속 묻게 된다.
 */
export function shouldVetoOutsideRepo(rule: PermissionRule): boolean {
  if (rule.pattern === '*') return true
  return !isPathLike(rule.pattern)
}

/** S2 가드레일 대상: 경로 쓰기 계열. 읽기·bash·fetch는 기존대로 둔다. */
const WRITE_SCOPED_TYPES = new Set(['edit', 'external_directory', 'write'])

function stripFileScheme(p: string): string {
  return p.replace(/^file:\/{2,3}/i, '')
}

function isAbsoluteLike(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:\//.test(p)
}

/**
 * 순수 판정: 후보 경로가 세션 레포 안에 있는가.
 * - 절대경로: 레포 fullPath 하위일 때만 inside (대소문자 무시).
 * - 상대경로: 세션 cwd 기준이라 inside로 본다. 단, 다른 레포 루트로
 *   시작하면(`repoB/...`) 명백한 이탈이므로 outside.
 * 하나라도 inside면 전체를 inside로 본다 (호출부가 some으로 집계).
 */
export function isCandidateInRepo(
  candidate: string,
  repoFullPath: string,
  otherRoots: string[],
): boolean {
  const norm = normalizeMatchValue(stripFileScheme(candidate.trim())).toLowerCase()
  if (!norm) return false
  if (!isAbsoluteLike(norm)) {
    const head = norm.split('/')[0] ?? ''
    const others = new Set(otherRoots.map((r) => normalizeMatchValue(r).toLowerCase()).filter(Boolean))
    return !others.has(head)
  }
  const base = normalizeMatchValue(repoFullPath).toLowerCase()
  if (!base) return true
  return norm === base || norm.startsWith(`${base}/`)
}

/**
 * S2 가드레일: 쓰기 계열 요청의 실제 경로가 전부 세션 레포 밖이면 false.
 * 전역 룰(`*`)이 다른 레포를 건드리는 오승인을 막는다. 경로 판단이
 * 불가능하면(비경로 후보만) true — 기존 동작 유지, 다이얼로그로 넘기지 않는다.
 */
async function isInSessionRepo(
  db: Database,
  repoId: number,
  permission: AskedPermission,
): Promise<boolean> {
  let fullPath = ''
  let otherRoots: string[] = []
  try {
    const { getRepoById, listRepos } = await import('../db/queries')
    fullPath = getRepoById(db, repoId)?.fullPath ?? ''
    otherRoots = listRepos(db)
      .filter((r) => r.id !== repoId)
      .map((r) => r.workspaceRel)
      .filter((s): s is string => !!s)
  } catch {
    return true
  }
  const pathLikes = getActualPatterns(permission).filter(isPathLike)
  if (pathLikes.length === 0) return true
  return pathLikes.some((c) => isCandidateInRepo(c, fullPath, otherRoots))
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
): Promise<void> {
  const { ensureServerAuth } = await import('./opencode-auth')
  const base = await resolveBase()
  const headers = ensureServerAuth({ 'Content-Type': 'application/json' })
  if (isV2) {
    const res = await fetch(`${base}/permission/${encodeURIComponent(permissionID)}/reply`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reply: 'always' }),
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
      body: JSON.stringify({ response: 'always' }),
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
  const isV2 = eventType === 'permission.v2.asked'
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
    return `${permission.id} type=${permission.permission ?? permission.type} session=${permission.sessionID} candidates=[${shown}]${cands.length > 4 ? ` +${cands.length - 4}` : ''}${alwaysHint}`
  }
  // directory → repo 스코프가 확정될 때만 승인한다.
  // 해석 실패 시 전체 규칙 폴백은 다른 레포의 규칙으로 승인할 수 있어 금지 —
  // 이 경우 응답하지 않고 사용자 다이얼로그에 맡긴다.
  // S1 정본(session_repo_map)을 먼저 보고, 없으면 directory 역산 + session_status 순.
  let repoId: number | null = null
  try {
    try {
      repoId = getSessionRepo(db, permission.sessionID)
    } catch {}
    const directory = await getSessionDirectoryCached(permission.sessionID, resolveBase)
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
  const matched = candidateRules.find((rule) => ruleMatches(rule, permission))
  if (!matched) {
    logSkip(`Auto-approve no-match (${candidateRules.length} repo+global rules): ${describe()}`)
    return
  }
  // S2 가드레일: 쓰기 계열이 세션 레포 밖이면 룰이 맞아도 승인하지 않는다.
  // (전역 `*` 룰의 타 레포 오승인 방지 — 다이얼로그로 넘긴다)
  const askType = permission.permission ?? permission.type
  if (askType && WRITE_SCOPED_TYPES.has(askType)) {
    let inside = true
    try {
      inside = await isInSessionRepo(db, repoId, permission)
    } catch {
      inside = true
    }
    if (!inside) {
      // 명시적 외부경로 룰(구체 경로 패턴)은 veto하지 않는다 — 사용자가 허용한 위치다.
      // `*` 같은 광범위 룰만 타 레포 오승인 방지로 veto한다.
      if (shouldVetoOutsideRepo(matched)) {
        if (opts?.quiet) logger.debug(`Auto-approve veto (outside session repo ${repoId}): ${describe()} rule=#${matched.id}`)
        else logger.warn(`Auto-approve veto (outside session repo ${repoId}): ${describe()} rule=#${matched.id}`)
        return
      }
      logger.info(`Auto-approve explicit outside-repo rule #${matched.id} (repo ${repoId}): ${describe()}`)
    }
  }
  markResponded(permission.id)
  try {
    await replyPermission(permission.sessionID, permission.id, isV2, resolveBase)
    logger.info(`Auto-approved permission ${permission.id} (${permission.permission ?? permission.type}) for session ${permission.sessionID}`)
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
 * - v1형(reply에 sessionID 필요)으로 처리한다. v2 ask는 이벤트 경로가 담당한다.
 * - 응답 성공/실패 처리는 handleAskedPermission과 동일(dedupe+재시도).
 * - 미승인 사유 로그는 quiet로 낮춰 스팸을 막는다. 승인은 info 유지.
 */
const SWEEP_INTERVAL_MS = 45_000
const SWEEP_START_DELAY_MS = 3_000
let sweepRunning = false

async function sweepPendingPermissions(
  db: Database,
  resolveBase: () => Promise<string>,
): Promise<void> {
  if (sweepRunning) return
  sweepRunning = true
  try {
    const { ensureServerAuth } = await import('./opencode-auth')
    const base = await resolveBase()
    const res = await fetch(`${base}/permission`, {
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

/** opencode /event를 직접 구독한다. fetch 기반이라 런타임에 무관하고, heartbeat 단절을 감시한다. */
export function subscribeOpencodeEvents(
  db: Database,
  opts?: { onEvent?: (type: string) => void; getBaseUrl?: BaseUrlResolver },
): SseSubscriber {
  let stopped = false
  let abort: AbortController | null = null
  let lastSeen = 0
  let watchdog: ReturnType<typeof setInterval> | null = null
  // 주입된 base가 있으면 그대로 쓰고, 없으면 매니저에서 매번 해석한다 (재시작 대응)
  const resolveBase = async (): Promise<string> =>
    opts?.getBaseUrl ? opts.getBaseUrl() : defaultBaseUrl()

  const pump = async (): Promise<void> => {
    while (!stopped) {
      try {
        const { ensureServerAuth } = await import('./opencode-auth')
        const base = await resolveBase()
        abort = new AbortController()
        const res = await fetch(`${base}/event`, {
          headers: { ...ensureServerAuth({}), Accept: 'text/event-stream' },
          signal: abort.signal,
        })
        if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`)
        lastSeen = Date.now()
        // (재)연결 직후 1회 sweep — 단절 구간에 생긴 ask를 즉시 잡는다 (45초 대기 제거).
        void sweepPendingPermissions(db, resolveBase)
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
        logger.debug('Permission event stream dropped, reconnecting:', e instanceof Error ? e.message : e)
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  }

  void pump()
  // 놓친 ask 재조정: 부팅 직후 1회 + 45초 주기. SSE 미수신분도 자동승인 대상이면 처리된다.
  let sweepTimer: ReturnType<typeof setInterval> | null = null
  const sweepOnce = () => {
    if (stopped) return
    void sweepPendingPermissions(db, resolveBase)
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
      logger.warn('Permission event stream stale, reconnecting')
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

let started = false
let subscriber: SseSubscriber | null = null

export function startPermissionAutoApprover(db: Database): void {
  if (started) return
  started = true
  subscriber = subscribeOpencodeEvents(db)
  logger.info('Permission auto-approver subscribed to opencode events')
}

export function stopPermissionAutoApprover(): void {
  started = false
  try {
    subscriber?.stop()
  } catch {}
  subscriber = null
}
