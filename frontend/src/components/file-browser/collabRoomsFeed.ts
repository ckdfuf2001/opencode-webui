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
  let next: CollabRoomSummary[]
  try {
    next = await collabApi.rooms()
  } catch {
    // 조회 실패는 이전 값 유지 (fail-open).
    return
  }
  // M2-4: 매 10초마다 새 배열이 들어가면 useSyncExternalStore가 참조 변화를 보고해
  // 모든 TreeNode를 다시 그린다(누수는 아니지만 쓰레기 생성). 내용이 같으면
  // 기존 배열 참조를 그대로 둔다.
  if (sameRooms(cache, next)) return
  cache = next
  listeners.forEach((l) => {
    try {
      l()
    } catch {
      // 무시
    }
  })
}

/** 방 목록이 의미 있게 달라졌는가(참조가 아니라 내용 비교). */
function sameRooms(a: CollabRoomSummary[], b: CollabRoomSummary[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.roomId !== y.roomId || x.epoch !== y.epoch || x.path !== y.path) return false
    const px = x.participants
    const py = y.participants
    if (px.length !== py.length) return false
    for (let j = 0; j < px.length; j++) {
      const u = px[j]!
      const v = py[j]!
      if (u.id !== v.id || u.name !== v.name || u.mode !== v.mode) return false
    }
  }
  return true
}

function ensure(): void {
  if (timer) return
  void refresh()
  timer = setInterval(() => {
    // M2-4: 숨겨진 탭에서는 폴링하지 않는다. 보이지 않는 화면이 10초마다
    // 네트워크를 깨우고 새 배열을 만들 이유가 없다.
    if (typeof document !== 'undefined' && document.hidden) return
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
