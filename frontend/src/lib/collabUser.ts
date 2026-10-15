import { useCallback, useEffect, useState } from 'react'
import { colorForName } from './ycollab'

/**
 * 공동편집·lib presence·코멘트 작성자가 공유하는 단일 신원.
 * 색은 처음 만들 때 한 번 정하고 저장한다 (이름 해시 금지).
 */
export interface CollabIdentity {
  id: string
  name: string
  color: string
}

const STORAGE_KEY = 'collab-user'
const CHANGED_EVENT = 'collab-user-changed'

export function readCollabUser(): CollabIdentity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as { id?: unknown; name?: unknown; color?: unknown }
    if (typeof p?.id !== 'string' || !p.id || typeof p?.name !== 'string' || !p.name.trim()) return null
    const name = p.name.trim()
    return {
      id: p.id,
      name,
      color: typeof p.color === 'string' && p.color ? p.color : colorForName(name),
    }
  } catch {
    return null
  }
}

export function writeCollabUser(user: CollabIdentity): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user))
  } catch {
    // 무시
  }
  try {
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT))
  } catch {
    // 무시
  }
}

/** 열린 viewer 전체에 신원 변경을 전파한다. */
export function useCollabUser(): [CollabIdentity | null, (u: CollabIdentity) => void] {
  const [user, setUser] = useState<CollabIdentity | null>(() => readCollabUser())
  useEffect(() => {
    const onChange = (): void => setUser(readCollabUser())
    window.addEventListener(CHANGED_EVENT, onChange)
    window.addEventListener('storage', onChange)
    return () => {
      window.removeEventListener(CHANGED_EVENT, onChange)
      window.removeEventListener('storage', onChange)
    }
  }, [])
  const save = useCallback((u: CollabIdentity) => {
    writeCollabUser(u)
    setUser(u)
  }, [])
  return [user, save]
}
