import { API_BASE_URL } from '@/config'

export type SessionStatusValue = 'busy' | 'idle'

export interface SessionStatusEntry {
  sessionId: string
  directory: string
  repoId: number | null
  status: SessionStatusValue
  pendingPermissions: number
  updatedAt: number
}

export async function listSessionStatuses(): Promise<SessionStatusEntry[]> {
  const response = await fetch(`${API_BASE_URL}/api/session-status`)
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error || `Request failed (${response.status})`)
  }
  return response.json()
}
