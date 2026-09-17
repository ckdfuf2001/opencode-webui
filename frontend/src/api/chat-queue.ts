import { API_BASE_URL } from '@/config'

export interface QueuedChat {
  id: string
  text: string
  createdAt: number
  status: 'queued' | 'sending' | 'failed'
  model?: { providerID: string; modelID: string }
  agent?: string
  sendingSince?: number
  failedAt?: number
  attempts?: number
  reviewWanted?: boolean
  autoApply?: boolean
}

export interface EnqueueChatOptions {
  model?: { providerID: string; modelID: string }
  agent?: string
  /** 세션 리뷰/자동변경 오버라이드 스냅샷 (undefined면 상속 = 레포 설정). */
  reviewWanted?: boolean
  autoApply?: boolean
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

export async function enqueueQueuedChat(sessionID: string, text: string, directory?: string, opts?: EnqueueChatOptions): Promise<QueuedChat[]> {
  return request<QueuedChat[]>(`/${encodeURIComponent(sessionID)}`, jsonInit('POST', { text, directory, ...opts }))
}

export async function removeQueuedChat(sessionID: string, id: string): Promise<void> {
  await request<{ success: boolean }>(`/${encodeURIComponent(sessionID)}/${encodeURIComponent(id)}`, jsonInit('DELETE'))
}

/** 대기열 순서 변경. toTop=true 면 맨 앞(최우선), 아니면 한 칸 위로. */
export async function moveQueuedChat(sessionID: string, id: string, toTop: boolean): Promise<QueuedChat[]> {
  return request<QueuedChat[]>(
    `/${encodeURIComponent(sessionID)}/${encodeURIComponent(id)}/move`,
    jsonInit('PATCH', { toTop }),
  )
}

/** 중단(abort) 시: 세션 대기열 전체 비우기 */
export async function clearQueuedChats(sessionID: string): Promise<void> {
  await request<{ success: boolean }>(`/${encodeURIComponent(sessionID)}`, { method: 'DELETE' })
}

/** 수동 재시도: sending 고착·failed를 queued로 되돌리고 즉시 발송 시도 */
export async function retryQueuedChat(sessionID: string, id: string): Promise<QueuedChat[]> {
  return request<QueuedChat[]>(
    `/${encodeURIComponent(sessionID)}/${encodeURIComponent(id)}/retry`,
    jsonInit('POST'),
  )
}

/**
 * 세션 모델 변경 시 큐에 스냅샷된 모델을 동기화한다.
 * sending 항목은 서버에서 건드리지 않는다 (이미 발송된 슬롯).
 * 큐가 비어 있으면 빈 배열로 no-op 성공.
 */
export async function updateQueuedChatsModel(
  sessionID: string,
  model: { providerID: string; modelID: string },
): Promise<QueuedChat[]> {
  return request<QueuedChat[]>(
    `/${encodeURIComponent(sessionID)}/model`,
    jsonInit('PATCH', model),
  )
}
