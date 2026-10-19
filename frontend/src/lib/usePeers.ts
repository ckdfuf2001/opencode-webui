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
  /** 공통 위치 표기 (app.where): "슬라이드 3" / "Sheet1!B3" / "3쪽". 표시 단일 출처. */
  where?: string
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

/** M7 측정용: 1초 tick 주기(ms). ?peersTick=0 이면 끈다. 기본 1000. */
function readPeersTickMs(): number {
  try {
    const raw = new URLSearchParams(window.location.search).get('peersTick')
    if (raw === null) return 1000
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 1000
  }
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
    // M7 측정: 1초 tick은 "N초 전 편집" 같은 상대 시간 표시를 갱신한다.
    // 이 tick이 호출되는 컴포넌트를 통째로 리렌더시키므로, 리렌더 비용을
    // 측정할 때 끌 수 있어야 한다. ?peersTick=0 → 비활성(기본 1000ms).
    let timer: ReturnType<typeof setInterval> | null = null
    const tickMs = readPeersTickMs()
    if (tickMs > 0) {
      timer = setInterval(() => setTick((t) => t + 1), tickMs)
    }
    return () => {
      offAwareness()
      offActivity()
      offMeta()
      offSub()
      if (timer) clearInterval(timer)
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
    // V5-2: 같은 user.id가 여러 clientID(탭)로 보일 때 **가장 최근 상태 하나**만 대표로 쓴다.
    // 기준: 1) app.slide가 있는 상태, 2) lib lastUpdated(최근), 3) clientID 순.
    // 출처를 섞지 않으므로 mode·owner·slide가 서로 다른 탭에서 오는 일이 없다.
    const byId = new Map<string, Peer & { tabCount: number; freshest: number }>()
    for (const [cid, st] of states) {
      const app = (st?.app ?? null) as { id?: unknown; name?: unknown; color?: unknown; mode?: unknown; device?: unknown; slide?: unknown; where?: unknown } | null
      const lib = readLibPresence(st)
      const id = String((app && typeof app.id !== 'undefined' ? app.id : cid) ?? cid)
      // 하위호환: 구 클라이언트(구 exe 캐시)는 최상위 userName/userColor만 게시했다.
      // TODO(v0.13): app.* 단일화 완료 후 이 fallback을 제거한다.
      const legacyName = st?.userName
      const legacyColor = st?.userColor
      const name = String((app && app.name) ?? (typeof legacyName === 'string' ? legacyName : undefined) ?? lib?.name ?? `user-${cid}`)
      const color = String((app && app.color) ?? (typeof legacyColor === 'string' ? legacyColor : undefined) ?? lib?.color ?? '#6366f1')
      const mode = app && app.mode === 'view' ? 'view' : 'edit'
      const device: YCollabDevice = app && app.device === 'mobile' ? 'mobile' : 'desktop'
      const lastEditAt = session.lastEditAt.get(cid)
      const lastActiveAt = lib?.updatedAt
      const selectedId = lib?.selectedId
      // lib presence의 activeSlideIndex는 0 고정 + 10초 재게시라 항상 1번이다.
      // 그래서 fallback으로 쓰지 않는다. app.slide가 없으면 표시를 생략한다.
      const appSlide = typeof app?.slide === 'number' && app.slide >= 1 ? app.slide : undefined
      const appWhere = typeof app?.where === 'string' && app.where ? app.where : undefined
      const freshest = appSlide != null ? 2 : lastActiveAt != null ? 1 : 0
      const prev = byId.get(id)
      if (prev) {
        prev.tabCount += 1
        // 더 최신 상태가 나오면 대표를 교체한다.
        if (freshest > prev.freshest || (freshest === prev.freshest && cid > prev.clientId)) {
          const isOwnerNow = o.ownerClientId != null && o.ownerClientId === cid
          const peer: Peer & { tabCount: number; freshest: number } = {
            clientId: cid,
            id,
            name,
            color,
mode,
            slide: appSlide,
            where: appWhere,
            selectedId,
            selectedLabel: undefined,
            isOwner: isOwnerNow,
            isSelf: id === o.selfUserId || (!o.selfUserId && cid === selfClientId),
            device,
            tabCount: prev.tabCount,
            lastEditAt,
            lastActiveAt,
            freshest,
          }
          if (peer.selectedId && o.getSelectedLabel) {
            peer.selectedLabel = o.getSelectedLabel(peer.selectedId, peer.slide)
          }
          byId.set(id, peer)
        } else {
          // 대표가 유지되더라도 활동/편집 시각은 최댓값을 유지한다.
          prev.lastEditAt = maxTime(lastEditAt, prev.lastEditAt)
          prev.lastActiveAt = maxTime(lastActiveAt, prev.lastActiveAt)
        }
        continue
      }
      const peer: Peer & { tabCount: number; freshest: number } = {
        clientId: cid,
        id,
        name,
        color,
        mode,
        slide: appSlide,
        where: appWhere,
        selectedId,
        selectedLabel: undefined,
        isOwner: o.ownerClientId != null && o.ownerClientId === cid,
        isSelf: id === o.selfUserId || (!o.selfUserId && cid === selfClientId),
        device,
        tabCount: 1,
        lastEditAt,
        lastActiveAt,
        freshest,
      }
      if (peer.selectedId && o.getSelectedLabel) {
        peer.selectedLabel = o.getSelectedLabel(peer.selectedId, peer.slide)
      }
      byId.set(id, peer)
    }
    const next = [...byId.values()].map(({ freshest: _freshest, ...p }) => ({ ...p }))
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
      x.mode !== y.mode || x.slide !== y.slide || x.where !== y.where || x.selectedId !== y.selectedId ||
      x.selectedLabel !== y.selectedLabel || x.isOwner !== y.isOwner || x.isSelf !== y.isSelf ||
      x.device !== y.device || x.tabCount !== y.tabCount || x.lastEditAt !== y.lastEditAt ||
      peerActivity(x, now) !== peerActivity(y, now)
    ) {
      return false
    }
  }
  return true
}
