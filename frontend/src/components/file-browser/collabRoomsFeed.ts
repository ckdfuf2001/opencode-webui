import { useSyncExternalStore } from 'react'
import { collabApi, type CollabParticipant, type CollabRoomSummary } from '@/api/collab'

/**
 * 활성 collab room 피드 (탐색기 아바타용, 10초 poll).
 * 구독자가 여러 TreeNode여도 interval은 하나만 돈다.
 */
let cache: CollabRoomSummary[] = []
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

async function refresh(): Promise<void> {
  try {
    cache = await collabApi.rooms()
  } catch {
    // 조회 실패는 이전 값 유지 (fail-open).
  }
  listeners.forEach((l) => {
    try {
      l()
    } catch {
      // 무시
    }
  })
}

function ensure(): void {
  if (timer) return
  void refresh()
  timer = setInterval(() => {
    void refresh()
  }, 10_000)
}

function subscribe(listener: () => void): () => void {
  ensure()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

function getSnapshot(): CollabRoomSummary[] {
  return cache
}

export function useCollabRooms(): CollabRoomSummary[] {
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** 탐색기 file.path와 room rel 매칭 (슬래시 정규화 + 접미사 폴백). */
export function matchRoomPeers(rooms: CollabRoomSummary[], filePath: string): CollabParticipant[] {
  const norm = filePath.replace(/\\/g, '/')
  for (const r of rooms) {
    const rel = (r.rel ?? '').replace(/\\/g, '/')
    if (!rel) continue
    if (rel === norm || rel.endsWith(`/${norm}`) || norm.endsWith(`/${rel}`)) {
      return r.participants ?? []
    }
  }
  return []
}
