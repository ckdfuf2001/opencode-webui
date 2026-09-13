import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { opencodeServerManager } from './opencode-single-server'
import { ensureServerAuth } from './opencode-auth'
import { getWorkspacePath } from '@opencode-webui/shared'
import { getSessionStatusRow, setSessionCancelled } from '../db/session-status-queries'
import { resolveLiveDirectory } from './command-runs'
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
}

export interface EnqueueOptions {
  model?: { providerID: string; modelID: string }
  agent?: string
}

const MAX_QUEUE_LENGTH = 20
const MAX_TEXT_LENGTH = 16_000
const REQUEST_TIMEOUT_MS = 1_500
const SEND_HEADERS_TIMEOUT_MS = 90_000
const FLUSH_RETRY_BACKOFF_MS = 2_000

// In-memory, per-session FIFO of user messages typed while the assistant was
// still generating. The session status poller (2s) flushes them one at a time
// whenever the session is idle again. Lost on backend restart by design.
const queues = new Map<string, QueuedChat[]>()
const failedUntil = new Map<string, number>()
// 연속 실패 횟수. 상한을 넘기면 failed로 고정하고 자동 재시도를 멈춘다
// (폴더명 변경 등으로 디렉터리가 깨졌을 때 수십 번 중복 발송 방지).
// failed 헤드는 순서 유지를 위해 다음 항목을 막는다. 사용자가 X로 지우면 해제.
const failCount = new Map<string, number>()
const MAX_CONSECUTIVE_FAILURES = 1
const inFlight = new Set<string>()
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
  queue.splice(index, 1)
  if (queue.length === 0) {
    queues.delete(sessionID)
    queueDirs.delete(sessionID)
    failCount.delete(sessionID)
    failedUntil.delete(sessionID)
  }
  return true
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

/** 중단(abort) 시 호출: 세션의 대기열 전체를 비운다. */
export function clearQueuedChats(sessionID: string): number {
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
  // failed는 자동 재시도 안 함. 순서 유지를 위해 뒤 항목도 막는다. X로 직접 지워야 해제.
  if (next.status === 'failed') return
  if (next.status === 'sending') {
    // 전송은 됐는데 응답 미확인 상태. 세션이 idle이면 턴이 끝난 것으로 보고 제거(확정).
    if (await isSessionBusy(sessionID)) {
      lastBusyAt.set(sessionID, Date.now())
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

  inFlight.add(sessionID)
  logger.info(`Dispatching queued chat to session ${sessionID}; ${listQueuedChats(sessionID).length} remaining`)

  void dispatchQueuedChat(base, sessionID, next)
    .then((sent) => {
      if (sent) {
        removeHeadIf(sessionID, next.id)
        failedUntil.delete(sessionID)
        failCount.delete(sessionID)
        logger.info(`Flushed queued chat to session ${sessionID}; ${listQueuedChats(sessionID).length} remaining`)
      } else {
        recordFailure(sessionID, next.id)
      }
    })
    .catch((error) => {
      logger.warn(`Queued chat flush errored for session ${sessionID}:`, error)
      // OpenCode는 턴이 끝나야 응답 헤더를 보낼 수 있어 타임아웃은 거의 확실히
      // 전달됐다는 뜻이다. sending 유지 → idle 관찰 시 제거(확정). 타임아웃은 실패로 세지 않는다.
      // 연결 자체가 안 됐거나 그 외 에러는 실패로 센다 (중복 전송 방지 + 상한).
      const name = (error as { name?: string })?.name
      const code = ((error as { cause?: { code?: unknown } })?.cause?.code
        ?? (error as { code?: unknown })?.code) as string | undefined
      const connectError = typeof code === 'string'
        && ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(code.toUpperCase())
      if (connectError || (name !== 'TimeoutError' && name !== 'AbortError')) {
        recordFailure(sessionID, next.id)
      } else {
        failedUntil.set(sessionID, Date.now() + FLUSH_RETRY_BACKOFF_MS)
      }
    })
    .finally(() => {
      inFlight.delete(sessionID)
    })
}

function recordFailure(sessionID: string, id: string): void {
  const count = (failCount.get(sessionID) ?? 0) + 1
  failCount.set(sessionID, count)
  if (count >= MAX_CONSECUTIVE_FAILURES) {
    const queue = queues.get(sessionID)
    if (queue && queue[0]?.id === id) {
      queue[0]!.status = 'failed'
    }
    logger.error(`Queued chat for session ${sessionID} failed ${count} times in a row; marked failed, auto-retry stopped`)
    // 서버 응답 없음 등으로 큐가 failed가 되면 Cancelled 배찌가 다음 채팅 전까지 유지되게 DB에도 저장
    try { if (queueDb) setSessionCancelled(queueDb, sessionID) } catch {}
    return
  }
  markHeadQueued(sessionID, id)
  failedUntil.set(sessionID, Date.now() + FLUSH_RETRY_BACKOFF_MS)
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
    if (!res.ok) return true
    const map = (await res.json()) as Record<string, { type?: string }>
    return map[sessionID]?.type === 'busy'
  } catch {
    return true
  }
}

async function isSessionBusy(sessionID: string): Promise<boolean> {
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
  // Quick mode: generation 끝마다 큐 투입 — DB busy(working 전체)는 무시하고 opencode busy만 본다
  if (quickModeSessions.has(sessionID)) return false
  // DB(session_status)도 본다 — 프론트 Working 배지와 같은 소스라 working이
  // 끝난 뒤에 발송된다. opencode 순간 장애·전이 구간의 오판을 막는다.
  try {
    const row = queueDb?.query('SELECT status FROM session_status WHERE session_id = ?').get(sessionID) as { status?: string } | undefined
    if (row?.status === 'busy') return true
  } catch {}
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
      if (!res.ok) return false
      const list = (await res.json()) as Array<{ sessionID?: string }>
      return Array.isArray(list) && list.some((item) => item?.sessionID === sessionID)
    } catch {
      // 조회 실패는 working 아님으로 간주하고 다음으로 (보수적 차단은 status 체크가 담당)
      return false
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

async function dispatchQueuedChat(
  base: string,
  sessionID: string,
  chat: QueuedChat,
): Promise<boolean> {
  const headers = ensureServerAuth({})
  const directory = resolveQueueDir(sessionID)
  const directoryParam = encodeURIComponent(directory)

  // 슬래시 커맨드는 /command 엔드포인트로 실행해야 실제 수행이 된다 — /message 로 보내면 LLM이 설명만 한다
  const trimmed = chat.text.trim()
  const cmdMatch = trimmed.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/)
  if (cmdMatch) {
    const cmd = cmdMatch[1] ?? ''
    const args = cmdMatch[2] ?? ''
    try {
      const cmdBody: Record<string, unknown> = { command: cmd, arguments: args }
      if (chat.agent) cmdBody.agent = chat.agent
      if (chat.model) cmdBody.model = `${chat.model.providerID}/${chat.model.modelID}`
      const cmdRes = await fetch(`${base}/session/${sessionID}/command?directory=${directoryParam}`, {
        method: 'POST',
        headers: ensureServerAuth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(cmdBody),
        signal: AbortSignal.timeout(SEND_HEADERS_TIMEOUT_MS),
      })
      if (cmdRes.ok) {
        void cmdRes.text().catch(() => {})
        logger.info(`Queued command /${cmd} dispatched via /command for session ${sessionID}`)
        return true
      }
      const body = await cmdRes.text().catch(() => '')
      // 커맨드가 아니거나 서버가 모르면 /message 로 폴백
      logger.warn(`Queued command /${cmd} via /command rejected HTTP ${cmdRes.status} ${body.slice(0, 200)} — fallback to /message`)
    } catch (e) {
      logger.warn(`Queued command /${cmdMatch[1]} dispatch error, fallback to /message:`, e)
    }
  }

  const messageBody: Record<string, unknown> = { parts: [{ type: 'text', text: chat.text }] }
  if (chat.agent) messageBody.agent = chat.agent
  if (chat.model) messageBody.model = chat.model
  const sendRes = await fetch(`${base}/session/${sessionID}/message?directory=${directoryParam}`, {
    method: 'POST',
    headers: ensureServerAuth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(messageBody),
    signal: AbortSignal.timeout(SEND_HEADERS_TIMEOUT_MS),
  })

  if (!sendRes.ok) {
    const body = await sendRes.text().catch(() => '')
    logger.warn(`Queued chat flush rejected for session ${sessionID}: HTTP ${sendRes.status} ${body.slice(0, 200)}`)
    return false
  }
  // Drain the body so the socket is released even if the server keeps it open.
  void sendRes.text().catch(() => {})
  return true
}
