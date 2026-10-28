import { API_BASE_URL } from '@/config'

export type SessionStatusValue = 'busy' | 'idle'

export interface SessionStatusEntry {
  sessionId: string
  directory: string
  repoId: number | null
  status: SessionStatusValue
  pendingPermissions: number
  isCancelled?: boolean
  updatedAt: number
  /** B0-6: opencode idle인데 running으로 남은 고아 part id 목록. */
  orphanParts?: string[]
}

export async function listSessionStatuses(): Promise<SessionStatusEntry[]> {
  const response = await fetch(`${API_BASE_URL}/api/session-status`)
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error || `Request failed (${response.status})`)
  }
  return response.json()
}
