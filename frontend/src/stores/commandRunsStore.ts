import { create } from 'zustand'

export interface CommandRunStart {
  id: string
  sessionID: string
  name: string
  args: string
  startedAt: number
}

interface CommandRunsStore {
  runsBySession: Record<string, CommandRunStart[]>
  startRun: (sessionID: string, name: string, args: string) => void
  clearSession: (sessionID: string) => void
}

export const useCommandRuns = create<CommandRunsStore>((set) => ({
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
      return {
        runsBySession: {
          ...state.runsBySession,
          [sessionID]: [...(state.runsBySession[sessionID] ?? []), run],
        },
      }
    }),
  clearSession: (sessionID) =>
    set((state) => {
      const next = { ...state.runsBySession }
      delete next[sessionID]
      return { runsBySession: next }
    }),
}))