import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface CommandRunStart {
  id: string
  sessionID: string
  name: string
  args: string
  startedAt: number
  messageID?: string
}

interface CommandRunsStore {
  runsBySession: Record<string, CommandRunStart[]>
  startRun: (sessionID: string, name: string, args: string) => void
  setRunMessage: (sessionID: string, runID: string, messageID: string) => void
  removeRun: (sessionID: string, runID: string) => void
  clearSession: (sessionID: string) => void
}

const MAX_RUNS_PER_SESSION = 200

export const useCommandRuns = create<CommandRunsStore>()(
  persist(
    (set) => ({
      runsBySession: {},
      startRun: (sessionID: string, name: string, args: string) =>
        set((state) => {
          const run: CommandRunStart = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            sessionID,
            name,
            args,
            startedAt: Date.now(),
          }
          const current = state.runsBySession[sessionID] ?? []
          const next = [...current, run]
          if (next.length > MAX_RUNS_PER_SESSION) {
            next.splice(0, next.length - MAX_RUNS_PER_SESSION)
          }
          return {
            runsBySession: {
              ...state.runsBySession,
              [sessionID]: next,
            },
          }
        }),
      setRunMessage: (sessionID: string, runID: string, messageID: string) =>
        set((state) => {
          const runs = state.runsBySession[sessionID]
          if (!runs) return state
          const next = runs.map((r) => (r.id === runID && !r.messageID ? { ...r, messageID } : r))
          return { runsBySession: { ...state.runsBySession, [sessionID]: next } }
        }),
      removeRun: (sessionID: string, runID: string) =>
        set((state) => {
          const runs = state.runsBySession[sessionID]
          if (!runs) return state
          return {
            runsBySession: {
              ...state.runsBySession,
              [sessionID]: runs.filter((r) => r.id !== runID),
            },
          }
        }),
      clearSession: (sessionID: string) =>
        set((state) => {
          const next = { ...state.runsBySession }
          delete next[sessionID]
          return { runsBySession: next }
        }),
    }),
    {
      name: 'opencode-webui-command-runs',
    },
  ),
)
