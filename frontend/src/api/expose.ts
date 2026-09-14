import { API_BASE_URL } from '@/config'

export interface ExposedCommand {
  id: number
  commandName: string
  exposeName: string
  description: string
  enabled: boolean
  sessionMode: 'new' | 'reuse'
  titleTemplate: string
  pinnedSessionId?: string
  argsTemplate: string
  exampleArgs: string
  createdAt: number
  updatedAt: number
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}/api/expose${path}`, init)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error || `Request failed (${res.status})`)
  }
  return res.json()
}

export async function listExposed(): Promise<ExposedCommand[]> {
  return request<ExposedCommand[]>('/commands')
}

export async function createExposed(input: { commandName: string; exposeName?: string; description?: string; enabled?: boolean; sessionMode?: 'new'|'reuse'; titleTemplate?: string; pinnedSessionId?: string; argsTemplate?: string; exampleArgs?: string }): Promise<ExposedCommand> {
  return request<ExposedCommand>('/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export async function updateExposed(id: number, input: { exposeName?: string; description?: string; enabled?: boolean; sessionMode?: 'new'|'reuse'; titleTemplate?: string; pinnedSessionId?: string | null; argsTemplate?: string; exampleArgs?: string }): Promise<ExposedCommand> {
  return request<ExposedCommand>(`/commands/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export async function deleteExposed(id: number): Promise<void> {
  await request<{ success: boolean }>(`/commands/${id}`, { method: 'DELETE' })
}

export interface PublicCommandsResponse {
  commands: { name: string; commandName: string; description: string; enabled: boolean; sessionMode: 'new'|'reuse'; titleTemplate: string; pinnedSessionId?: string; argsTemplate: string; exampleArgs: string }[]
  count: number
  timestamp: string
}

export async function listPublicCommands(): Promise<PublicCommandsResponse> {
  const res = await fetch(`${API_BASE_URL}/api/public/commands`)
  if (!res.ok) throw new Error(`Failed to list public commands (${res.status})`)
  return res.json()
}

export interface AvailableCommand {
  name: string
  description: string
  scope: 'builtin'|'global'|'project'
  repoId?: number
  repoName?: string
  localPath?: string
}

export async function listAvailableCommands(): Promise<{ items: AvailableCommand[]; count: number }> {
  const res = await fetch(`${API_BASE_URL}/api/expose/available-commands`)
  if (!res.ok) throw new Error(`Failed to list available commands (${res.status})`)
  return res.json()
}

export interface ExposeSession {
  sessionId: string
  title: string
  repoId: number | null
  repoName: string
  directory: string
  status: string
  updatedAt: number
}

export async function listExposeSessions(): Promise<{ sessions: ExposeSession[]; count: number }> {
  const res = await fetch(`${API_BASE_URL}/api/expose/sessions`)
  if (!res.ok) throw new Error(`Failed to list sessions (${res.status})`)
  return res.json()
}
