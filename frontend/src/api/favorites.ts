import { API_BASE_URL } from '@/config'

export interface FavoriteSession {
  sessionId: string
  repoId: number | null
  directory: string
  title: string
  createdAt: number
  updatedAt: number
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_BASE_URL}/api/favorites${path}`, init)
  if (!r.ok) {
    let m = `Request failed (${r.status})`
    try { const b = await r.json(); if (b?.error) m = b.error } catch {}
    throw new Error(m)
  }
  return r.json() as Promise<T>
}
export function listFavorites(): Promise<FavoriteSession[]> { return req<FavoriteSession[]>('') }
export function addFavorite(input: { sessionId: string; repoId?: number | null; directory?: string; title?: string }): Promise<FavoriteSession> {
  return req<FavoriteSession>('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
}
export function removeFavorite(sessionId: string): Promise<void> {
  return req<void>(`?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
}
