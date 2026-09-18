import type { Database } from 'bun:sqlite'
import { logger } from '../utils/logger'
import { listPermissionRules } from '../db/permission-rule-queries'
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

function getCandidatePatterns(permission: AskedPermission): string[] {
  const patterns = permission.patterns ?? permission.pattern
  const normalized = Array.isArray(patterns) ? patterns : patterns ? [patterns] : []
  const metadata = (permission.metadata ?? {}) as Record<string, unknown>
  const asString = (v: unknown): string[] => (typeof v === 'string' && v ? [v] : [])
  // opencode는 permission마다 다른 키를 쓴다:
  // bash=command, read/edit=path, webfetch=url,
  // external_directory=metadata.filepath/parentDir (+ always 제안 패턴)
  const metadataPatterns = [
    ...asString(metadata.command),
    ...asString(metadata.path),
    ...asString(metadata.url),
    ...asString(metadata.filepath),
    ...asString(metadata.parentDir),
    ...asString(metadata.directory),
  ]
  const alwaysPatterns = Array.isArray(permission.always)
    ? permission.always.flatMap((p) => asString(p))
    : []
  return [...normalized, ...metadataPatterns, ...alwaysPatterns]
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
): Promise<void> {
  const permission = normalizePermission(raw)
  if (!permission) return
  if (wasResponded(permission.id)) return
  const isV2 = eventType === 'permission.v2.asked'
  // 진단용: 왜 승인/스킵됐는지 info에 남긴다 (ask는 사용자 다이얼로그급이라 info가 적당)
  const describe = (): string => {
    const cands = getCandidatePatterns(permission)
    const shown = cands.slice(0, 4).join(' | ').slice(0, 300)
    return `${permission.id} type=${permission.permission ?? permission.type} session=${permission.sessionID} candidates=[${shown}]${cands.length > 4 ? ` +${cands.length - 4}` : ''}`
  }
  // directory → repo 스코프가 확정될 때만 승인한다.
  // 해석 실패 시 전체 규칙 폴백은 다른 레포의 규칙으로 승인할 수 있어 금지 —
  // 이 경우 응답하지 않고 사용자 다이얼로그에 맡긴다.
  let repoId: number | null = null
  try {
    const directory = await getSessionDirectoryCached(permission.sessionID, resolveBase)
    if (!directory) {
      logger.info(`Auto-approve skip (no session directory): ${describe()}`)
      return
    }
    repoId = resolveRepoId(db, directory)
    if (repoId == null) {
      logger.info(`Auto-approve skip (no repo for dir): ${describe()} dir=${directory}`)
      return
    }
  } catch (e) {
    // 조회 실패는 조용히 넘기면 원인을 알 수 없으니 warn (404 등 미해석은 위에서 return)
    logger.warn(`Auto-approve directory resolve failed for session ${permission.sessionID}:`, e)
    return
  }
  let candidateRules: PermissionRule[]
  try {
    candidateRules = listPermissionRules(db, repoId)
  } catch (e) {
    logger.warn(`Auto-approve rules read failed (repo ${repoId}):`, e)
    return
  }
  if (candidateRules.length === 0) {
    logger.info(`Auto-approve skip (no rules for repo ${repoId}): ${describe()}`)
    return
  }
  if (!candidateRules.some((rule) => ruleMatches(rule, permission))) {
    logger.info(`Auto-approve no-match (${candidateRules.length} repo rules): ${describe()}`)
    return
  }
  markResponded(permission.id)
  try {
    await replyPermission(permission.sessionID, permission.id, isV2, resolveBase)
    logger.info(`Auto-approved permission ${permission.id} (${permission.permission ?? permission.type}) for session ${permission.sessionID}`)
  } catch (e) {
    // 중복 응답 등 — 해롭지 않으므로 다음 폴링/다이얼로그에 맡긴다
    logger.debug(`Auto-approve reply skipped for ${permission.id}:`, e)
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
