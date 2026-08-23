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
// still generating. The session watch poll flushes them one at a time whenever
// the session is idle again. Lost on backend restart by design.
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
 * Sends the head of every idle session's queue. Only one message per session
 * per cycle: sending starts a new turn, so the rest wait until the poll sees
 * the session idle again. Dispatch failures re-queue the item at the front
 * with a backoff so a broken OpenCode server cannot spin the flusher.
 */
export async function flushReadyQueues(busySessions: Set<string>): Promise<void> {
  if (queues.size === 0) return
  const base = opencodeServerManager.getUrl()

  for (const [sessionID, queue] of [...queues]) {
    if (queue.length === 0 || busySessions.has(sessionID)) continue
    if ((failedUntil.get(sessionID) ?? 0) > Date.now()) continue
    if (inFlight.has(sessionID)) continue

    const next = queue[0]
    if (!next) continue

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
