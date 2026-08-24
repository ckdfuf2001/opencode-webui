import { opencodeServerManager } from './opencode-single-server'
import { ensureServerAuth } from './opencode-auth'
import { isOpenCodeServerBusy } from './busy-tracker'
import { SettingsService } from './settings'
import { flushReadyQueues } from './chat-queue'
import { getWorkspacePath } from '@opencode-webui/shared'
import { logger } from '../utils/logger'
import type { Database } from 'bun:sqlite'

const POLL_INTERVAL_MS = 5_000
const REQUEST_TIMEOUT_MS = 4_000
const RESUME_TIMEOUT_MS = 60_000
const MAX_DANGLING_AGE_MS = 15 * 60 * 1000
const MAX_RESUMED_KEYS = 500

interface SessionInfo {
  id: string
  directory?: string
  title?: string
}

interface MessageEnvelope {
  info: {
    role: string
    time?: { created?: number; completed?: number }
  }
}

/**
 * Server-side recovery for responses interrupted by an OpenCode server outage.
 *
 * Polls /session/status every few seconds. When the endpoint becomes reachable
 * again after a failed poll, sessions that were busy before the outage but are
 * no longer busy afterwards are checked: if their last assistant message never
 * completed (and is recent), a single "Continue" prompt is sent so the run
 * picks up where it stopped. This replaces the old browser-side reconnect scan
 * and works even when no browser tab is open.
 */
export function startSessionWatch(db: Database): NodeJS.Timeout {
  let sawOutage = false
  let polling = false
  const prevBusy = new Set<string>()
  const resumedKeys = new Set<string>()

  async function resumeIfDangling(base: string, sessionID: string): Promise<void> {
    if (resumedKeys.has(sessionID)) return

    const headers = ensureServerAuth({})
    const sessionRes = await fetch(`${base}/session/${sessionID}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!sessionRes.ok) return
    const session = await sessionRes.json() as SessionInfo
    const directoryParam = encodeURIComponent(session.directory ?? getWorkspacePath())

    const msgRes = await fetch(`${base}/session/${sessionID}/message?directory=${directoryParam}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!msgRes.ok) return
    const messages = await msgRes.json() as MessageEnvelope[]
    const last = messages[messages.length - 1]
    if (!last?.info || last.info.role !== 'assistant') return

    const time = last.info.time ?? {}
    if ('completed' in time && time.completed) return
    const created = time.created ?? 0
    if (!created || Date.now() - created > MAX_DANGLING_AGE_MS) return

    resumedKeys.add(sessionID)
    if (resumedKeys.size > MAX_RESUMED_KEYS) resumedKeys.clear()

    const sendRes = await fetch(`${base}/session/${sessionID}/message?directory=${directoryParam}`, {
      method: 'POST',
      headers: ensureServerAuth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ parts: [{ type: 'text', text: 'Continue' }] }),
      signal: AbortSignal.timeout(RESUME_TIMEOUT_MS),
    })
    if (sendRes.ok) {
      logger.info(`Auto-resumed interrupted response in session ${sessionID}${session.title ? ` (${session.title})` : ''}`)
    } else {
      logger.warn(`Auto-resume failed for session ${sessionID}: HTTP ${sendRes.status}`)
    }
  }

  async function pollOnce(): Promise<void> {
    // 생성 중(busy)에는 opencode를 전혀 건드리지 않는다(폴링 부하 제거).
    if (isOpenCodeServerBusy()) return
    const base = opencodeServerManager.getUrl()
    const headers = ensureServerAuth({})

    let status: Record<string, { type: string }> | null = null
    try {
      const res = await fetch(`${base}/session/status`, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (res.ok) {
        status = await res.json() as Record<string, { type: string }>
      }
    } catch {
      status = null
    }

    if (!status || typeof status !== 'object') {
      sawOutage = true
      return
    }

    const currentlyBusy = new Set(
      Object.entries(status)
        .filter(([, s]) => s?.type === 'busy')
        .map(([id]) => id),
    )

    const preferences = new SettingsService(db).getSettings('default').preferences
    if (preferences.autoResumeInterrupted !== false && sawOutage && prevBusy.size > 0) {
      const candidates = [...prevBusy].filter((id) => !currentlyBusy.has(id))
      for (const sessionID of candidates) {
        try {
          await resumeIfDangling(base, sessionID)
        } catch (error) {
          logger.warn(`Auto-resume check failed for session ${sessionID}:`, error)
          resumedKeys.add(sessionID)
        }
      }
    }

    sawOutage = false
    prevBusy.clear()
    currentlyBusy.forEach((id) => prevBusy.add(id))

    await flushReadyQueues(currentlyBusy)
  }

  return setInterval(() => {
    if (polling) return
    polling = true
    pollOnce()
      .catch((error) => logger.warn('Session watch cycle failed:', error))
      .finally(() => {
        polling = false
      })
  }, POLL_INTERVAL_MS)
}
