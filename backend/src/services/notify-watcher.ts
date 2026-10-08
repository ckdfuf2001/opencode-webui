import type { Database } from 'bun:sqlite'
import { SettingsService } from './settings'
import {
  getNotifyOverride,
  getNotifyState,
  type NotifyOverride,
} from '../db/notify-queries'
import { getSessionStatusRow } from '../db/session-status-queries'
import { listRepos } from '../db/queries'
import { listQueuedChats } from './chat-queue'
import { recentSessionMessages } from './session-message-db'
import { opencodeServerManager } from './opencode-single-server'
import { ensureServerAuth } from './opencode-auth'
import { isPermissionAutoApprovable } from './permission-auto-approver'
import { sessionWebPath } from './webui-base'
import { showOsToast } from './os-notify'
import { logger } from '../utils/logger'

/**
 * 백단 OS 알림 감지 — session-status 폴러 틱마다 호출된다.
 * 프론트(브라우저)가 꺼져 있어도 완료/취소/승인대기/질문을 PC 토스트로 알린다.
 * 프론트는 OS 토스트를 쏘지 않는다 (완료 틱 소리만 유지) — 중복 없음.
 */

export interface NotifyTickSessionInfo {
  repoId: number | null
  directory: string
  perm: number
  permSample?: string
  question: number
}

export interface NotifyTickInput {
  /** 이번 틱에 busy로 관측된 세션 */
  busyNow: Set<string>
  /** 스냅샷·폴백에서 파악된 세션 정보 */
  info: Map<string, NotifyTickSessionInfo>
}

/** 중단 보고 유효 window — 프론트 RECENTLY_ABORTED_MS(12s)와 동일 의미. */
export const ABORT_WINDOW_MS = 12_000
/** 승인/질문 대기 grace — 자동승인(SSE 즉시·45s sweep)이 처리할 시간을 준다. */
const PENDING_GRACE_MS = 4_000

interface PrevSession {
  busy: boolean
}
const prevBySession = new Map<string, PrevSession>()

interface PendingEdge {
  count: number
  firstSeenAt: number
  notifiedCount: number
}
const pendingEdges = new Map<string, PendingEdge>()

/** 테스트 격리용 — 전이 상태를 초기화한다. */
export function resetNotifyWatcherState(): void {
  prevBySession.clear()
  pendingEdges.clear()
}

/** 테스트용 pure 로직: 세션 > 레포 > 전역 순 push effective. */
export function resolvePushEnabled(
  sessionOv: NotifyOverride | null,
  repoOv: NotifyOverride | null,
  globalEnabled: boolean,
): boolean {
  if (sessionOv?.pushEnabled !== undefined && sessionOv?.pushEnabled !== null) return sessionOv.pushEnabled
  if (repoOv?.pushEnabled !== undefined && repoOv?.pushEnabled !== null) return repoOv.pushEnabled
  return globalEnabled
}

/** 테스트용 pure 로직: busy→idle 라벨. abort가 마지막 send 이후 window 안에 있으면 cancelled. */
export function decideCompletionLabel(
  lastSendAt: number,
  lastAbortAt: number,
  now: number,
  abortWindowMs = ABORT_WINDOW_MS,
): 'cancelled' | 'completed' {
  if (lastAbortAt > lastSendAt && now - lastAbortAt < abortWindowMs) return 'cancelled'
  return 'completed'
}

export function processNotifyTick(db: Database, input: NotifyTickInput, now = Date.now()): void {
  let prefs: { pushNotificationEnabled?: boolean; pushNotificationDuration?: number }
  try {
    prefs = new SettingsService(db).getSettings('default').preferences as typeof prefs
  } catch {
    return
  }
  const globalPush = prefs.pushNotificationEnabled === true
  const expireSeconds = typeof prefs.pushNotificationDuration === 'number' && prefs.pushNotificationDuration > 0
    ? prefs.pushNotificationDuration
    : undefined

  const seen = new Set<string>()
  for (const [sessionId, info] of input.info) {
    seen.add(sessionId)
    const prev = prevBySession.get(sessionId)
    const wasBusy = prev?.busy === true
    const isBusy = input.busyNow.has(sessionId)
    if (wasBusy && !isBusy) {
      handleCompletion(db, sessionId, info, globalPush, expireSeconds, now)
    }
    handlePendingEdge(db, sessionId, info, 'perm', info.perm, info.permSample, globalPush, expireSeconds, now)
    handlePendingEdge(db, sessionId, info, 'question', info.question, undefined, globalPush, expireSeconds, now)
    prevBySession.set(sessionId, { busy: isBusy })
  }
  // 스냅샷에 포함된 prev-busy 소실분(완료 후보)도 info에 들어오므로 여기서 정리만 한다.
  for (const sessionId of [...prevBySession.keys()]) {
    if (!seen.has(sessionId)) prevBySession.delete(sessionId)
  }
  for (const key of [...pendingEdges.keys()]) {
    if (!seen.has(key.split(':')[0]!)) pendingEdges.delete(key)
  }
}

/** prev-busy인데 이번 틱 스냅샷에 없는 세션 — 완료 후보이므로 info에 보충한다. */
export function fillMissingBusy(
  db: Database,
  input: NotifyTickInput,
  prevBusy: Set<string>,
): void {
  for (const sessionId of prevBusy) {
    if (input.info.has(sessionId)) continue
    const row = getSessionStatusRow(db, sessionId)
    input.info.set(sessionId, {
      repoId: row?.repoId ?? null,
      directory: row?.directory ?? 'global',
      perm: 0,
      question: 0,
    })
  }
}

export function getPrevBusySessions(): Set<string> {
  const out = new Set<string>()
  for (const [sessionId, prev] of prevBySession) {
    if (prev.busy) out.add(sessionId)
  }
  return out
}

function pushAllowed(db: Database, sessionId: string, repoId: number | null, globalPush: boolean): boolean {
  try {
    const sessionOv = getNotifyOverride(db, 'session', sessionId)
    const repoOv = repoId != null ? getNotifyOverride(db, 'repo', String(repoId)) : null
    return resolvePushEnabled(sessionOv, repoOv, globalPush)
  } catch {
    return globalPush
  }
}

function handleCompletion(
  db: Database,
  sessionId: string,
  info: NotifyTickSessionInfo,
  globalPush: boolean,
  expireSeconds: number | undefined,
  now: number,
): void {
  if (!pushAllowed(db, sessionId, info.repoId, globalPush)) return
  // 큐에 후속 턴이 있으면 아직 끝이 아니다 — 턴 사이 idle 공백 오탐 방지.
  // 취소 라벨이라도 다음 턴이 이어지면 알리지 않는다 (다음 턴 완료 때 알림).
  try {
    const queued = listQueuedChats(sessionId).some((item) => item.status === 'queued' || item.status === 'sending')
    if (queued) return
  } catch {}
  const { lastSendAt, lastAbortAt } = safeGetNotifyState(db, sessionId)
  const label = decideCompletionLabel(lastSendAt, lastAbortAt, now)
  if (label === 'cancelled') {
    notifySession(db, sessionId, info, '응답이 취소되었습니다', expireSeconds).catch(() => {})
    return
  }
  // working 공백(연결 흔들림 등)에 complete가 아닌데 발송하지 않도록 마지막 메시지 확인.
  void (async () => {
    try {
      const recent = await recentSessionMessages(sessionId, 1)
      const last = recent?.messages?.[recent.messages.length - 1] as unknown as
        | { info?: { role?: string; time?: { completed?: number } } }
        | undefined
      const done = !!last && last.info?.role === 'assistant' && !!last.info?.time?.completed
      if (!done) return
      await notifySession(db, sessionId, info, '응답이 완료되었습니다', expireSeconds)
    } catch (error) {
      logger.debug(`Completion check skipped for ${sessionId}:`, error instanceof Error ? error.message : error)
    }
  })()
}

function handlePendingEdge(
  db: Database,
  sessionId: string,
  info: NotifyTickSessionInfo,
  kind: 'perm' | 'question',
  count: number,
  sample: string | undefined,
  globalPush: boolean,
  expireSeconds: number | undefined,
  now: number,
): void {
  const key = `${sessionId}:${kind}`
  if (count <= 0) {
    pendingEdges.delete(key)
    return
  }
  if (!pushAllowed(db, sessionId, info.repoId, globalPush)) return
  let edge = pendingEdges.get(key)
  if (!edge) {
    edge = { count, firstSeenAt: 0, notifiedCount: 0 }
    pendingEdges.set(key, edge)
  }
  if (count < edge.notifiedCount) {
    // 일부 해소 → 아래로 리암 (새 대기에는 다시 grace).
    edge.notifiedCount = count
    edge.firstSeenAt = 0
  }
  if (count > edge.notifiedCount) {
    if (!edge.firstSeenAt) edge.firstSeenAt = now
    if (now - edge.firstSeenAt >= PENDING_GRACE_MS) {
      if (kind === 'perm') {
        // 자동승인 대상은 토스트 없이 승인자에게 맡긴다 (중복 확인 방지용 선점).
        edge.notifiedCount = count
        edge.firstSeenAt = 0
        void verifyAndNotifyPerm(db, sessionId, info, count, expireSeconds)
      } else {
        const title = '질문이 도착했습니다'
        void notifyPending(db, sessionId, info, title, sample, count, expireSeconds)
        edge.notifiedCount = count
        edge.firstSeenAt = 0
      }
    }
  }
}

/** 승인 대기 중 자동승인 불가분만 토스트한다. 전량 승인 가능이면 조용히 넘어간다. */
async function verifyAndNotifyPerm(
  db: Database,
  sessionId: string,
  info: NotifyTickSessionInfo,
  count: number,
  expireSeconds: number | undefined,
): Promise<void> {
  try {
    const items = await fetchSessionPermItems(info.directory, sessionId)
    if (items.length === 0) return
    const actionable = items.filter((item) => !isPermissionAutoApprovable(db, sessionId, info.repoId, item))
    if (actionable.length === 0) return
    const first = actionable[0] as Record<string, unknown>
    await notifyPending(
      db,
      sessionId,
      info,
      '승인이 필요합니다',
      extractItemSample(first),
      actionable.length,
      expireSeconds,
    )
  } catch (error) {
    logger.debug(`Perm verify skipped for ${sessionId}:`, error instanceof Error ? error.message : error)
  }
}

async function fetchSessionPermItems(directory: string, sessionId: string): Promise<unknown[]> {
  const qs = directory && directory !== 'global' ? `?directory=${encodeURIComponent(directory)}` : ''
  const url = `${opencodeServerManager.getUrl()}/permission${qs}`
  const res = await fetch(url, {
    headers: ensureServerAuth({}),
    signal: AbortSignal.timeout(2_500),
  })
  if (!res.ok) return []
  const list = (await res.json()) as Array<{ sessionID?: string }>
  if (!Array.isArray(list)) return []
  return list.filter((item) => item?.sessionID === sessionId)
}

function extractItemSample(item: Record<string, unknown>): string | undefined {
  const raw = (item.patterns ?? item.pattern) as unknown
  const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  const first = arr.find((v): v is string => typeof v === 'string' && v.length > 0)
  if (first) return first.slice(0, 120)
  for (const key of ['permission', 'action', 'type'] as const) {
    const v = item[key]
    if (typeof v === 'string' && v.length > 0) return v.slice(0, 120)
  }
  return undefined
}

function safeGetNotifyState(db: Database, sessionId: string): { lastSendAt: number; lastAbortAt: number } {
  try {
    return getNotifyState(db, sessionId)
  } catch {
    return { lastSendAt: 0, lastAbortAt: 0 }
  }
}

async function notifySession(
  db: Database,
  sessionId: string,
  info: NotifyTickSessionInfo,
  title: string,
  expireSeconds: number | undefined,
): Promise<void> {
  const body = await buildSessionBody(db, info, sessionId)
  showOsToast(title, body, { expireSeconds, path: sessionWebPath(info.repoId, sessionId) })
}

async function notifyPending(
  db: Database,
  sessionId: string,
  info: NotifyTickSessionInfo,
  title: string,
  sample: string | undefined,
  count: number,
  expireSeconds: number | undefined,
): Promise<void> {
  let body = await buildSessionBody(db, info, sessionId)
  if (sample) body += ` — ${sample}`
  if (count > 1) body += ` (+${count - 1}건)`
  showOsToast(title, body, { expireSeconds, path: sessionWebPath(info.repoId, sessionId) })
}

async function buildSessionBody(db: Database, info: NotifyTickSessionInfo, sessionId: string): Promise<string> {
  const repoLabel = resolveRepoLabel(db, info.repoId)
  const sessLabel = (await fetchSessionTitle(sessionId)) ?? sessionId.slice(0, 8)
  return `${repoLabel} · ${sessLabel}`
}

function resolveRepoLabel(db: Database, repoId: number | null): string {
  try {
    if (repoId == null) return 'Workspace'
    const repo = listRepos(db).find((r) => (r as { id?: number }).id === repoId) as
      | { repoUrl?: string | null; localPath?: string }
      | undefined
    if (!repo) return `repo ${repoId}`
    if (repo.repoUrl) {
      const base = repo.repoUrl.split('/').pop()?.replace('.git', '')
      return base || repo.localPath || `repo ${repoId}`
    }
    return repo.localPath || `repo ${repoId}`
  } catch {
    return repoId != null ? `repo ${repoId}` : 'Workspace'
  }
}

async function fetchSessionTitle(sessionId: string): Promise<string | null> {
  try {
    const url = `${opencodeServerManager.getUrl()}/session/${encodeURIComponent(sessionId)}`
    const res = await fetch(url, {
      headers: ensureServerAuth({}),
      signal: AbortSignal.timeout(2_500),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { title?: unknown }
    return typeof data.title === 'string' && data.title.trim() ? data.title.trim().slice(0, 80) : null
  } catch {
    return null
  }
}
