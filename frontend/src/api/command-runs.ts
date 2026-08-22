import { API_BASE_URL } from '@/config'

export type CommandRunStatus = 'started' | 'completed' | 'failed' | 'cancelled'
export type CommandRunOrigin = 'ui' | 'schedule'

export interface CommandRun {
  id: string
  sessionId: string
  repoId: number | null
  commandName: string
  args: string | null
  directory: string | null
  messageId: string | null
  status: CommandRunStatus
  origin: CommandRunOrigin
  startedAt: number
  finishedAt: number | null
  createdAt: number
}

export interface CreateCommandRunInput {
  sessionId: string
  commandName: string
  args?: string
  directory?: string
  repoId?: number
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/api/command-runs${path}`, init)

  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error || `Request failed (${response.status})`)
  }

  return response.json()
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export async function listCommandRunsByRange(fromTs: number, toTs: number): Promise<CommandRun[]> {
  return request<CommandRun[]>(`?from=${fromTs}&to=${toTs}`)
}

export async function listCommandRunsBySession(sessionId: string): Promise<CommandRun[]> {
  return request<CommandRun[]>(`?sessionId=${encodeURIComponent(sessionId)}`)
}

export async function listCommandRunsByRepo(repoId: number): Promise<CommandRun[]> {
  return request<CommandRun[]>(`?repoId=${repoId}`)
}

export async function createCommandRun(input: CreateCommandRunInput): Promise<CommandRun> {
  return request<CommandRun>('', jsonInit('POST', input))
}

export async function setCommandRunMessage(id: string, messageId: string): Promise<void> {
  await request<{ success: boolean }>(
    `/${encodeURIComponent(id)}/message`,
    jsonInit('PATCH', { messageId }),
  )
}

export async function finishCommandRun(
  id: string,
  status: Exclude<CommandRunStatus, 'started'>,
): Promise<void> {
  await request<{ success: boolean }>(
    `/${encodeURIComponent(id)}/finish`,
    jsonInit('PATCH', { status }),
  )
}

export async function deleteCommandRun(id: string): Promise<void> {
  await request<{ success: boolean }>(`/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function clearSessionCommandRuns(sessionId: string): Promise<void> {
  await request<{ success: boolean }>(
    `/session/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  )
}

export interface CommandRunViewItem extends CommandRun {
  repoName: string | null
  sessionTitle: string | null
}

export type CommandRunViewScope = 'all' | 'repo' | 'session'

export interface CommandRunViewQuery {
  scope: CommandRunViewScope
  repoId?: number
  sessionId?: string
  start?: Date
  end?: Date
}

export async function fetchCommandRunView(query: CommandRunViewQuery): Promise<CommandRunViewItem[]> {
  const params = new URLSearchParams({ scope: query.scope })
  if (query.repoId != null) params.set('repoId', String(query.repoId))
  if (query.sessionId) params.set('sessionId', query.sessionId)
  if (query.start) params.set('from', String(query.start.getTime()))
  if (query.end) params.set('to', String(query.end.getTime()))

  const body = await request<{ items: CommandRunViewItem[] }>(`/view?${params.toString()}`)
  return body.items
}
