import { API_BASE_URL } from '@/config'

export type NotifyScope = 'session' | 'repo'

export interface NotifyOverridePatch {
  pushEnabled?: boolean | null
  soundEnabled?: boolean | null
  soundOnCancelEnabled?: boolean | null
  skillAutoEnabled?: boolean | null
  skillReviewEnabled?: boolean | null
}

export interface NotifyOverride extends NotifyOverridePatch {
  scope: NotifyScope
  target: string
  updatedAt: number
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/api/notify${path}`, init)

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

export async function listNotifyOverrides(): Promise<NotifyOverride[]> {
  return request<NotifyOverride[]>('/overrides')
}

export async function setNotifyOverride(
  scope: NotifyScope,
  target: string,
  patch: NotifyOverridePatch,
): Promise<NotifyOverride | null> {
  return request<NotifyOverride | null>(`/overrides/${scope}/${encodeURIComponent(target)}`, jsonInit('PUT', patch))
}

export async function clearNotifyOverride(scope: NotifyScope, target: string): Promise<void> {
  await request<{ ok: boolean }>(`/overrides/${scope}/${encodeURIComponent(target)}`, jsonInit('DELETE'))
}

/** 백단 OS 토스트 테스트 (설정 화면용). */
export async function sendTestToast(): Promise<boolean> {
  const res = await request<{ ok: boolean }>('/test', jsonInit('POST', {}))
  return res.ok
}

/** 중단 보고 — 백단 알림 라벨 판단용 (fire-and-forget). */
export function reportAborted(sessionId: string): void {
  fetch(`${API_BASE_URL}/api/session-status/${encodeURIComponent(sessionId)}/aborted`, { method: 'POST' }).catch(() => {})
}
