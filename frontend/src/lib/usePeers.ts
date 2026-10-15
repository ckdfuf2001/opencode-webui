import { useEffect, useMemo, useRef, useState } from 'react'
import { readLibPresence } from '@opencode-webui/shared/lib/collab-presence'
import type { YCollabSession, YCollabDevice } from './ycollab'

export interface Peer {
  /** awareness clientId (doc clientId와 같음). */
  clientId: number
  /** 안정 사용자 id (app.id, 탭 병합 키). */
  id: string
  name: string
  color: string
  mode: 'view' | 'edit'
  /** 1부터 시작 (lib presence activeSlideIndex + 1). */
  slide?: number
  selectedId?: string
  selectedLabel?: string
  isOwner: boolean
  isSelf: boolean
  device: 'mobile' | 'desktop'
  tabCount: number
  lastEditAt?: number
  lastActiveAt?: number
}

export type PeerActivity = 'editing' | 'selected' | 'recent' | 'idle'

/** 상태 우선순위: 편집 중(3초) > 도형 선택 > n초 전 편집(30초) > idle. */
export function peerActivity(p: Peer, now: number): PeerActivity {
  if (p.lastEditAt != null && now - p.lastEditAt < 3000) return 'editing'
  if (p.selectedId) return 'selected'
  if (p.lastEditAt != null && now - p.lastEditAt < 30000) return 'recent'
  return 'idle'
}

export function activityLabel(p: Peer, now: number, selectedFallback = '도형 선택'): string {
  const a = peerActivity(p, now)
  if (a === 'editing') return '편집 중'
  if (a === 'selected') return p.selectedLabel ? `"${p.selectedLabel}" 선택` : selectedFallback
  if (a === 'recent' && p.lastEditAt != null) {
    const s = Math.max(1, Math.round((now - p.lastEditAt) / 1000))
    return `${s}초 전 편집`
  }
  return p.mode === 'edit' ? '편집 모드' : '보는 중'
}

interface UsePeersOpts {
  ownerClientId: number | null
  selfUserId: string
  getSelectedLabel?: (selectedId: string, slide?: number) => string | undefined
}

/**
 * 로컬 awareness에서 직접 읽는 참가자 목록 (서버 poll 불필요).
 * - awareness change + meta(owner) + activity + 1초 tick으로 갱신한다.
 * - 내용이 같으면 같은 배열 참조를 반환한다 (불필요한 렌더 방지).
 * - 같은 app.id(두 탭)는 하나로 합치고 tabCount에 센다.
 */
export function usePeers(session: YCollabSession | null, opts: UsePeersOpts): Peer[] {
  const [tick, setTick] = useState(0)
  const [version, setVersion] = useState(0)
  const cacheRef = useRef<Peer[]>([])
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    if (!session) return
    const bump = (): void => setVersion((v) => v + 1)
    const offAwareness = (() => {
      try {
        session.awareness.on('change', bump)
        return () => {
          try {
            session.awareness.off('change', bump)
          } catch {
            // 무시
          }
        }
      } catch {
        return () => {}
      }
    })()
    const offActivity = session.onActivity(() => bump())
    const offMeta = session.onMeta(() => bump())
    const offSub = session.subscribe(() => bump())
    const timer = setInterval(() => setTick((t) => t + 1), 1000)
    return () => {
      offAwareness()
      offActivity()
      offMeta()
      offSub()
      clearInterval(timer)
    }
  }, [session])

  void tick
  void version

  return useMemo(() => {
    if (!session) return cacheRef.current
    const o = optsRef.current
    const states = session.awareness.getStates() as Map<number, Record<string, unknown>>
    const selfClientId = session.awareness.clientID
    const now = Date.now()
    // app.id 기준 탭 병합.
    const byId = new Map<string, Peer & { tabCount: number }>()
    for (const [cid, st] of states) {
      const app = (st?.app ?? null) as { id?: unknown; name?: unknown; color?: unknown; mode?: unknown; device?: unknown } | null
      const lib = readLibPresence(st)
      const id = String((app && typeof app.id !== 'undefined' ? app.id : cid) ?? cid)
      const name = String((app && app.name) ?? lib?.name ?? `user-${cid}`)
      const color = String((app && app.color) ?? lib?.color ?? '#6366f1')
      const mode = app && app.mode === 'view' ? 'view' : 'edit'
      const device: YCollabDevice = app && app.device === 'mobile' ? 'mobile' : 'desktop'
      const lastEditAt = session.lastEditAt.get(cid)
      const lastActiveAt = lib?.updatedAt
      const selectedId = lib?.selectedId
      const prev = byId.get(id)
      const peer: Peer & { tabCount: number } = {
        clientId: cid,
        id,
        name,
        color,
        mode: prev ? (prev.mode === 'edit' || mode === 'edit' ? 'edit' : 'view') : mode,
        slide: lib?.slide !== undefined ? lib.slide + 1 : prev?.slide,
        selectedId: selectedId ?? prev?.selectedId,
        selectedLabel: undefined,
        isOwner: o.ownerClientId != null && o.ownerClientId === cid,
        isSelf: id === o.selfUserId || (!o.selfUserId && cid === selfClientId),
        device: prev?.device ?? device,
        tabCount: (prev?.tabCount ?? 0) + 1,
        lastEditAt: maxTime(lastEditAt, prev?.lastEditAt),
        lastActiveAt: maxTime(lastActiveAt, prev?.lastActiveAt),
      }
      if (peer.selectedId && o.getSelectedLabel) {
        peer.selectedLabel = o.getSelectedLabel(peer.selectedId, peer.slide)
      }
      byId.set(id, peer)
    }
    const next = [...byId.values()].map((p) => ({ ...p }))
    const prev = cacheRef.current
    if (samePeers(prev, next, now)) return prev
    cacheRef.current = next
    return next
    // session 내부 변경은 version/tick으로 감지한다 (getSelectedLabel은 ref 경유).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, opts.ownerClientId, opts.selfUserId, tick, version])
}

function maxTime(a?: number, b?: number): number | undefined {
  if (a == null) return b
  if (b == null) return a
  return Math.max(a, b)
}

function samePeers(a: Peer[], b: Peer[], now: number): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (
      x.clientId !== y.clientId || x.id !== y.id || x.name !== y.name || x.color !== y.color ||
      x.mode !== y.mode || x.slide !== y.slide || x.selectedId !== y.selectedId ||
      x.selectedLabel !== y.selectedLabel || x.isOwner !== y.isOwner || x.isSelf !== y.isSelf ||
      x.device !== y.device || x.tabCount !== y.tabCount || x.lastEditAt !== y.lastEditAt ||
      peerActivity(x, now) !== peerActivity(y, now)
    ) {
      return false
    }
  }
  return true
}
