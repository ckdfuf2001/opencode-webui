import { useMemo } from 'react'
import { create } from 'zustand'
import { API_BASE_URL } from '@/config'

type SessionActivityEventType = 'active' | 'completing' | 'idle' | 'remove'

interface SessionActivityEvent {
  type: SessionActivityEventType
  sessionID: string
}

type SessionActivityListener = (event: SessionActivityEvent) => void

const listeners = new Set<SessionActivityListener>()

export const sessionActivityEvents = {
  emit: (event: SessionActivityEvent) => {
    listeners.forEach(listener => listener(event))
  },
  subscribe: (listener: SessionActivityListener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
}

interface SessionActivityStore {
  activeSessions: Record<string, number>
}

const useSessionActivityStore = create<SessionActivityStore>(() => ({
  activeSessions: {},
}))

const COMPLETION_GRACE_MS = 3000
// Fallback only: sessions are cleared by session.idle/session.error events.
// The sweeper exists for events missed while the connection was down.
const ACTIVITY_TIMEOUT_MS = 15_000
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()

function setActive(sessionID: string): void {
  useSessionActivityStore.setState((state) => ({
    activeSessions: { ...state.activeSessions, [sessionID]: Date.now() },
  }))
}

function setInactive(sessionID: string): void {
  useSessionActivityStore.setState((state) => {
    if (!(sessionID in state.activeSessions)) return state
    const activeSessions = { ...state.activeSessions }
    delete activeSessions[sessionID]
    return { activeSessions }
  })
}

function clearIdleTimer(sessionID: string): void {
  const timer = idleTimers.get(sessionID)
  if (timer) {
    clearTimeout(timer)
    idleTimers.delete(sessionID)
  }
}

function startActivitySubscription(): void {
  sessionActivityEvents.subscribe((event) => {
    const { type, sessionID } = event
    if (!sessionID) return

    if (type === 'active') {
      clearIdleTimer(sessionID)
      setActive(sessionID)
    } else if (type === 'completing') {
      clearIdleTimer(sessionID)
      setActive(sessionID)
      idleTimers.set(sessionID, setTimeout(() => {
        idleTimers.delete(sessionID)
        setInactive(sessionID)
      }, COMPLETION_GRACE_MS))
    } else {
      clearIdleTimer(sessionID)
      setInactive(sessionID)
    }
  })
}

function startActivitySweeper(): void {
  setInterval(async () => {
    // 1) 15s 활동 타임아웃 스윕
    useSessionActivityStore.setState((state) => {
      const now = Date.now()
      let changed = false
      const activeSessions: Record<string, number> = {}
      for (const [sessionID, lastActive] of Object.entries(state.activeSessions)) {
        if (now - lastActive < ACTIVITY_TIMEOUT_MS) {
          activeSessions[sessionID] = lastActive
        } else {
          changed = true
        }
      }
      return changed ? { activeSessions } : state
    })

    // 2) LLM 실제 generating 상태 기준 정합화 — 이벤트 누락과 무관하게
    //    배지가 실제 생성 상태를 따르도록 10s마다 서버 busy 맵과 동기화한다.
    try {
      const res = await fetch(`${API_BASE_URL}/api/opencode/session/status`)
      if (res.ok) {
        const status = (await res.json()) as Record<string, { type?: string }>
        const busy = new Set(
          Object.entries(status ?? {})
            .filter(([, s]) => s?.type === 'busy')
            .map(([id]) => id),
        )
        reconcileSessionActivity(busy)
      }
    } catch {
      // 상태 조회 실패 시 타임아웃 스윕만으로 동작
    }
  }, 10_000)
}

startActivitySubscription()
startActivitySweeper()

export function useActiveSessions(): Record<string, boolean> {
  const activeSessions = useSessionActivityStore((state) => state.activeSessions)
  return useMemo(() => {
    const result: Record<string, boolean> = {}
    for (const sessionID of Object.keys(activeSessions)) {
      result[sessionID] = true
    }
    return result
  }, [activeSessions])
}

export function useSessionActive(sessionID?: string): boolean {
  const activeSessions = useSessionActivityStore((state) => state.activeSessions)
  return useMemo(() => !!sessionID && !!activeSessions[sessionID], [activeSessions, sessionID])
}

/** Non-reactive check used by the SSE handler before it clears the state. */
export function isSessionActiveInStore(sessionID: string): boolean {
  return !!useSessionActivityStore.getState().activeSessions[sessionID]
}

/**
 * Align the activity store with the server's real busy map. Called on SSE
 * (re)connect so a Working badge that survived a missed session.idle event
 * corrects itself immediately instead of waiting out the sweeper.
 */
export function reconcileSessionActivity(busySessionIDs: Set<string>): void {
  useSessionActivityStore.setState((state) => {
    let changed = false
    const activeSessions: Record<string, number> = { ...state.activeSessions }
    for (const sessionID of busySessionIDs) {
      if (!(sessionID in activeSessions)) {
        activeSessions[sessionID] = Date.now()
        changed = true
      }
    }
    for (const sessionID of Object.keys(activeSessions)) {
      if (!busySessionIDs.has(sessionID) && sessionID in state.activeSessions) {
        delete activeSessions[sessionID]
        changed = true
      }
    }
    return changed ? { activeSessions } : state
  })
}
