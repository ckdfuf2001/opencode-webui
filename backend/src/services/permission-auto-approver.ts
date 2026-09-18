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
 * - 응답은 'always' 1회. 중복 응답은 opencode가 거부하므로 해롭지 않다.
 * - 실패해도 조용히 넘긴다 — 사용자가 다이얼로그에서 직접 처리할 수 있다.
 */

export interface AskedPermission {
  id: string
  sessionID: string
  permission?: string
  type?: string
  pattern?: string | string[]
  patterns?: string[]
  metadata?: Record<string, unknown>
}

const ASK_TYPES = new Set(['permission.asked', 'permission.updated', 'permission.v2.asked'])

// 응답済み dedupe (60초 TTL, 상한 500 — 탭 중복이 아니라 프로세스 단일이라 충분)
const respondedRecently = new Map<string, number>()
const RESPONDED_TTL_MS = 60_000
const RESPONDED_MAX = 500

function markResponded(id: string): void {
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
    .map((segment) => segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*')
  return new RegExp(`^${escaped}$`)
}

function getCandidatePatterns(permission: AskedPermission): string[] {
  const patterns = permission.patterns ?? permission.pattern
  const normalized = Array.isArray(patterns) ? patterns : patterns ? [patterns] : []
  const metadata = permission.metadata ?? {}
  const metadataValue =
    (metadata as { command?: unknown }).command ??
    (metadata as { path?: unknown }).path ??
    (metadata as { url?: unknown }).url
  const metadataPatterns = typeof metadataValue === 'string' ? [metadataValue] : []
  return [...normalized, ...metadataPatterns]
}

export function ruleMatches(rule: PermissionRule, permission: AskedPermission): boolean {
  const type = permission.permission ?? permission.type
  if (rule.permission !== '*' && rule.permission !== type) return false
  const regex = globToRegex(rule.pattern)
  return getCandidatePatterns(permission).some((candidate) => {
    if (!candidate) return false
    if (regex.test(candidate)) return true
    if (rule.pattern === '*') return true
    const normCandidate = candidate.replace(/\\/g, '/')
    const normRule = rule.pattern.replace(/\\/g, '/')
    if (normCandidate === normRule) return true
    if (normCandidate.startsWith(`${normRule}/`)) return true
    if (normCandidate.startsWith(`${normRule} `)) return true
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
  return {
    id: r.id,
    sessionID: r.sessionID,
    permission: typeof r.permission === 'string' ? r.permission : undefined,
    type: typeof r.type === 'string' ? r.type : undefined,
    pattern: typeof r.pattern === 'string' ? r.pattern : undefined,
    patterns,
    metadata:
      r.metadata && typeof r.metadata === 'object'
        ? (r.metadata as Record<string, unknown>)
        : undefined,
  }
}

async function fetchSessionDirectory(sessionID: string): Promise<string | undefined> {
  try {
    const { opencodeServerManager } = await import('./opencode-single-server')
    const { ensureServerAuth } = await import('./opencode-auth')
    const base = opencodeServerManager.getUrl()
    const res = await fetch(`${base}/session/${encodeURIComponent(sessionID)}`, {
      headers: ensureServerAuth({}),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return undefined
    const info = (await res.json()) as { directory?: string }
    return typeof info?.directory === 'string' && info.directory ? info.directory : undefined
  } catch {
    return undefined
  }
}

async function replyPermission(
  sessionID: string,
  permissionID: string,
  isV2: boolean,
): Promise<void> {
  const { opencodeServerManager } = await import('./opencode-single-server')
  const { ensureServerAuth } = await import('./opencode-auth')
  const base = opencodeServerManager.getUrl()
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

async function handleAskedPermission(db: Database, raw: unknown, eventType: string): Promise<void> {
  const permission = normalizePermission(raw)
  if (!permission) return
  if (wasResponded(permission.id)) return
  const isV2 = eventType === 'permission.v2.asked'
  // directory → repo 규칙 매칭, 실패하면 전체 규칙 (프론트와 동일 폴백)
  let candidateRules: PermissionRule[] | undefined
  try {
    const directory = await fetchSessionDirectory(permission.sessionID)
    if (directory) {
      const repoId = resolveRepoId(db, directory)
      if (repoId != null) {
        const mine = listPermissionRules(db, repoId)
        if (mine.length > 0) candidateRules = mine
      }
    }
  } catch (e) {
    logger.debug('Auto-approve directory resolve skipped:', e)
  }
  try {
    if (!candidateRules || candidateRules.length === 0) {
      const all = listPermissionRules(db)
      if (all.length === 0) return
      candidateRules = all
    }
  } catch (e) {
    logger.debug('Auto-approve rules read skipped:', e)
    return
  }
  if (!candidateRules.some((rule) => ruleMatches(rule, permission))) return
  markResponded(permission.id)
  setTimeout(() => {
    respondedRecently.delete(permission.id)
  }, RESPONDED_TTL_MS).unref?.()
  try {
    await replyPermission(permission.sessionID, permission.id, isV2)
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
  opts?: { onEvent?: (type: string) => void },
): SseSubscriber {
  let stopped = false
  let abort: AbortController | null = null
  let lastSeen = 0
  let watchdog: ReturnType<typeof setInterval> | null = null

  const pump = async (): Promise<void> => {
    while (!stopped) {
      try {
        const { opencodeServerManager } = await import('./opencode-single-server')
        const { ensureServerAuth } = await import('./opencode-auth')
        const base = opencodeServerManager.getUrl()
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
            void handleAskedPermission(db, props, type)
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
