import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { API_BASE_URL } from '@/config'

export interface CommandRunStart {
  id: string
  sessionID: string
  name: string
  args: string
  startedAt: number
  messageID?: string
  directory?: string
  repoId?: number
}

interface CommandRunsStore {
  runsBySession: Record<string, CommandRunStart[]>
  startRun: (sessionID: string, name: string, args: string, directory?: string, repoId?: number) => string
  setRunMessage: (sessionID: string, runID: string, messageID: string) => void
  removeRun: (sessionID: string, runID: string) => void
  clearSession: (sessionID: string) => void
  finishRun: (sessionID: string, runID: string, status: 'completed' | 'failed' | 'cancelled') => void
  hydrateFromServer: (sessionID: string, runs: CommandRunStart[]) => void
}

const MAX_RUNS_PER_SESSION = 200
const API_BASE = `${API_BASE_URL}/api/command-runs`

// ─── 서버 저장 헬퍼 (fire-and-forget) ─────────────────────────────
// 네트워크 오류/서버 다운 상황에서도 UI를 막지 않도록 실패는 콘솔 경고만.

function serverCreate(run: CommandRunStart): void {
  void fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: run.id,
      sessionId: run.sessionID,
      repoId: run.repoId,
      commandName: run.name,
      args: run.args,
      directory: run.directory,
      startedAt: run.startedAt,
    }),
  }).catch((e) => console.warn('[commandRuns] server create failed:', e))
}

function serverSetMessage(runID: string, messageID: string): void {
  void fetch(`${API_BASE}/${encodeURIComponent(runID)}/message`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId: messageID }),
  }).catch((e) => console.warn('[commandRuns] server setMessage failed:', e))
}

function serverFinish(runID: string, status: 'completed' | 'failed' | 'cancelled'): void {
  void fetch(`${API_BASE}/${encodeURIComponent(runID)}/finish`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  }).catch((e) => console.warn('[commandRuns] server finish failed:', e))
}

function serverDelete(runID: string): void {
  void fetch(`${API_BASE}/${encodeURIComponent(runID)}`, {
    method: 'DELETE',
  }).catch((e) => console.warn('[commandRuns] server delete failed:', e))
}

function serverClearSession(sessionID: string): void {
  void fetch(`${API_BASE}/session/${encodeURIComponent(sessionID)}`, {
    method: 'DELETE',
  }).catch((e) => console.warn('[commandRuns] server clearSession failed:', e))
}

// ─── Store ────────────────────────────────────────────────────────

export const useCommandRuns = create<CommandRunsStore>()(
  persist(
    (set) => ({
      runsBySession: {},

      startRun: (sessionID, name, args, directory, repoId) => {
        const run: CommandRunStart = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          sessionID,
          name,
          args,
          startedAt: Date.now(),
          directory,
          repoId,
        }
        set((state) => {
          const current = state.runsBySession[sessionID] ?? []
          const next = [...current, run]
          if (next.length > MAX_RUNS_PER_SESSION) {
            next.splice(0, next.length - MAX_RUNS_PER_SESSION)
          }
          return {
            runsBySession: { ...state.runsBySession, [sessionID]: next },
          }
        })
        serverCreate(run)
        return run.id
      },

      setRunMessage: (sessionID, runID, messageID) => {
        set((state) => {
          const runs = state.runsBySession[sessionID]
          if (!runs) return state
          const next = runs.map((r) => (r.id === runID && !r.messageID ? { ...r, messageID } : r))
          return { runsBySession: { ...state.runsBySession, [sessionID]: next } }
        })
        serverSetMessage(runID, messageID)
      },

      removeRun: (sessionID, runID) => {
        set((state) => {
          const runs = state.runsBySession[sessionID]
          if (!runs) return state
          return {
            runsBySession: {
              ...state.runsBySession,
              [sessionID]: runs.filter((r) => r.id !== runID),
            },
          }
        })
        serverDelete(runID)
      },

      clearSession: (sessionID) => {
        set((state) => {
          const next = { ...state.runsBySession }
          delete next[sessionID]
          return { runsBySession: next }
        })
        serverClearSession(sessionID)
      },

      finishRun: (_sessionID, runID, status) => {
        // 로컬 store에는 상태 필드가 없으므로 서버만 업데이트.
        // 필요하면 CommandRunStart에 status 필드를 추가하고 set로 반영하세요.
        serverFinish(runID, status)
      },

      hydrateFromServer: (sessionID, runs) =>
        set((state) => ({
          runsBySession: { ...state.runsBySession, [sessionID]: runs },
        })),
    }),
    {
      name: 'opencode-webui-command-runs',
    },
  ),
)
