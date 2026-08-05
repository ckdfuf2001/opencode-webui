import { API_BASE_URL } from '@/config'

export type ScheduleAction = 'command' | 'chat'

export interface Schedule {
  id: number
  repoId: number
  name: string
  action: ScheduleAction
  command?: string
  prompt?: string
  cron: string
  enabled: boolean
  lastRunAt?: number
  activeFrom?: number
  activeUntil?: number
  agent?: string
  createdAt: number
  updatedAt: number
}

export interface ScheduleInput {
  repoId: number
  name: string
  action: ScheduleAction
  command?: string
  prompt?: string
  cron: string
  enabled?: boolean
  activeFrom?: number
  activeUntil?: number
  agent?: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/api/schedules${path}`, init)

  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error || `Request failed (${response.status})`)
  }

  return response.json()
}

export async function listSchedules(repoId?: number): Promise<Schedule[]> {
  const query = repoId ? `?repoId=${repoId}` : ''
  return request<Schedule[]>(query)
}

export async function createSchedule(input: ScheduleInput): Promise<Schedule> {
  return request<Schedule>('', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export async function updateSchedule(id: number, input: Partial<Omit<ScheduleInput, 'repoId'>>): Promise<Schedule> {
  return request<Schedule>(`/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export async function deleteSchedule(id: number): Promise<void> {
  await request<{ success: boolean }>(`/${id}`, { method: 'DELETE' })
}

export async function runScheduleNow(id: number): Promise<{ success: boolean; sessionID?: string }> {
  return request<{ success: boolean; sessionID?: string }>(`/${id}/run`, { method: 'POST' })
}
