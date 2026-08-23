import { API_BASE_URL } from '@/config'

export interface QueuedChat {
  id: string
  text: string
  createdAt: number
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/api/chat-queue${path}`, init)

  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error || `Request failed (${response.status})`)
  }

  return response.json()
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }
}

export async function listQueuedChats(sessionID: string): Promise<QueuedChat[]> {
  return request<QueuedChat[]>(`/${encodeURIComponent(sessionID)}`)
}

export async function enqueueQueuedChat(sessionID: string, text: string): Promise<QueuedChat[]> {
  return request<QueuedChat[]>(`/${encodeURIComponent(sessionID)}`, jsonInit('POST', { text }))
}

export async function removeQueuedChat(sessionID: string, id: string): Promise<void> {
  await request<{ success: boolean }>(`/${encodeURIComponent(sessionID)}/${encodeURIComponent(id)}`, jsonInit('DELETE'))
}
