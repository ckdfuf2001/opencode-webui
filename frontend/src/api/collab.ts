import axios from 'axios'
import { API_BASE_URL } from '@/config'

export interface CollabSessionInfo {
  roomId: string
  role: 'host' | 'guest' | 'resume'
  epoch: string
  lastHash: string
  path: string
}

export interface CollabParticipant {
  id: string
  name: string
  color: string
  mode: 'view' | 'edit'
  slide?: number
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

export interface CollabRoomSummary {
  roomId: string
  path: string
  rel: string
  epoch: string
  participants: CollabParticipant[]
}

export type CollabSaveResult =
  | { ok: true; newHash: string }
  | { ok: false; reason: 'conflict' | 'denied' | 'not_seeded' | 'error'; currentHash?: string | null; code?: string; message?: string }

/** ws(s)://<origin>/api/collab — 폰·PC 모두 같은 origin으로 붙는다. */
export function collabServerUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/api/collab`
}

export const collabApi = {
  session: async (
    path: string,
    resume?: { resumeEpoch?: string; knownHash?: string | null; clientId?: number },
  ): Promise<CollabSessionInfo> => {
    try {
      // loopback SYN 블랙홀 대비: 무한 대기를 막는다 (실패하면 solo 폴백).
      const { data } = await axios.post(`${API_BASE_URL}/api/collab/session`, {
        path,
        resumeEpoch: resume?.resumeEpoch,
        knownHash: resume?.knownHash ?? undefined,
        clientId: resume?.clientId,
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
  ): Promise<CollabSaveResult> => {
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    try {
      const { data } = await axios.post(`${API_BASE_URL}/api/collab/save`, {
        roomId,
        clientId,
        baseHash: baseHash ?? undefined,
        bytesB64: btoa(binary),
      })
      return { ok: true, newHash: data.newHash }
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        const body = error.response.data as { error?: string; code?: string; currentHash?: string | null }
        if (body?.code === 'not_seeded') return { ok: false, reason: 'not_seeded', code: body.code, message: body.error }
        if (body?.code === 'conflict' || body?.currentHash !== undefined) {
          return { ok: false, reason: 'conflict', currentHash: body?.currentHash ?? null, code: body?.code, message: body?.error }
        }
        return { ok: false, reason: 'denied', code: body?.code, message: body?.error }
      }
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

  rooms: async (): Promise<CollabRoomSummary[]> => {
    const { data } = await axios.get(`${API_BASE_URL}/api/collab/rooms`)
    return (data?.rooms ?? []) as CollabRoomSummary[]
  },
}
