import axios from 'axios'
import { API_BASE_URL } from '@/config'

export interface CollabSessionInfo {
  roomId: string
  role: 'host' | 'guest'
  fileHash: string
  path: string
}

export interface CollabLockInfo {
  active: boolean
  roomId?: string
  owner?: number[]
  externalChanged?: boolean
  diskHash?: string | null
}

export type CollabSaveResult =
  | { ok: true; newHash: string }
  | { ok: false; reason: 'conflict' | 'denied' | 'error'; currentHash?: string | null; message?: string }

/** ws(s)://<origin>/api/collab — 폰·PC 모두 같은 origin으로 붙는다. */
export function collabServerUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/api/collab`
}

export const collabApi = {
  session: async (path: string): Promise<CollabSessionInfo> => {
    const { data } = await axios.post(`${API_BASE_URL}/api/collab/session`, { path })
    return data
  },

  save: async (
    roomId: string,
    clientId: number,
    baseHash: string,
    bytes: Uint8Array,
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
        baseHash,
        bytesB64: btoa(binary),
      })
      return { ok: true, newHash: data.newHash }
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        const body = error.response.data as { error?: string; currentHash?: string | null }
        const conflict = body?.currentHash !== undefined
        return {
          ok: false,
          reason: conflict ? 'conflict' : 'denied',
          currentHash: body?.currentHash ?? null,
          message: body?.error,
        }
      }
      return { ok: false, reason: 'error', message: error instanceof Error ? error.message : 'Save failed' }
    }
  },

  handoff: async (roomId: string, fromClientId: number, toClientId: number): Promise<boolean> => {
    try {
      await axios.post(`${API_BASE_URL}/api/collab/handoff`, { roomId, fromClientId, toClientId })
      return true
    } catch {
      return false
    }
  },

  lock: async (path: string): Promise<CollabLockInfo> => {
    const { data } = await axios.get(`${API_BASE_URL}/api/collab/lock`, { params: { path } })
    return data
  },
}
