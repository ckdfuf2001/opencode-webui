import axios from 'axios'
import { API_BASE_URL } from '@/config'

export interface CollabSessionInfo {
  roomId: string
  role: 'host' | 'guest' | 'resume'
  epoch: string
  lastHash: string
  path: string
  /**
   * X1b(P0-2): 서버 판정 결과. stale 이면 방에 붙지 않는다(fail-closed).
   * `stale_room` = 디스크가 방의 마지막 저장과 다르다(외부 변경이 방 뒤에 있었음).
   * `stale_client` = 클라이언트가 가진 바이트의 해시가 디스크와 다르다.
   */
  stale?: boolean
  code?: 'stale_room' | 'stale_client'
  currentHash?: string | null
}

export interface CollabParticipant {
  id: string
  name: string
  color: string
  mode: 'view' | 'edit'
  slide?: number
  where?: string
  owner: boolean
}

export interface CollabLockInfo {
  active: boolean
  roomId?: string
  owner?: number[]
  epoch?: string
  lastHash?: string
  externalChanged?: boolean
  participants?: CollabParticipant[]
  aiBlockedAt?: number | null
}

export interface CollabObjectSnapshot {
  key: string
  sheet: number
  kind: string
  anchor: unknown
  deleted: boolean
  version: number
  lock: { clientId: number; lockId: string; expiresAt: number } | null
}

export interface CollabObjectsState {
  version: number
  order: Record<string, string[]> | null
  objects: CollabObjectSnapshot[]
}

export type CollabObjectsResult =
  | { ok: true; version: number; keys?: string[]; order?: Record<string, string[]> | null; objects?: CollabObjectSnapshot[]; lockId?: string; expiresAt?: number; holder?: number }
  | { ok: false; code: string; holder?: number; version?: number; objects?: CollabObjectSnapshot[]; expected?: unknown; error?: string }

async function objectsPost<T>(roomId: string, suffix: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE_URL}/api/collab/${encodeURIComponent(roomId)}/objects${suffix}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (res.ok) return { ok: true, ...(data ?? {}) } as T
  return { ok: false, code: typeof data?.code === 'string' ? data.code : `http_${res.status}`, ...(data ?? {}) } as T
}

async function objectsDelete<T>(roomId: string, suffix: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE_URL}/api/collab/${encodeURIComponent(roomId)}/objects${suffix}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (res.ok) return { ok: true, ...(data ?? {}) } as T
  return { ok: false, code: typeof data?.code === 'string' ? data.code : `http_${res.status}`, ...(data ?? {}) } as T
}

async function objectsGet(roomId: string): Promise<CollabObjectsState & { roomId: string }> {
  const res = await fetch(`${API_BASE_URL}/api/collab/${encodeURIComponent(roomId)}/objects`)
  if (!res.ok) throw new Error(`objects get failed: ${res.status}`)
  return (await res.json()) as CollabObjectsState & { roomId: string }
}

export interface CollabRoomSummary {
  roomId: string
  path: string
  rel: string
  epoch: string
  participants: CollabParticipant[]
  /** X2a-③: 방에 문서가 올라왔는가(없으면 undefined — 구 서버 호환). */
  seeded?: boolean
}

export interface ImageLossDetail {
  before: { media: number; refs: number }
  after: { media: number; refs: number }
}

export type CollabSaveResult =
  | { ok: true; newHash: string }
  | {
      ok: false
      reason: 'conflict' | 'conflict_room' | 'conflict_external' | 'denied' | 'not_seeded' | 'image_loss' | 'error'
      currentHash?: string | null
      code?: string
      message?: string
      detail?: ImageLossDetail
    }

/** ws(s)://<origin>/api/collab — 폰·PC 모두 같은 origin으로 붙는다. */
export function collabServerUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/api/collab`
}

/** M1: 바이너리 저장 (base64 문자열을 만들지 않는다). 메타는 헤더로. */
async function postSaveBinary(
  roomId: string,
  clientId: number,
  bytes: Uint8Array,
  baseHash?: string | null,
  allowImageLoss = false,
): Promise<CollabSaveResult> {
  let res: Response
  try {
    res = await fetch(`${API_BASE_URL}/api/collab/save`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-collab-room': roomId,
        'x-collab-client': String(clientId),
        ...(baseHash ? { 'x-collab-base-hash': baseHash } : {}),
        // R2: 사용자가 "이미지 삭제 확정"을 눌렀을 때만 붙인다. 그 외엔 절대 안 붙는다.
        ...(allowImageLoss ? { 'x-collab-allow-image-loss': '1' } : {}),
      },
      // 복사 없이 원본 버퍼를 그대로 보낸다.
      body: bytes as unknown as BodyInit,
    })
  } catch (error) {
    return { ok: false, reason: 'error', message: error instanceof Error ? error.message : 'Save failed' }
  }
  if (res.ok) {
    const data = (await res.json().catch(() => null)) as { newHash?: unknown } | null
    return { ok: true, newHash: typeof data?.newHash === 'string' ? data.newHash : '' }
  }
  const body = (await res.json().catch(() => null)) as {
    error?: string
    code?: string
    currentHash?: string | null
  } | null
  if (res.status === 409) {
    if (body?.code === 'not_seeded') return { ok: false, reason: 'not_seeded', code: body.code, message: body.error }
    if (body?.code === 'image_loss') {
      const d = body as unknown as ImageLossDetail
      return {
        ok: false,
        reason: 'image_loss',
        code: body.code,
        message: body.error,
        detail: d && typeof d.before === 'object' && typeof d.after === 'object' ? d : undefined,
      }
    }
    if (body?.code === 'conflict_room' || body?.code === 'conflict_external' || body?.code === 'conflict' || body?.currentHash !== undefined) {
      // X1b: conflict_room = 다른 참가자가 먼저 저장(재직렬화 후 1회 재시도 가능),
      //        conflict_external = 외부 변경(재시도 금지, 배너·다운로드로 알린다).
      const reason =
        body?.code === 'conflict_room' ? 'conflict_room' : body?.code === 'conflict_external' ? 'conflict_external' : 'conflict'
      return { ok: false, reason, currentHash: body?.currentHash ?? null, code: body?.code, message: body?.error }
    }
    return { ok: false, reason: 'denied', code: body?.code, message: body?.error }
  }
  return { ok: false, reason: 'error', message: body?.error ?? `Save failed (${res.status})` }
}


export const collabApi = {
  session: async (
    path: string,
    resume?: { resumeEpoch?: string; knownHash?: string | null; clientId?: number; strict?: boolean },
  ): Promise<CollabSessionInfo> => {
    try {
      // loopback SYN 블랙홀 대비: 무한 대기를 막는다 (실패하면 solo 폴백).
      const { data } = await axios.post(`${API_BASE_URL}/api/collab/session`, {
        path,
        resumeEpoch: resume?.resumeEpoch,
        knownHash: resume?.knownHash ?? undefined,
        clientId: resume?.clientId,
        // X1b(P0-2): 서버가 staleness 를 판정한다.
        strict: resume?.strict,
      }, { timeout: 15000 })
      return data
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        const body = error.response.data as { error?: string; code?: string }
        throw { code: body?.code ?? 'conflict', message: body?.error }
      }
      throw error
    }
  },

  save: async (
    roomId: string,
    clientId: number,
    bytes: Uint8Array,
    baseHash?: string | null,
    allowImageLoss = false,
  ): Promise<CollabSaveResult> => {
    // C2-a: 같은 바이트 재전송 생략(M1)은 보안 컨텍스트 전용 API에 의존하므로 삭제한다.
    // 서버 저장은 멱등(같은 바이트 → 같은 newHash)이라 생략 없이 바로 보낸다.
    try {
      return await postSaveBinary(roomId, clientId, bytes, baseHash, allowImageLoss)
    } catch (error) {
      return { ok: false, reason: 'error', message: error instanceof Error ? error.message : 'Save failed' }
    }
  },

  lock: async (path: string): Promise<CollabLockInfo> => {
    const { data } = await axios.get(`${API_BASE_URL}/api/collab/lock`, { params: { path } })
    return data
  },

  suggestName: async (): Promise<string> => {
    const { data } = await axios.post(`${API_BASE_URL}/api/collab/suggest-name`)
    const name = (data as { name?: unknown })?.name
    if (typeof name === 'string' && name) return name
    throw new Error('Bad suggest-name response')
  },

  /** 4-2: 오염된 room을 디스크 기준으로 재설정 (owner 전용). */
  resetRoom: async (roomId: string, clientId: number): Promise<{ epoch: string; lastHash: string }> => {
    const { data } = await axios.post(`${API_BASE_URL}/api/collab/reset-room`, { roomId, clientId })
    return data
  },

  /** C4: 시트 개체 표/락/이동/삭제. */
  objects: {
    get: (roomId: string) => objectsGet(roomId),
    register: (roomId: string, hash: string, items: Array<{ sheet: number; kind: string }>) =>
      objectsPost<CollabObjectsResult>(roomId, '/register', { hash, items }),
    lock: (roomId: string, key: string, clientId: number) =>
      objectsPost<CollabObjectsResult>(roomId, `/${encodeURIComponent(key)}/lock`, { clientId }),
    unlock: (roomId: string, key: string, lockId: string) =>
      objectsDelete<CollabObjectsResult>(roomId, `/${encodeURIComponent(key)}/lock`, { lockId }),
    move: (roomId: string, key: string, clientId: number, anchor: unknown, baseVersion: number, lockId?: string) =>
      objectsPost<CollabObjectsResult>(roomId, `/${encodeURIComponent(key)}/move`, { clientId, anchor, baseVersion, ...(lockId ? { lockId } : {}) }),
    del: (roomId: string, key: string, clientId: number, baseVersion: number, lockId?: string) =>
      objectsPost<CollabObjectsResult>(roomId, `/${encodeURIComponent(key)}/delete`, { clientId, baseVersion, ...(lockId ? { lockId } : {}) }),
  },

  rooms: async (): Promise<CollabRoomSummary[]> => {
    const { data } = await axios.get(`${API_BASE_URL}/api/collab/rooms`)
    return (data?.rooms ?? []) as CollabRoomSummary[]
  },
}
