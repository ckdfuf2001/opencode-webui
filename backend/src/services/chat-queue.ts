import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { opencodeServerManager } from './opencode-single-server'
import { ensureServerAuth } from './opencode-auth'
import { isReasoningMismatchText, healReasoningTail, sweepPollutedStubs, asOutgoingModel, preSendStripIfMismatch, findNewMismatch } from './reasoning-heal'
import { stripAllReasoningParts } from './opencode-db'
import { recentSessionMessages } from './session-message-db'
import { getWorkspacePath } from '@opencode-webui/shared'
import { getSessionStatusRow, setSessionCancelled } from '../db/session-status-queries'
import { resolveLiveDirectory, resolveRepoId } from './command-runs'
import { buildRecall, readRecallPrefs } from './recall'
import { logger } from '../utils/logger'

let queueDb: Database | null = null
export function setChatQueueDb(db: Database): void {
  queueDb = db
}

export interface QueuedChat {
  id: string
  text: string
  createdAt: number
  status: 'queued' | 'sending' | 'failed'
  model?: { providerID: string; modelID: string }
  agent?: string
  /** 세션 리뷰/자동변경 오버라이드 스냅샷 (undefined면 상속 = 레포 DB 설정). */
  reviewWanted?: boolean
  autoApply?: boolean
  /** sending으로 바뀐 시각. 장시간 sending 고착(nw오류·장시간 턴) 감지용. */
  sendingSince?: number
  /** failed로 바뀐 시각. 일시적 네트워크 오류 후 자동 재시도 쿨다운용. */
  failedAt?: number
  /** 누적 실패 횟수(타임아웃 제외). 영구 failed 판정용. */
  attempts?: number
}

export interface EnqueueOptions {
  model?: { providerID: string; modelID: string }
  agent?: string
  reviewWanted?: boolean
  autoApply?: boolean
}

const MAX_QUEUE_LENGTH = 20
const MAX_TEXT_LENGTH = 16_000
const REQUEST_TIMEOUT_MS = 1_500
// opencode는 턴이 끝나야 응답 헤더를 보낸다. SAP 분석 같은 장시간 턴(로그상 9분+)이
// 90초에 항상 TimeoutError가 나서 sending limbo가 반복되므로 proxy long-running(600s)에 맞춘다.
const SEND_HEADERS_TIMEOUT_MS = 600_000
const FLUSH_RETRY_BACKOFF_MS = 2_000
// sending이 이 시간을 넘겨도 idle이 관측되지 않으면 고착 의심으로 warn을 남긴다
// (자동 제거는 중복 전송 위험이 있어 하지 않는다 — 사용자가 retry/requeue로 해제).
const SENDING_STUCK_WARN_MS = 10 * 60_000

// In-memory, per-session FIFO of user messages typed while the assistant was
// still generating. The session status poller (2s) flushes them one at a time
// whenever the session is idle again. Lost on backend restart by design.
const queues = new Map<string, QueuedChat[]>()
const failedUntil = new Map<string, number>()
// 연속 실패 횟수. 상한을 넘기면 failed로 고정한다
// (폴더명 변경 등으로 디렉터리가 깨졌을 때 수십 번 중복 발송 방지).
// failed 헤드는 순서 유지를 위해 다음 항목을 막는다. 사용자가 X로 지우거나
// 수동 재시도(retry)하면 해제. 자동 재시도는 하지 않는다 (retry storm 방지).
const failCount = new Map<string, number>()
const MAX_CONSECUTIVE_FAILURES = 5
const inFlight = new Set<string>()
// 발송 중 fetch를 취소하기 위한 세션별 AbortController.
// clearSendingOnAbort/clearQueuedChats(중단 버튼)가 이것을 abort한다.
// 없으면 600s 타임아웃 fetch가 살아남아 취소 후에도 실패 accounting/재발송을 일으킨다.
const inFlightControllers = new Map<string, AbortController>()
function abortInFlight(sessionID: string): void {
  const ac = inFlightControllers.get(sessionID)
  if (!ac) return
  try { ac.abort() } catch {}
  inFlightControllers.delete(sessionID)
}
const QUOTA_BODY_PATTERNS = [
  'insufficient_quota',
  'insufficient balance',
  'quota exceeded',
  'exceeded your current quota',
  'freeusagelimit',
  'subscriptionusagelimit',
  'usage_not_included',
  'payment required',
  'add credits',
]
/** 결제/쿼터 거부는 재시도해도 성공하지 않는다 → 즉시 failed (5회 재시도 스톰 방지). */
export function isQuotaRejection(status?: number, bodyText?: string): boolean {
  if (status === 402) return true
  if (!bodyText) return false
  const lower = bodyText.toLowerCase()
  if (!QUOTA_BODY_PATTERNS.some((p) => lower.includes(p))) return false
  if (status === undefined) return true
  return status === 429 || status === 400 || status === 402 || status === 403
}
// 세션별 opencode 디렉터리. busy 체크·발송을 세션의 실제 디렉터리로 조회해야
// workspace 기준으로 조회해 repo 세션을 idle 로 오판하지 않는다.
const queueDirs = new Map<string, string>()
// 마지막으로 busy 가 관측된 시각. generation이 끝나는 순간이 아니라 working
// 표시가 꺼진 뒤에 발송되도록 idle grace를 둔다 (상태 전이·폴러 지연 흡수).
const lastBusyAt = new Map<string, number>()
const IDLE_GRACE_MS = 250
const quickModeSessions = new Set<string>()
export function setQuickMode(sessionID: string, enabled: boolean): void {
  if (enabled) quickModeSessions.add(sessionID)
  else quickModeSessions.delete(sessionID)
}
export function isQuickMode(sessionID: string): boolean {
  return quickModeSessions.has(sessionID)
}
export function hasAnyQueuedChats(): boolean {
  return queues.size > 0
}
export function hasQueuedChatsForSession(sessionID: string): boolean {
  const q = queues.get(sessionID)
  return !!q && q.length > 0
}

export function listQueuedChats(sessionID: string): QueuedChat[] {
  return queues.get(sessionID) ?? []
}

export function enqueueQueuedChat(sessionID: string, text: string, directory?: string, opts?: EnqueueOptions): QueuedChat[] {
  const trimmed = text.trim().slice(0, MAX_TEXT_LENGTH)
  const queue = queues.get(sessionID) ?? []
  queue.push({
    id: crypto.randomUUID(),
    text: trimmed,
    createdAt: Date.now(),
    status: 'queued',
    ...(opts?.model ? { model: opts.model } : {}),
    ...(opts?.agent ? { agent: opts.agent } : {}),
    ...(opts?.reviewWanted !== undefined ? { reviewWanted: opts.reviewWanted } : {}),
    ...(opts?.autoApply !== undefined ? { autoApply: opts.autoApply } : {}),
  })
  while (queue.length > MAX_QUEUE_LENGTH) queue.shift()
  queues.set(sessionID, queue)
  if (directory) queueDirs.set(sessionID, directory)
  logger.info(`Queued chat message for session ${sessionID} (position ${queue.length})`)
  return [...queue]
}

export function removeQueuedChat(sessionID: string, id: string): boolean {
  const queue = queues.get(sessionID)
  if (!queue) return false
  const index = queue.findIndex((item) => item.id === id)
  if (index === -1) return false
  const [removed] = queue.splice(index, 1)
  if (removed?.status === 'sending') {
    // 발송 중 항목을 X로 지우면 진행 중 fetch도 끊는다 — 아니면 settle 시
    // 실패 accounting/backoff가 걸려 다음 전송이 막힌다.
    abortInFlight(sessionID)
    markRecentlyAborted(sessionID)
  }
  if (queue.length === 0) {
    queues.delete(sessionID)
    queueDirs.delete(sessionID)
    failCount.delete(sessionID)
    failedUntil.delete(sessionID)
  }
  return true
}

/**
 * 세션 모델 변경 시 큐에 스냅샷된 모델을 새 모델로 동기화한다.
 * enqueue 시점에 박아둔 model 때문에 세션 모델을 바꿔도 stale 모델로
 * 발송되던 버그 대응. 발송 중(sending)은 이미 opencode로 넘어가 회수
 * 불가이므로 건드리지 않고, 발송 대기(queued)·실패(failed)만 갱신한다.
 * failed도 갱신해야 재시도가 깨진 모델로 반복 실패하지 않는다.
 * 큐가 없으면 null (호출자는 no-op 성공으로 취급).
 */
export function updateQueuedChatsModel(
  sessionID: string,
  model: { providerID: string; modelID: string },
): QueuedChat[] | null {
  const queue = queues.get(sessionID)
  if (!queue) return null
  for (const item of queue) {
    if (item.status === 'sending') continue
    item.model = { ...model }
    // 모델이 바뀌었으니 이전 실패 카운트/시각은 무효 — 새 모델로 즉시 재시도 가능하게
    if (item.status === 'failed') {
      item.status = 'queued'
      delete item.failedAt
      delete item.sendingSince
    }
  }
  failCount.delete(sessionID)
  failedUntil.delete(sessionID)
  logger.info(`Updated queued chat model for session ${sessionID} to ${model.providerID}/${model.modelID}`)
  return [...queue]
}

/**
 * 대기열 순서 변경. toTop 이면 맨 앞(최우선)으로, 아니면 한 칸 위로.
 * 이미 첫 항목이거나 id 를 못 찾으면 현재 큐를 그대로 돌려준다(변화 없음).
 * 전송 중(sending)인 헤드는 발송 슬롯이라 건드리지 않는다: sending 항목
 * 자체는 이동 불가, 다른 항목도 헤드 앞으로 못 간다 (최소 index 1).
 */
export function moveQueuedChat(sessionID: string, id: string, toTop: boolean): QueuedChat[] | null {
  const queue = queues.get(sessionID)
  if (!queue) return null
  const index = queue.findIndex((item) => item.id === id)
  if (index <= 0) return [...queue]
  if (queue[index]?.status === 'sending') return [...queue]
  const headLocked = queue[0]?.status === 'sending'
  const removed = queue.splice(index, 1)
  const item = removed[0]
  if (!item) return [...queue]
  if (toTop) queue.splice(headLocked ? 1 : 0, 0, item)
  else queue.splice(Math.max(index - 1, headLocked ? 1 : 0), 0, item)
  return [...queue]
}

const recentlyAbortedBackend = new Set<string>()

function markRecentlyAborted(sessionID: string): void {
  recentlyAbortedBackend.add(sessionID)
  setTimeout(() => recentlyAbortedBackend.delete(sessionID), 5000)
}

/** 중단(abort) 시 호출: 세션의 대기열 전체를 비운다. */
export function clearQueuedChats(sessionID: string): number {
  abortInFlight(sessionID)
  markRecentlyAborted(sessionID)
  const queue = queues.get(sessionID)
  if (!queue) return 0
  const count = queue.length
  queues.delete(sessionID)
  queueDirs.delete(sessionID)
  failCount.delete(sessionID)
  failedUntil.delete(sessionID)
  logger.info(`Cleared ${count} queued chat(s) for session ${sessionID}`)
  return count
}

export function clearSendingOnAbort(sessionID: string): void {
  abortInFlight(sessionID)
  const queue = queues.get(sessionID)
  if (queue) {
    const idx = queue.findIndex((item) => item.status === 'sending')
    if (idx !== -1) {
      queue.splice(idx, 1)
      if (queue.length === 0) {
        queues.delete(sessionID)
        queueDirs.delete(sessionID)
      }
      logger.info(`Cleared sending item for session ${sessionID} on abort`)
    }
  }
  lastBusyAt.delete(sessionID)
  failedUntil.delete(sessionID)
  failCount.delete(sessionID)
  markRecentlyAborted(sessionID)
}

/**
 * Sends the head of every idle session's queue. Only one message per session
 * per cycle: sending starts a new turn, so the rest wait until the poller sees
 * the session idle again. Dispatch failures re-queue the item at the front
 * with a backoff so a broken OpenCode server cannot spin the flusher.
 *
 * Removal is confirm-based: the head is marked `sending` and STAYS visible
 * until the turn is confirmed — HTTP 2xx (opencode answers after the turn)
 * removes it immediately, a timeout keeps it `sending` until the session
 * goes idle again (turn finished), and only connect errors go back to queued.
 *
 * Idle gate: opens a /session/status check BEFORE handing the message to
 * OpenCode so the next queued message is not pushed while the previous
 * answer is still generating. While busy the head stays queued and the
 * status poller retries once the session goes idle.
 */
async function dispatchHead(base: string, sessionID: string): Promise<void> {
  if (inFlight.has(sessionID)) return
  if ((failedUntil.get(sessionID) ?? 0) > Date.now()) return
  const queue = queues.get(sessionID)
  if (!queue || queue.length === 0) return
  const next = queue[0]
  if (!next) return
  // failed는 수동 retry/X까지 유지한다 — 자동 재시도 없음.
  // 폴러·쿨다운에 의한 자동 재전송이 동일 텍스트를 새 턴으로 반복 생성해
  // 세션을 도배하던(retry storm) 문제 대응. 일시적 nw오류는 connect-error
  // 분기(queued 유지 + 백오프)가 담당하고, 진짜 실패는 사용자가 직접 재시도한다.
  if (next.status === 'failed') {
    return
  }
  if (next.status === 'sending') {
    // 전송은 됐는데 응답 미확인 상태. 세션이 idle이면 턴이 끝난 것으로 보고 제거(확정).
    if (await isSessionBusy(sessionID)) {
      lastBusyAt.set(sessionID, Date.now())
      // 장시간 sending 고착(nw오류·장시간 턴) 경고 — 자동 제거는 중복 전송 위험이 있어 안 한다.
      const since = next.sendingSince ?? 0
      if (since && Date.now() - since > SENDING_STUCK_WARN_MS) {
        logger.warn(`Queued chat for session ${sessionID} stuck in sending for ${Math.round((Date.now() - since) / 60000)}min (still busy). User can abort or POST /api/chat-queue/${sessionID}/${next.id}/retry to requeue.`)
        // warn 스팸 방지: 다음 warn은 한 쿨다운 뒤에
        next.sendingSince = Date.now()
      }
      return
    }
    queue.splice(0, 1)
    if (queue.length === 0) {
      queues.delete(sessionID)
      queueDirs.delete(sessionID)
    }
    failedUntil.delete(sessionID)
    failCount.delete(sessionID)
    logger.info(`Confirmed queued chat delivered to session ${sessionID} (idle observed)`)
    return
  }
  if (await isSessionBusy(sessionID)) {
    lastBusyAt.set(sessionID, Date.now())
    return
  }
  // generation 종료 직후가 아니라 working 표시가 꺼진 뒤에 발송한다.
  // 상태 전이·폴러 지연 동안의 플래핑 발송을 막는다.
  if (Date.now() - (lastBusyAt.get(sessionID) ?? 0) < IDLE_GRACE_MS) return

  // await 동안 다른 발송 경로(폴러 / proxy flush)가 이 slot 을 선점했을 수 있으므로 재검사.
  if (inFlight.has(sessionID)) return
  if ((failedUntil.get(sessionID) ?? 0) > Date.now()) return
  const current = queues.get(sessionID)
  if (!current || current.length === 0 || current[0]?.id !== next.id) return

  // 제거는 확정 후에만: sending 표시 후 응답 확인(HTTP 2xx 즉시, 타임아웃은 idle 관찰) 시 제거.
  // 실패(연결 에러·거부)는 queued로 되돌리고 backoff.
  next.status = 'sending'
  next.sendingSince = Date.now()

  inFlight.add(sessionID)
  logger.info(`Dispatching queued chat to session ${sessionID}; ${listQueuedChats(sessionID).length} remaining`)

  void dispatchQueuedChat(base, sessionID, next)
    .then((result) => {
      // 중단 직후 도착한 결과는 무시한다 — 취소된 슬롯에 실패 accounting/backoff를
      // 걸면 다음 전송까지 막혀 "취소 안됨"처럼 보인다.
      if (recentlyAbortedBackend.has(sessionID)) {
        failedUntil.delete(sessionID)
        return
      }
      if (result.sent) {
        removeHeadIf(sessionID, next.id)
        failedUntil.delete(sessionID)
        failCount.delete(sessionID)
        // 같은 텍스트의 뒤쪽 중복(더블 전송 등)은 이번 성공으로 전달된 것으로 보고 제거.
        // sending은 drop 대상에서 제외된다 (이미 opencode로 넘어감).
        dropDeliveredDuplicates(sessionID, next.text)
        logger.info(`Flushed queued chat to session ${sessionID}; ${listQueuedChats(sessionID).length} remaining`)
      } else if (result.nonRetryable) {
        // reasoning encrypted_content 불일치 같은 결정적 400은 재시도해도 절대
        // 성공하지 않는다. 5회 쿨다운 재시도로 시간만 끌지 말고 즉시 failed로
        // 고정해 사용자가 가위(truncate)·모델 원복으로 복구하게 한다.
        recordDeterministicFailure(sessionID, next.id, result.detail)
      } else {
        recordFailure(sessionID, next.id)
      }
    })
    .catch((error) => {
      // 사용자 중단으로 끊긴 fetch는 에러가 아니다 — 실패로 세지 않는다.
      if (recentlyAbortedBackend.has(sessionID)) {
        failedUntil.delete(sessionID)
        return
      }
      logger.warn(`Queued chat flush errored for session ${sessionID}:`, error)
      // OpenCode는 턴이 끝나야 응답 헤더를 보낼 수 있어 타임아웃은 거의 확실히
      // 전달됐다는 뜻이다. sending 유지 → idle 관찰 시 제거(확정). 타임아웃은 실패로 세지 않는다.
      const name = (error as { name?: string })?.name
      const code = ((error as { cause?: { code?: unknown } })?.cause?.code
        ?? (error as { code?: unknown })?.code) as string | undefined
      const connectError = typeof code === 'string'
        && ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED'].includes(code.toUpperCase())
      if (connectError) {
        // NW 단절: failed로 고정하지 않고 queued 유지 + 백오프만 — 네트워크 회복 시 자동 재개
        markHeadQueued(sessionID, next.id)
        failedUntil.set(sessionID, Date.now() + FLUSH_RETRY_BACKOFF_MS)
        logger.info(`Queued chat for session ${sessionID} connect error (${code}), keep queued for auto-retry after NW recovery`)
        return
      }
      if (name !== 'TimeoutError' && name !== 'AbortError') {
        recordFailure(sessionID, next.id)
      } else {
        failedUntil.set(sessionID, Date.now() + FLUSH_RETRY_BACKOFF_MS)
      }
    })
    .finally(() => {
      inFlight.delete(sessionID)
      inFlightControllers.delete(sessionID)
    })
}

function recordFailure(sessionID: string, id: string): void {
  const count = (failCount.get(sessionID) ?? 0) + 1
  failCount.set(sessionID, count)
  const queue = queues.get(sessionID)
  const head = queue?.[0]?.id === id ? queue[0] : undefined
  if (head) {
    head.attempts = (head.attempts ?? 0) + 1
    head.failedAt = Date.now()
  }
  if (count >= MAX_CONSECUTIVE_FAILURES) {
    if (head) {
      head.status = 'failed'
    }
    logger.error(`Queued chat for session ${sessionID} failed ${count} times in a row; marked failed, auto-retry stopped`)
    // 서버 응답 없음 등으로 큐가 failed가 되면 Cancelled 배찌가 다음 채팅 전까지 유지되게 DB에도 저장
    try { if (queueDb) setSessionCancelled(queueDb, sessionID) } catch {}
    return
  }
  markHeadQueued(sessionID, id)
  failedUntil.set(sessionID, Date.now() + FLUSH_RETRY_BACKOFF_MS)
}

/**
 * provider가 히스토리의 reasoning 암호문을 거부한 경우
 * (Anthropic `encrypted_content was not issued to this caller` 등).
 * 모델 전환·중간 네트워크 실패 뒤 이전 모델의 reasoning 블록이 히스토리에
 * 남아 있으면 발생한다. 같은 요청을 반복해도 절대 성공하지 않으므로
 * 쿨다운 재시도를 건너뛰고 즉시 failed로 고정한다. 복구는 사용자가
 * 가위(truncate)로 마지막 턴을 잘라내거나 원래 모델로 되돌린 뒤 수동 retry.
 */
export function isReasoningEncryptedMismatch(bodyText: string): boolean {
  return isReasoningMismatchText(bodyText)
}

function recordDeterministicFailure(sessionID: string, id: string, detail?: string): void {
  failCount.set(sessionID, MAX_CONSECUTIVE_FAILURES)
  const queue = queues.get(sessionID)
  const head = queue?.[0]?.id === id ? queue[0] : undefined
  if (head) {
    head.status = 'failed'
    head.attempts = (head.attempts ?? 0) + 1
    head.failedAt = Date.now()
  }
  logger.error(
    `Queued chat for session ${sessionID} rejected (non-retryable provider error). ` +
    (detail && isQuotaRejection(undefined, detail)
      ? `Free quota/balance exhausted — add credits or switch provider/model. `
      : `Stale reasoning blocks? Pick one: (a) switch back to the model that owns the latest good turn, (b) truncate back before the model switch with the per-message scissors, or (c) start a new session. ` +
        `Manual deep-clean: POST /api/session-heal/${sessionID}. `) +
    `Then retry manually.${detail ? ` Detail: ${detail.slice(0, 200)}` : ''}`,
  )
  try { if (queueDb) setSessionCancelled(queueDb, sessionID) } catch {}
}

function removeHeadIf(sessionID: string, id: string): void {
  const queue = queues.get(sessionID)
  if (!queue || queue[0]?.id !== id) return
  queue.splice(0, 1)
  if (queue.length === 0) {
    queues.delete(sessionID)
    queueDirs.delete(sessionID)
  }
}

function markHeadQueued(sessionID: string, id: string): void {
  const queue = queues.get(sessionID)
  if (!queue || queue[0]?.id !== id) return
  queue[0]!.status = 'queued'
}

function normalizeQueueText(text: string): string {
  return text.trim().slice(0, MAX_TEXT_LENGTH)
}

/**
 * 직접전송(proxy) 성공 시 동일 텍스트의 고아 항목을 제거한다.
 * 큐 제거가 confirm-based(자기 디스패치 성공 때만 제거)라 직접전송으로
 * 이미 전달된 텍스트의 큐 복사본이 failed 배지·X/재시도로 영원히 남거나,
 * 다음 idle에 중복 턴으로 재전송되던 문제 대응. 발송 중(sending)은 이미
 * opencode로 넘어가 회수 불가이므로 제외한다.
 * 제거된 항목 수를 돌려준다.
 */
export function dropDeliveredDuplicates(sessionID: string, text: string): number {
  const norm = normalizeQueueText(text ?? '')
  if (!norm) return 0
  const queue = queues.get(sessionID)
  if (!queue || queue.length === 0) return 0
  let removed = 0
  for (let i = queue.length - 1; i >= 0; i--) {
    const item = queue[i]
    if (!item || item.status === 'sending') continue
    if (normalizeQueueText(item.text) === norm) {
      queue.splice(i, 1)
      removed++
    }
  }
  if (queue.length === 0) {
    queues.delete(sessionID)
    queueDirs.delete(sessionID)
  }
  if (removed > 0) {
    // 고아를 치웠으니 실패 카운트·백오프도 초기화 — 남은 항목이 있으면
    // 다음 폴러에 바로 재시도된다 (stale 실패 상태 고착 방지).
    failCount.delete(sessionID)
    failedUntil.delete(sessionID)
    logger.info(`Dropped ${removed} delivered duplicate(s) for session ${sessionID} after direct-send success`)
  }
  return removed
}

/** 수동 재시도: sending/failed 항목을 queued로 되돌리고 즉시 발송 시도.
 *  sending 고착(nw오류 후 limbo)·상한 초과 failed 모두 대상. 순서 유지를 위해
 *  헤드가 아니면 queued로만 되돌리고, 헤드면 dispatchHead 즉시 호출. */
export function retryQueuedChat(sessionID: string, id: string): QueuedChat[] | null {
  const queue = queues.get(sessionID)
  if (!queue) return null
  const item = queue.find((entry) => entry.id === id)
  if (!item) return null
  if (item.status !== 'sending' && item.status !== 'failed') return [...queue]
  if (item.status === 'sending') {
    // 고착된 발송을 재시도하기 전 진행 중 fetch를 끊는다 — 중복 턴 방지.
    abortInFlight(sessionID)
  }
  item.status = 'queued'
  delete item.failedAt
  delete item.sendingSince
  failedUntil.delete(sessionID)
  failCount.delete(sessionID)
  logger.info(`Manual retry of queued chat for session ${sessionID} (id ${id})`)
  if (queue[0]?.id === id) {
    void dispatchHead(opencodeServerManager.getUrl(), sessionID)
  }
  return [...queue]
}

/**
 * 세션이 실제 working 중인지 확인한다. 이전 답변이 끝나기 전에 큐 헤드를 미리
 * 밀어넣지 않도록 dispatchHead 가 매 발송 전 호출한다.
 * - 세션의 실제 디렉터리로 조회한다 (workspace 고정 조회는 repo 세션을 idle 로 오판).
 * - generation(busy)뿐 아니라 승인 대기(permission/question)도 working 으로 취급해
 *   working이 끝난 뒤에 발송한다.
 * - 상태를 확인할 수 없으면 보수적으로 busy 로 취급해 발송을 보류한다
 *   (상태 폴러가 idle 전환 후 재시도).
 */
/** 큐 저장 → DB(session_status) → workspace 순으로 세션의 실제 디렉터리를 구한다.
 *  프론트가 구버전이라 directory 없이 enqueue해도 DB에서 찾아 오판을 막는다.
 *  저장된 절대경로는 resolveLiveDirectory 로 현재 기준으로 재해석한다
 *  (프로젝트 폴더명 변경 후 stale 경로로 opencode 를 때리는 것을 방지). */
function resolveQueueDir(sessionID: string): string {
  const remembered = queueDirs.get(sessionID)
  if (remembered) {
    try {
      if (existsSync(remembered)) return remembered
    } catch {
      return remembered
    }
  }
  try {
    if (queueDb) {
      const row = getSessionStatusRow(queueDb, sessionID)
      if (row?.directory) return resolveLiveDirectory(queueDb, row.directory, row.repoId)
    }
  } catch {}
  return remembered ?? getWorkspacePath()
}

async function checkOpencodeBusy(base: string, directoryParam: string, sessionID: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/session/status?directory=${directoryParam}`, {
      headers: ensureServerAuth({}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return true // 보수적: 상태 불명확 시 busy로 가정해 발송 보류 (NW 단절 시 idle 오판 방지)
    const map = (await res.json()) as Record<string, { type?: string }>
    return map[sessionID]?.type === 'busy'
  } catch {
    return true // NW 단절·타임아웃 시 busy로 가정해 sending을 제거하지 않고 queued 발송도 보류
  }
}

async function isSessionBusy(sessionID: string): Promise<boolean> {
  if (quickModeSessions.has(sessionID)) return false
  if (recentlyAbortedBackend.has(sessionID)) return false
  const base = opencodeServerManager.getUrl()
  const directory = resolveQueueDir(sessionID)
  const directoryParam = encodeURIComponent(directory)
  // status/permission/question을 병렬 조회 — 순차 3연속 타임아웃(최대 6s)이
  // cancel 직후 opencode가 느릴 때 큐를 장시간 묶어두던 원인
  const [opencodeBusy, pending] = await Promise.all([
    checkOpencodeBusy(base, directoryParam, sessionID),
    hasPendingInteraction(base, directory, sessionID),
  ])
  if (opencodeBusy || pending) return true
  // Quick mode: generation 끝마다 큐 투입 — DB busy(working 전체)는 무시
  if (quickModeSessions.has(sessionID)) return false
  // Normal mode도 opencode가 idle이면 바로 발송 — DB staleness로 sending이 남아 working 계속 뜨던 버그 방지
  return false
}

/** 승인 대기(permission/question) 중인 세션은 생성 중이 아니어도 working 으로 취급한다. */
async function hasPendingInteraction(base: string, directory: string, sessionID: string): Promise<boolean> {
  const directoryParam = encodeURIComponent(directory)
  const results = await Promise.all((['permission', 'question'] as const).map(async (kind) => {
    try {
      const res = await fetch(`${base}/${kind}?directory=${directoryParam}`, {
        headers: ensureServerAuth({}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) return true // 보수적: 조회 실패 시 working으로 가정
      const list = (await res.json()) as Array<{ sessionID?: string }>
      return Array.isArray(list) && list.some((item) => item?.sessionID === sessionID)
    } catch {
      return true // NW 단절 시 working으로 가정해 발송 보류
    }
  }))
  return results.some(Boolean)
}

/** 세션 상태 폴러(1s)가 매 틱 호출한다. idle 세션의 큐 헤드를 순차 발송한다. */
export function flushReadyQueues(busySessions: Set<string>): void {
  pruneIdleSessionState()
  if (queues.size === 0) return
  const base = opencodeServerManager.getUrl()

  for (const [sessionID] of [...queues]) {
    if (busySessions.has(sessionID)) {
      lastBusyAt.set(sessionID, Date.now())
      continue
    }
    void dispatchHead(base, sessionID)
  }
}

/** 큐가 사라진 세션의 보조 상태는 정리한다 (세션ID별 무한 누적 방지).
 *  숫자 몇 개 수준이지만 장시간 uptime에서 쌓인다. */
const IDLE_STATE_TTL_MS = 60 * 60 * 1000
function pruneIdleSessionState(): void {
  const now = Date.now()
  for (const [sid, until] of failedUntil) {
    if (!queues.has(sid) && until <= now) failedUntil.delete(sid)
  }
  for (const [sid, at] of lastBusyAt) {
    if (!queues.has(sid) && now - at > IDLE_STATE_TTL_MS) lastBusyAt.delete(sid)
  }
}

/** 채팅 완료 이벤트로 1개 세션의 큐를 즉시 발송한다. 세션이 여전히 working 중이면 발송을 건너뛰고 폴러가 이어받는다. */
export function flushQueueForSession(sessionId: string, directory?: string): void {
  if (!queues.has(sessionId)) return
  if (inFlight.has(sessionId)) return
  if ((failedUntil.get(sessionId) ?? 0) > Date.now()) return
  if (directory) queueDirs.set(sessionId, directory)
  void dispatchHead(opencodeServerManager.getUrl(), sessionId)
}

interface DispatchResult {
  sent: boolean
  /** true면 재시도해도 절대 성공하지 않는 결정적 provider 거부 (reasoning 암호문 불일치 등) */
  nonRetryable?: boolean
  status?: number
  detail?: string
}

/**
 * 슬래시 커맨드/스킬 발송용 <memory-recall> 블록. preCommand 훅은 기록용이라
 * 여기서 만든 블록을 프롬프트에 붙일 수 없어 발송 직전에 직접 만든다
 * (원래 proxy에서 하던 주입이 큐 경로에서는 유실됐던 것 복구).
 * 없거나 꺼져 있으면 '' — 호출부가 원문 그대로 보낸다.
 */
async function recallBlockForSlash(directory: string, cmd: string, args: string, fullText: string): Promise<string> {
  try {
    if (!queueDb) return ''
    // 재시도 재진입 시 chat.text에는 블록이 있지만 args에는 없을 수 있어 전체 기준으로 검사
    if (fullText.includes('<memory-recall>')) return ''
    const { enabled, topK } = readRecallPrefs(queueDb)
    if (!enabled) return ''
    // 커맨드명은 가장 강한 컨텍스트 신호라 항상 포함 (preCommand의 쿼리와 동일)
    const q = `${cmd} ${args}`.trim().slice(0, 500)
    if (q.length < 2) return ''
    const repoId = directory ? resolveRepoId(queueDb, directory) : null
    const { block, hits } = buildRecall(queueDb, q, { k: topK, repoId: repoId ?? undefined, exactK: true })
    if (!block) return ''
    logger.info(`memory recall injected (queue command /${cmd}): ${hits.length} hit(s)`)
    return `${block}\n\n`
  } catch (e) {
    logger.debug('memory recall injection (queue command) skipped:', e)
    return ''
  }
}

/**
 * 스킬 템플릿 조회 — opencode /command 목록에서 같은 이름의 skill 항목을 찾는다.
 * 프론트가 보는 목록과 동일한 원천이라 템플릿이 항상 일치한다.
 * 없으면 '' — 호출부는 `/스킬 인자`만 보낸다.
 */
async function getSkillTemplate(base: string, directory: string, name: string): Promise<string> {
  try {
    const res = await fetch(`${base}/command?directory=${encodeURIComponent(directory)}`, {
      headers: ensureServerAuth({}),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return ''
    const list = (await res.json()) as Array<{ name?: string; source?: string; template?: string }>
    if (!Array.isArray(list)) return ''
    const hit = list.find((e) => e?.name === name && e?.source === 'skill')
      ?? list.find((e) => e?.name === name)
    return hit?.template ?? ''
  } catch {
    return ''
  }
}

/**
 * 턴 결과 판정 (2층) — 전달(HTTP 2xx)과 별개로 턴이 실제로 에러로 끝났는지 본다.
 * opencode는 provider 400을 HTTP 200 + 메시지 error로 저장하는 경로가 있어
 * 응답 코드만 보면 실패를 놓친다. 발송 시작 이후 생성된 마지막 assistant
 * 메시지의 info.error 존재 여부로 판정한다.
 * 조회 실패·이번 턴 산출 없음이면 null (fail-open — 전달 기준으로 유지).
 * 사용자 취소(MessageAbortedError)는 실패가 아니다.
 * 툴 호출 실패는 일부러 안 본다: 재시도·부분 실패는 정상 작업 과정이라
 * 실패로 세면 거의 모든 run이 실패가 된다.
 */
type TurnCheck =
  | { kind: 'error'; name: string }
  | { kind: 'clean' }
  | { kind: 'no-turn' }
  | { kind: 'unknown' }

async function checkTurnOnce(sessionID: string, sinceMs: number): Promise<TurnCheck> {
  try {
    const tail = await recentSessionMessages(sessionID, 5)
    // ASC 정렬(오래된 것 먼저)이라 뒤쪽이 이번 턴이다
    const msgs = (tail?.messages ?? []) as Array<{ info?: Record<string, unknown> }>
    for (let i = msgs.length - 1; i >= 0; i--) {
      const info = msgs[i]?.info
      if (info?.role !== 'assistant') continue
      const created = (info.time as { created?: number } | undefined)?.created ?? 0
      // 이번 턴 산물이 아니면 증거 없음으로 본다 (오래된 에러 턴 오탐 방지)
      if (created < sinceMs - 5_000) return { kind: 'no-turn' }
      const err = info.error as { name?: string } | undefined
      if (!err) return { kind: 'clean' }
      const name = typeof err.name === 'string' && err.name ? err.name : 'UnknownError'
      if (name === 'MessageAbortedError') return { kind: 'clean' }
      return { kind: 'error', name }
    }
    return { kind: 'no-turn' }
  } catch {
    return { kind: 'unknown' }
  }
}

async function checkTurnError(sessionID: string, sinceMs: number): Promise<string | null> {
  let r = await checkTurnOnce(sessionID, sinceMs)
  // 2xx 직후라 opencode가 DB 커밋을 안 끝냈을 수 있다 — 이번 턴 메시지가
  // 없으면 500ms 쉬고 한 번만 재조회한다. 조회 실패(unknown)는 재시도 없이 fail-open.
  if (r.kind === 'no-turn') {
    await new Promise((res) => setTimeout(res, 500))
    r = await checkTurnOnce(sessionID, sinceMs)
  }
  return r.kind === 'error' ? r.name : null
}

async function dispatchQueuedChat(
  base: string,
  sessionID: string,
  chat: QueuedChat,
): Promise<DispatchResult> {
  const headers = ensureServerAuth({})
  const directory = resolveQueueDir(sessionID)
  const directoryParam = encodeURIComponent(directory)
  const outgoing = asOutgoingModel(chat.model)
  // 턴 판정 기준시각 — 이 이후 생성된 assistant 메시지만 이번 턴 산물로 본다
  const dispatchStartMs = Date.now()
  // 중단 버튼이 이 발송을 실제로 끊을 수 있게 세션별 컨트롤러를 등록한다.
  // clearSendingOnAbort/clearQueuedChats가 abort하면 아래 fetch들이 즉시 취소된다.
  const dispatchAborter = new AbortController()
  inFlightControllers.set(sessionID, dispatchAborter)
  const combineSendSignal = (): AbortSignal => {
    const timeout = AbortSignal.timeout(SEND_HEADERS_TIMEOUT_MS)
    const maybeAny = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
    if (typeof maybeAny === 'function') return maybeAny([timeout, dispatchAborter.signal])
    if (dispatchAborter.signal.aborted) return dispatchAborter.signal
    timeout.addEventListener('abort', () => { try { dispatchAborter.abort(timeout.reason) } catch {} }, { once: true })
    return dispatchAborter.signal
  }

  // 발송 직전: 꼬리가 mismatch 에러면 strip-only 클렌징 (truncate 없음).
  // opencode가 provider 400을 HTTP 200 + 메시지 error로 저장하는 경로가 있어
  // 응답-기준 heal만으로는 복구가 안 된다. strip 후에는 인스턴스 reload로
  // opencode 메모리 캐시를 비워야 strip이 실제 전송에 반영된다.
  // knownIds: 발송 전 꼬리 id — 발송 후 fresh 판별용 (시계 대신 존재 비교).
  let knownIds = new Set<string>()
  try {
    const pre = await preSendStripIfMismatch(base, sessionID, directory, outgoing)
    knownIds = new Set(pre.tailIds ?? [])
    if ((pre.strippedParts ?? 0) > 0 || (pre.strippedAllParts ?? 0) > 0 || (pre.stubsRemoved ?? 0) > 0) {
      let reloaded = false
      try {
        reloaded = await opencodeServerManager.reloadAndVerify(directory)
      } catch (e) {
        logger.warn(`Pre-send strip instance reload threw for session ${sessionID}:`, e)
      }
      const kept = pre.keep ? `${pre.keep.providerID}/${pre.keep.modelID}` : 'unknown'
      logger.warn(`Pre-send strip for session ${sessionID}: stripped ${pre.strippedParts} reasoning part(s) in ${pre.strippedMessages} message(s), strip-all ${pre.strippedAllParts} part(s) in ${pre.strippedAllMessages} message(s), removed ${pre.stubsRemoved} stub(s), kept ${kept} — instance reload ${reloaded ? 'verified' : 'NOT verified, sending anyway'}`)
    }
  } catch (e) {
    logger.warn(`Pre-send strip check failed for session ${sessionID}:`, e)
  }

  // 저장된 mismatch 확인: HTTP 200으로 응답해도 provider 400이 메시지로 남을
  // 수 있다. 발송 전 꼬리에 없던 mismatch면 이번 턴 산물이다 (id 존재 비교 —
  // created 시계 오차에 영향받지 않는다).
  const checkStoredMismatch = async (): Promise<string | undefined> => {
    try {
      const tail = await recentSessionMessages(sessionID, 10)
      const msgs = (tail?.messages ?? []) as unknown as Parameters<typeof findNewMismatch>[0]
      const fresh = findNewMismatch(msgs, knownIds)
      if (!fresh) return undefined
      try {
        return JSON.stringify((fresh as { info?: { error?: unknown } }).info?.error ?? '')
      } catch {
        return 'reasoning mismatch (unserializable)'
      }
    } catch (e) {
      logger.warn(`Stored-mismatch check failed for session ${sessionID}:`, e)
      return undefined
    }
  };

  // 슬래시 커맨드는 /command 엔드포인트로 실행해야 실제 수행이 된다 — /message 로 보내면 LLM이 설명만 한다
  const trimmed = chat.text.trim()
  const cmdMatch = trimmed.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/)
  // /command 실패 시 /message 폴백에 붙일 recall (/command에는 arguments에 직접 붙인다)
  let slashRecall = ''
  // skill 합성문(`/스킬 인자` + skill-template 마커) — 있으면 /message 본문으로 쓴다.
  // 전송용 합성문(`/스킬 인자` + skill-template 마커) — 있으면 /message 본문으로 쓴다.
  // 스킬 run id — 아래 /message 결과에 따라 finish (post 훅·리뷰자식 연결).
  let messageTextOverride: string | null = null
  let pendingSkillRunId: string | null = null
  const finishPendingSkillRun = (delivered: boolean): void => {
    if (!pendingSkillRunId) return
    const id = pendingSkillRunId
    pendingSkillRunId = null
    const db = queueDb
    if (!db) return
    void import('./command-runs')
      .then(async ({ finishRunSafe }) => {
        // 2층 판정: 전달됐어도 턴이 에러로 끝났으면 failed
        let status: 'completed' | 'failed' = delivered ? 'completed' : 'failed'
        if (delivered) {
          const turnError = await checkTurnError(sessionID, dispatchStartMs)
          if (turnError) {
            status = 'failed'
            logger.warn(`Queued skill run ${id} delivered but turn errored (${turnError}) — marking failed`)
          }
        }
        return finishRunSafe(db, id, status)
      })
      .catch((e) => logger.debug('Skill run finish skipped:', e))
  }
  // 스킬 선처리: opencode /command로 스킬을 실행할 수 없다 (실측 500 UnknownError + 메시지 0건).
  // 템플릿을 직접 합성해 아래 공통 /message 꼬리로 보낸다. 첫 줄 `/스킬 인자`는
  // 채팅에 먼저 보이고, 템플릿은 skill-template 마커로 감싸 렌더러가 접힘 md 블록으로 그린다.
  if (cmdMatch) {
    const probe = (cmdMatch[1] ?? '').trim()
    if (probe) {
      try {
        const { resolveCommandKind } = await import('./command-hooks')
        if (resolveCommandKind(directory, probe) === 'skill') {
          const args = cmdMatch[2] ?? ''
          let recall = ''
          try {
            recall = await recallBlockForSlash(directory, probe, args, trimmed)
          } catch (e) {
            logger.debug(`Skill recall skipped for /${probe}:`, e)
          }
          const template = await getSkillTemplate(base, directory, probe)
          const head = args ? `/${probe} ${args}` : `/${probe}`
          const composed = template
            ? `${head}\n\n<!-- skill-template:${probe} -->\n${template.trim()}\n<!-- /skill-template -->`
            : head
          messageTextOverride = recall ? `${recall}${composed}` : composed
          // run 생애주기 소유권은 디스패치에 있다 — 스냅샷을 실어 기록한다.
          // 후크는 관측만 하며, idle 스캔 중복은 messageId로 걸러진다.
          try {
            if (queueDb) {
              const { recordRunStartSafe, resolveRepoId } = await import('./command-runs')
              const run = await recordRunStartSafe(queueDb, {
                sessionId: sessionID,
                commandName: probe,
                args: args.trim() || null,
                directory,
                repoId: resolveRepoId(queueDb, directory),
                origin: 'chat',
                kind: 'skill',
                reviewWanted: chat.reviewWanted,
                autoApply: chat.autoApply,
              })
              pendingSkillRunId = run?.id ?? null
            }
          } catch (e) {
            logger.debug(`Skill run record skipped for /${probe}:`, e)
          }
          logger.info(`Queued skill /${probe} composed for /message (template ${template ? `${template.length} chars` : 'missing'})`)
        }
      } catch (e) {
        logger.debug('Skill pre-resolve skipped:', e)
      }
    }
  }
  if (cmdMatch && !messageTextOverride) {
    const cmd = cmdMatch[1] ?? ''
    const args = cmdMatch[2] ?? ''
    try {
      const { TODO_PROTOCOL, resolveCommandKind } = await import('./command-hooks')
      const kind = resolveCommandKind(directory, cmd)
      // todo 프로토콜은 command에만 덧붙인다. skill은 자체 실행 흐름이 있어
      // 프로토콜을 붙이면 간섭한다.
      const withProtocol = kind === 'command'
      let argsWithProtocol = !withProtocol
        ? args
        : args.trim() ? `${args.trim()}\n\n${TODO_PROTOCOL}` : TODO_PROTOCOL
      // 메모리 주입: preCommand 훅은 기록용이라 블록을 버리므로 발송 직전에 직접 주입
      // (command/skill 공통 — TODO 프로토콜과 달리 recall은 스킬에도 간섭 없음).
      // arguments에 붙여야 /command 실행이 컨텍스트를 본다.
      const recall = await recallBlockForSlash(directory, cmd, args, trimmed)
      if (recall) {
        argsWithProtocol = `${recall}${argsWithProtocol}`
        slashRecall = recall
      }
      // run 생애주기 소유권은 디스패치에 있다 — 스냅샷을 실어 기록한다.
      // 후크는 관측만 하며, 외부 실행은 origin='external'로 따로 기록한다.
      let runId: string | null = null
      try {
        if (queueDb) {
          const { recordRunStartSafe, resolveRepoId } = await import('./command-runs')
          const run = await recordRunStartSafe(queueDb, {
            sessionId: sessionID,
            commandName: cmd,
            args: args.trim() || null,
            directory,
            repoId: resolveRepoId(queueDb, directory),
            origin: 'chat',
            kind,
            reviewWanted: chat.reviewWanted,
            autoApply: chat.autoApply,
          })
          runId = run?.id ?? null
        }
      } catch (e) {
        logger.debug(`Command run record skipped for /${cmd}:`, e)
      }
      const cmdBody: Record<string, unknown> = { command: cmd, arguments: argsWithProtocol }
      if (chat.agent) cmdBody.agent = chat.agent
      if (chat.model) cmdBody.model = `${chat.model.providerID}/${chat.model.modelID}`
      const cmdRes = await fetch(`${base}/session/${sessionID}/command?directory=${directoryParam}`, {
        method: 'POST',
        headers: ensureServerAuth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(cmdBody),
        signal: combineSendSignal(),
      })
      if (cmdRes.ok) {
        void cmdRes.text().catch(() => {})
        logger.info(`Queued command /${cmd} dispatched via /command for session ${sessionID}`)
        try {
          if (queueDb && runId) {
            const { finishRunSafe } = await import('./command-runs')
            // 2층 판정: 2xx여도 턴이 에러로 끝났으면 failed (provider 400 저장 경로 대응)
            const turnError = await checkTurnError(sessionID, dispatchStartMs)
            if (turnError) {
              logger.warn(`Queued command /${cmd} accepted but turn errored (${turnError}) — marking failed`)
            }
            await finishRunSafe(queueDb, runId, turnError ? 'failed' : 'completed')
          }
        } catch (e) {
          logger.debug(`Command run finish skipped for /${cmd}:`, e)
        }
        return { sent: true }
      }
      const body = await cmdRes.text().catch(() => '')
      // quota/결제 거부는 /message로 폴백해도 같은 결과라 즉시 failed로 고정한다.
      if (isQuotaRejection(cmdRes.status, body)) {
        try {
          if (queueDb && runId) {
            const { finishRunSafe } = await import('./command-runs')
            await finishRunSafe(queueDb, runId, 'failed')
          }
        } catch {}
        finishPendingSkillRun(false)
        logger.warn(`Queued command /${cmd} rejected with quota/billing HTTP ${cmdRes.status} — marked failed without retry`)
        return { sent: false, nonRetryable: true, status: cmdRes.status, detail: body.slice(0, 300) }
      }
      try {
        if (queueDb && runId) {
          const { finishRunSafe } = await import('./command-runs')
          await finishRunSafe(queueDb, runId, 'failed')
        }
      } catch {}
      // mismatch여도 여기서 끝내지 않고 /message로 폴백한다 — 아래 /message 경로에서
      // heal(꼬리 절단)+1회 재시도를 탄다. 커맨드가 아니면 어차피 폴백하던 경로.
      // 커맨드가 아니거나 서버가 모르면 /message 로 폴백
      logger.warn(`Queued command /${cmd} via /command rejected HTTP ${cmdRes.status} ${body.slice(0, 200)} — fallback to /message`)
    } catch (e) {
      logger.warn(`Queued command /${cmdMatch[1]} dispatch error, fallback to /message:`, e)
    }
  }

  // 직전 스킬/커맨드 완료에 대한 부모 skill-memory-check (pending이 있을 때만 1회 주입).
  // 리뷰 자식이 생성됐으면 spawn 시점에 consume되므로 여기서는 붙지 않는다.
  // 슬래시 호출에만 붙인다 — 일반 채팅에 붙으면 무관한 턴을 스킬 평가로 오염시킨다.
  // pending은 유지되므로 다음 슬래시 호출 때 전달된다 (TTL 5분).
  // /command 실패 폴백용 recall을 먼저 붙이고 skill을 그 앞에 — proxy와 같은 순서.
  let outgoingText = messageTextOverride ?? chat.text
  if (slashRecall && !outgoingText.includes('<memory-recall>')) {
    outgoingText = `${slashRecall}${outgoingText}`
  }
  const isSlashSend = trimmed.startsWith('/')
  try {
    const { buildSkillCheckBlock } = await import('./command-hooks')
    const { resolveRepoId } = await import('./command-runs')
    if (queueDb && isSlashSend) {
      const block = buildSkillCheckBlock({
        sessionId: sessionID,
        repoId: resolveRepoId(queueDb, directory),
        db: queueDb,
      })
      if (block) outgoingText = `${block}${outgoingText}`
    }
  } catch (e) {
    logger.debug(`Skill-check injection skipped for session ${sessionID}:`, e)
  }
  // S3: workspace 규약 주입 — 큐 경로(주 발송로)에도 세션 레포 한 줄을 붙인다.
  try {
    if (queueDb && !outgoingText.includes('<workspace-scope>')) {
      const { buildWorkspaceScopeBlock } = await import('./workspace-scope')
      const wsBlock = buildWorkspaceScopeBlock(queueDb, sessionID, directory)
      if (wsBlock) outgoingText = `${wsBlock}${outgoingText}`
    }
  } catch (e) {
    logger.debug(`Workspace scope injection skipped for session ${sessionID}:`, e)
  }
  const messageBody: Record<string, unknown> = { parts: [{ type: 'text', text: outgoingText }] }
  if (chat.agent) messageBody.agent = chat.agent
  if (chat.model) messageBody.model = chat.model

  // security/reasoning 암호문 거부 때만 자동 정리 후 1회 재전송.
  // 정책: 정리(마지막 턴 절단 + 외국 strip + strip-all + sweep)가 실제로
  // 일어났을 때만 정확히 1회 재전송하고, 그래도 같은 400이면 failed로 남긴다.
  // 자동 deep-truncate·연속 재시도 없음 — 동일 텍스트가 새 턴으로 반복 생성돼
  // 세션을 도배하던 retry storm 대응. 그 이상은 사용자 가위·수동 retry 영역.
  // DB만 자르면 opencode 메모리 캐시가 오염 part를 그대로 보내므로
  // 재전송 전에 해당 directory 인스턴스를 dispose해 캐시를 비운다.
  // providerDetail 출처 2가지: HTTP 400 본문, 또는 HTTP 200 + 저장된 메시지 error.
  const healMismatchAndRetryOnce = async (providerDetail: string): Promise<DispatchResult> => {
    const url = `${base}/session/${sessionID}/message?directory=${directoryParam}`
    const sendOnce = async () => fetch(url, {
      method: 'POST',
      headers: ensureServerAuth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(messageBody),
      signal: combineSendSignal(),
    })
    const reloadTag = async (tag: string) => {
      try {
        const reloaded = await opencodeServerManager.reloadAndVerify(directory)
        logger.warn(`Reasoning heal ${tag}: session ${sessionID} — instance reload ${reloaded ? 'verified' : 'NOT verified, retrying anyway'}`)
      } catch (e) {
        logger.warn(`Reasoning heal ${tag}: instance reload threw for session ${sessionID}, retrying anyway:`, e)
      }
    }
    // HTTP 200이어도 provider 400이 메시지로 저장될 수 있어, 발송 성공으로
    // 단정하지 않고 방금 턴의 저장된 mismatch를 확인한다. 있으면 그 본문을 돌려준다.
    const storedMismatchAfterOk = async (res: Response): Promise<string | undefined> => {
      void res.text().catch(() => {})
      return checkStoredMismatch()
    }
    const mismatchDetailOf = async (res: Response): Promise<string | undefined> => {
      if (res.ok) return storedMismatchAfterOk(res)
      const body = await res.text().catch(() => '')
      if (res.status === 400 && isReasoningEncryptedMismatch(body)) return body
      return undefined
    }
    try {
      const heal = await healReasoningTail(base, sessionID, directory, [messageTextOverride ?? chat.text], { force: true, outgoingModel: outgoing })
      if (!heal.healed && heal.kind === 'cross-model') {
        // keep(보내려는 모델)을 못 정해 strip 없이 끝난 경우 — truncate+재시도로
        // 해결 불가이므로 안내만 돌려주고 끝낸다 (자동 원복 없음: 모델 선택은 사용자 몫).
        const names = (heal.models ?? []).map((m) => `${m.providerID}/${m.modelID}`).join(', ')
        const back = heal.suggestedModel ? `${heal.suggestedModel.providerID}/${heal.suggestedModel.modelID}` : null
        const guidance =
          `Cross-model reasoning history [${names}]. Truncating cannot help — pick one:` +
          (back ? ` (a) switch back to ${back},` : ` (a) switch back to the model that owns the latest good turn,`) +
          ` (b) truncate back before the model switch (per-message scissors), or (c) start a new session.` +
          ` Manual deep-clean: POST /api/session-heal/${sessionID}.`
        logger.warn(`Queued chat cross-model mismatch for session ${sessionID}: ${guidance}`)
        return { sent: false, nonRetryable: true, status: 400, detail: (providerDetail.slice(0, 300) + ' ' + guidance) }
      }
      if (!heal.healed) {
        logger.warn(`Reasoning heal skipped for queued chat (session ${sessionID}): ${heal.reason}`)
        return { sent: false, nonRetryable: true, status: 400, detail: providerDetail.slice(0, 300) }
      }
      // 단일 정리 추가분: 동일모델 stale 대응 strip-all + sweep (최신 턴은 보존).
      // 남은 stub이 있으면 재전송이 같은 400을 맞을 수 있어 명시한다.
      let strippedAllParts = 0
      try {
        const stripAll = await stripAllReasoningParts(sessionID)
        strippedAllParts = stripAll?.partsRemoved ?? 0
      } catch (e) {
        logger.warn(`Reasoning heal strip-all threw for session ${sessionID}:`, e)
      }
      const sweep2 = await sweepPollutedStubs(sessionID)
      const pending = [...(heal.stubsPending ?? []), ...sweep2.pending]
      const stubsRemoved = (heal.stubsRemoved ?? 0) + sweep2.removed
      await reloadTag(`cleanup (truncated ${heal.truncatedMessageId}, stripped ${heal.strippedParts ?? 0}, strip-all ${strippedAllParts}, stubs removed ${stubsRemoved}, pending ${pending.length})`)
      const retryRes = await sendOnce()
      if (!retryRes.ok) {
        // 본문은 한 번만 읽힌다 — quota 판정과 mismatch 판정에 같은 본문을 쓴다.
        const retryBody = await retryRes.text().catch(() => '')
        if (isQuotaRejection(retryRes.status, retryBody)) {
          logger.warn(`Queued chat heal-retry hit quota/billing HTTP ${retryRes.status} for session ${sessionID} — leaving failed`)
          return { sent: false, nonRetryable: true, status: retryRes.status, detail: retryBody.slice(0, 300) }
        }
        if (retryRes.status !== 400 || !isReasoningEncryptedMismatch(retryBody)) {
          return { sent: false, status: retryRes.status }
        }
        logger.warn(`Queued chat cleanup+retry hit the same mismatch for session ${sessionID} — leaving failed (no further auto-retry)`)
        return { sent: false, nonRetryable: true, status: 400, detail: retryBody.slice(0, 300) }
      }
      const retryMismatch = await mismatchDetailOf(retryRes)
      if (!retryMismatch) {
        logger.info(`Reasoning heal: cleanup and queue retry succeeded for session ${sessionID}`)
        return { sent: true }
      }
      logger.warn(`Queued chat cleanup+retry hit the same mismatch for session ${sessionID} — leaving failed (no further auto-retry)`)
      return { sent: false, nonRetryable: true, status: 400, detail: retryMismatch.slice(0, 300) }
    } catch (e) {
      logger.warn(`Reasoning heal attempt failed for queued chat (session ${sessionID}):`, e)
    }
    return { sent: false, nonRetryable: true, status: 400, detail: providerDetail.slice(0, 300) }
  };

  const sendRes = await fetch(`${base}/session/${sessionID}/message?directory=${directoryParam}`, {
    method: 'POST',
    headers: ensureServerAuth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(messageBody),
    signal: combineSendSignal(),
  })

  if (!sendRes.ok) {
    const body = await sendRes.text().catch(() => '')
    logger.warn(`Queued chat flush rejected for session ${sessionID}: HTTP ${sendRes.status} ${body.slice(0, 200)}`)
    if (isQuotaRejection(sendRes.status, body)) {
      logger.warn(`Queued chat hit quota/billing HTTP ${sendRes.status} for session ${sessionID} — marked failed without retry`)
      finishPendingSkillRun(false)
      return { sent: false, nonRetryable: true, status: sendRes.status, detail: body.slice(0, 300) }
    }
    if (sendRes.status === 400 && isReasoningEncryptedMismatch(body)) {
      const healed = await healMismatchAndRetryOnce(body)
      finishPendingSkillRun(healed.sent)
      return healed
    }
    finishPendingSkillRun(false)
    return { sent: false, status: sendRes.status }
  }
  // Drain the body so the socket is released even if the server keeps it open.
  void sendRes.text().catch(() => {})
  // HTTP 200이어도 provider 400이 메시지로 저장될 수 있다 — 꼬리 확인 후 heal+1회 재시도.
  const stored = await checkStoredMismatch()
  if (stored && isReasoningEncryptedMismatch(stored)) {
    logger.warn(`Queued chat send returned 2xx but stored a provider mismatch for session ${sessionID} — running heal+retry once`)
    const healed = await healMismatchAndRetryOnce(stored)
    finishPendingSkillRun(healed.sent)
    return healed
  }
  finishPendingSkillRun(true)
  return { sent: true }
}
