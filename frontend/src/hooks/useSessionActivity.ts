import { useMemo } from 'react'
import { create } from 'zustand'

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
const ACTIVITY_TIMEOUT_MS = 60_000
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
  setInterval(() => {
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
