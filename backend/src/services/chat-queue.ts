import { opencodeServerManager } from './opencode-single-server'
import { ensureServerAuth } from './opencode-auth'
import { getWorkspacePath } from '@opencode-webui/shared'
import { logger } from '../utils/logger'

export interface QueuedChat {
  id: string
  text: string
  createdAt: number
}

const MAX_QUEUE_LENGTH = 20
const MAX_TEXT_LENGTH = 16_000
const REQUEST_TIMEOUT_MS = 4_000
const SEND_HEADERS_TIMEOUT_MS = 30_000
const FLUSH_RETRY_BACKOFF_MS = 15_000

// In-memory, per-session FIFO of user messages typed while the assistant was
// still generating. The session status poller (2s) flushes them one at a time
// whenever the session is idle again. Lost on backend restart by design.
const queues = new Map<string, QueuedChat[]>()
const failedUntil = new Map<string, number>()
const inFlight = new Set<string>()

export function listQueuedChats(sessionID: string): QueuedChat[] {
  return queues.get(sessionID) ?? []
}

export function enqueueQueuedChat(sessionID: string, text: string): QueuedChat[] {
  const trimmed = text.trim().slice(0, MAX_TEXT_LENGTH)
  const queue = queues.get(sessionID) ?? []
  queue.push({ id: crypto.randomUUID(), text: trimmed, createdAt: Date.now() })
  while (queue.length > MAX_QUEUE_LENGTH) queue.shift()
  queues.set(sessionID, queue)
  logger.info(`Queued chat message for session ${sessionID} (position ${queue.length})`)
  return [...queue]
}

export function removeQueuedChat(sessionID: string, id: string): boolean {
  const queue = queues.get(sessionID)
  if (!queue) return false
  const index = queue.findIndex((item) => item.id === id)
  if (index === -1) return false
  queue.splice(index, 1)
  if (queue.length === 0) queues.delete(sessionID)
  return true
}

/**
 * 대기열 순서 변경. toTop 이면 맨 앞(최우선)으로, 아니면 한 칸 위로.
 * 이미 첫 항목이거나 id 를 못 찾으면 현재 큐를 그대로 돌려준다(변화 없음).
 */
export function moveQueuedChat(sessionID: string, id: string, toTop: boolean): QueuedChat[] | null {
  const queue = queues.get(sessionID)
  if (!queue) return null
  const index = queue.findIndex((item) => item.id === id)
  if (index <= 0) return [...queue]
  const removed = queue.splice(index, 1)
  const item = removed[0]
  if (!item) return [...queue]
  if (toTop) queue.unshift(item)
  else queue.splice(index - 1, 0, item)
  return [...queue]
}

/** 중단(abort) 시 호출: 세션의 대기열 전체를 비운다. */
export function clearQueuedChats(sessionID: string): number {
  const queue = queues.get(sessionID)
  if (!queue) return 0
  const count = queue.length
  queues.delete(sessionID)
  logger.info(`Cleared ${count} queued chat(s) for session ${sessionID}`)
  return count
}

/**
 * Sends the head of every idle session's queue. Only one message per session
 * per cycle: sending starts a new turn, so the rest wait until the poller sees
 * the session idle again. Dispatch failures re-queue the item at the front
 * with a backoff so a broken OpenCode server cannot spin the flusher.
 */
function dispatchHead(base: string, sessionID: string): void {
  const queue = queues.get(sessionID)
  if (!queue || queue.length === 0) return
  if (inFlight.has(sessionID)) return
  if ((failedUntil.get(sessionID) ?? 0) > Date.now()) return

  const next = queue[0]
  if (!next) return

  // Optimistic removal: the strip must clear as soon as the message is
  // handed to OpenCode, not when the generated answer finishes. Failures
  // put the item back at the front with a backoff.
  queue.splice(0, 1)
  if (queue.length === 0) queues.delete(sessionID)

  inFlight.add(sessionID)
  logger.info(`Dispatching queued chat to session ${sessionID}; ${listQueuedChats(sessionID).length} remaining`)

  void dispatchQueuedChat(base, sessionID, next)
    .then((sent) => {
      if (sent) {
        failedUntil.delete(sessionID)
        logger.info(`Flushed queued chat to session ${sessionID}; ${listQueuedChats(sessionID).length} remaining`)
      } else {
        requeueFront(sessionID, next)
        failedUntil.set(sessionID, Date.now() + FLUSH_RETRY_BACKOFF_MS)
      }
    })
    .catch((error) => {
      logger.warn(`Queued chat flush errored for session ${sessionID}:`, error)
      // OpenCode may not return response headers until the whole turn has
      // finished generating. A timeout therefore means the request almost
      // certainly REACHED OpenCode — treat it as delivered instead of
      // re-queuing, otherwise the message would be sent twice.
      const name = (error as { name?: string })?.name
      const code = ((error as { cause?: { code?: unknown } })?.cause?.code
        ?? (error as { code?: unknown })?.code) as string | undefined
      const connectError = typeof code === 'string'
        && ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(code.toUpperCase())
      if (connectError) {
        requeueFront(sessionID, next)
        failedUntil.set(sessionID, Date.now() + FLUSH_RETRY_BACKOFF_MS)
      } else if (name !== 'TimeoutError' && name !== 'AbortError') {
        requeueFront(sessionID, next)
        failedUntil.set(sessionID, Date.now() + FLUSH_RETRY_BACKOFF_MS)
      }
    })
    .finally(() => {
      inFlight.delete(sessionID)
    })
}

/** 세션 상태 폴러(2s)가 매 틱 호출한다. idle 세션의 큐 헤드를 순차 발송한다. */
export function flushReadyQueues(busySessions: Set<string>): void {
  if (queues.size === 0) return
  const base = opencodeServerManager.getUrl()

  for (const [sessionID] of [...queues]) {
    if (busySessions.has(sessionID)) continue
    dispatchHead(base, sessionID)
  }
}

/** 채팅 완료 이벤트로 1개 세션의 큐를 발송한다. 대화 전체가 complete(idle) 일 때만 발송한다. */
export async function flushQueueForSession(sessionId: string, directory?: string): Promise<void> {
  if (!queues.has(sessionId)) return
  if (inFlight.has(sessionId)) return
  if ((failedUntil.get(sessionId) ?? 0) > Date.now()) return
  // 제너레이션 1회 끝이 아니라 대화 전체가 idle 일 때만 발송한다.
  if (directory) {
    try {
      const base = opencodeServerManager.getUrl()
      const res = await fetch(`${base}/session/status?directory=${encodeURIComponent(directory)}`, {
        headers: ensureServerAuth({}),
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok) {
        const map = (await res.json()) as Record<string, { type?: string }>
        if (map[sessionId]?.type === 'busy') return
      }
    } catch {}
  }
  const base = opencodeServerManager.getUrl()
  dispatchHead(base, sessionId)
}

function requeueFront(sessionID: string, chat: QueuedChat): void {
  const queue = queues.get(sessionID)
  if (queue) {
    queue.unshift(chat)
  } else {
    queues.set(sessionID, [chat])
  }
}

async function dispatchQueuedChat(
  base: string,
  sessionID: string,
  chat: QueuedChat,
): Promise<boolean> {
  const headers = ensureServerAuth({})
  let directoryParam = encodeURIComponent(getWorkspacePath())

  try {
    const sessionRes = await fetch(`${base}/session/${sessionID}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (sessionRes.ok) {
      const session = await sessionRes.json() as { directory?: string }
      if (session.directory) {
        directoryParam = encodeURIComponent(session.directory)
      }
    }
  } catch {
    // fall back to workspace directory
  }

  const sendRes = await fetch(`${base}/session/${sessionID}/message?directory=${directoryParam}`, {
    method: 'POST',
    headers: ensureServerAuth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ parts: [{ type: 'text', text: chat.text }] }),
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
