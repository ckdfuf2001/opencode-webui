import { useCallback, useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { useQueryClient } from '@tanstack/react-query'
import type { Permission } from '@/api/types'

type PermissionEventType = 'add' | 'remove'

interface PermissionEvent {
  type: PermissionEventType
  permission?: Permission
  permissionID?: string
}

type PermissionListener = (event: PermissionEvent) => void

const listeners = new Set<PermissionListener>()

export const permissionEvents = {
  emit: (event: PermissionEvent) => {
    listeners.forEach(listener => listener(event))
  },
  subscribe: (listener: PermissionListener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
}

interface PermissionStore {
  permissions: Permission[]
}

// 수 분 내 소멸하는 임시 데이터라 persist하지 않는다 — 매 setState마다
// localStorage 직렬화+쓰기가 일어나 힙/IO를 잡아먹는다. 마운트 시 서버에서 다시 읽는다.
const usePermissionStore = create<PermissionStore>()((): PermissionStore => ({
  permissions: [],
}))

let storeSubscriptionStarted = false

/** ?��? dismiss 직후 ?�링??미처�??�청???�살??깜빡?�는 것을 막는 가?? */
const RECENTLY_DISMISSED_MS = 12_000
const recentlyDismissed = new Map<string, number>()

// 조회될 때만 만료 청소되므로 상한을 둔다 (장시간 세션 무한 누적 방지)
const RECENTLY_DISMISSED_MAX = 500
export function markPermissionDismissed(permissionID: string): void {
  recentlyDismissed.set(permissionID, Date.now())
  while (recentlyDismissed.size > RECENTLY_DISMISSED_MAX) {
    const oldest = recentlyDismissed.keys().next().value as string | undefined
    if (oldest === undefined) break
    recentlyDismissed.delete(oldest)
  }
}

function isRecentlyDismissed(permissionID: string): boolean {
  const at = recentlyDismissed.get(permissionID)
  if (!at) return false
  if (Date.now() - at > RECENTLY_DISMISSED_MS) {
    recentlyDismissed.delete(permissionID)
    return false
  }
  return true
}

// 백엔드 자동승인 레이스 완화: 처음 본 요청은 1회 유예하고,
// 다음 폴링에도 살아있을 때만 다이얼로그 스토어에 올린다.
// 그 사이 승인되면 깜빡임 없이 사라진다. (폴링 2초 > 유예 1.5초라
// 사실상 "2회 연속 목격" 조건이다.)
const PERMISSION_GRACE_MS = 1500
const pendingFirstSeen = new Map<string, number>()
const PENDING_FIRST_SEEN_MAX = 500

function startStoreSubscription(): void {
  if (storeSubscriptionStarted) return
  storeSubscriptionStarted = true
  permissionEvents.subscribe((event) => {
    if (event.type === 'add' && event.permission) {
      usePermissionStore.setState((state) => {
        const exists = state.permissions.some(p => p.id === event.permission!.id)
        if (exists) return state
        return { permissions: [...state.permissions, event.permission!] }
      })
    } else if (event.type === 'remove' && event.permissionID) {
      usePermissionStore.setState((state) => ({
        permissions: state.permissions.filter(p => p.id !== event.permissionID),
      }))
    }
  })
}

function pruneStalePermissions(): void {
  usePermissionStore.setState((state) => {
    const now = Date.now()
    const fresh = state.permissions.filter((p) => now - (p.time?.created ?? now) < 10 * 60 * 1000)
    return fresh.length === state.permissions.length ? state : { permissions: fresh }
  })
}

startStoreSubscription()
pruneStalePermissions()

export function collectDescendantIDs(sessions: { id: string; parentID?: string }[], sessionID: string): string[] {
  const byParent = new Map<string, string[]>()
  for (const s of sessions) {
    if (!s.parentID) continue
    const children = byParent.get(s.parentID)
    if (children) {
      children.push(s.id)
    } else {
      byParent.set(s.parentID, [s.id])
    }
  }
  const result: string[] = []
  const queue = byParent.get(sessionID) ?? []
  while (queue.length > 0) {
    const id = queue.shift()!
    result.push(id)
    const children = byParent.get(id)
    if (children) queue.push(...children)
  }
  return result
}

export function usePendingPermissionCounts(sessions?: { id: string; parentID?: string }[]): Record<string, number> {
  const allPermissions = usePermissionStore((state) => state.permissions)
  return useMemo(() => {
    const counts: Record<string, number> = {}
    for (const p of allPermissions) {
      counts[p.sessionID] = (counts[p.sessionID] ?? 0) + 1
    }
    if (sessions) {
      const directCounts = { ...counts }
      for (const s of sessions) {
        const descendants = collectDescendantIDs(sessions, s.id)
        if (descendants.length === 0) continue
        const descendantCount = descendants.reduce((sum, id) => sum + (directCounts[id] ?? 0), 0)
        if (descendantCount > 0) {
          counts[s.id] = (counts[s.id] ?? 0) + descendantCount
        }
      }
    }
    return counts
  }, [allPermissions, sessions])
}

function normalizePermission(raw: unknown): Permission | null {
  const r = raw as {
    id: string
    sessionID: string
    permission?: string
    patterns?: string[]
    pattern?: string | string[]
    always?: string[]
    metadata?: Record<string, unknown>
    tool?: { messageID?: string; callID?: string }
  }
  if (!r.id || !r.sessionID) return null
  const rawPatterns = r.patterns ?? r.pattern
  const patterns = Array.isArray(rawPatterns) ? rawPatterns : rawPatterns ? [rawPatterns] : []
  const type = r.permission ?? 'permission'
  return {
    id: r.id,
    sessionID: r.sessionID,
    type,
    permission: r.permission,
    pattern: patterns,
    patterns,
    always: r.always,
    metadata: r.metadata ?? {},
    title: `Allow ${type}?`,
    messageID: r.tool?.messageID ?? '',
    callID: r.tool?.callID,
    tool: r.tool,
    time: { created: Date.now() },
  }
}

export function useLoadPendingPermissions(client: { listPermissions(): Promise<unknown[]> } | null, sessionID?: string, relatedSessionIDs?: string[]) {
  useEffect(() => {
    if (!client) return
    let cancelled = false

    const scopeIDs = sessionID ? new Set([sessionID, ...(relatedSessionIDs ?? [])]) : null

    const load = async () => {
      // 백그라운드 탭에서는 폴링 스킵 — 브라우저 스로틀만 믿지 않는다
      if (typeof document !== 'undefined' && document.hidden) return
      try {
        const pending = await client.listPermissions()
        if (cancelled) return
        const scope = scopeIDs
          ? pending.filter((p) => scopeIDs.has((p as { sessionID?: string }).sessionID ?? ''))
          : pending
        const serverIDs = new Set<string>()
        const seenNow = Date.now()
        for (const p of scope) {
          const permission = normalizePermission(p)
          if (permission) {
            serverIDs.add(permission.id)
            if (isRecentlyDismissed(permission.id)) continue
            const alreadyShown = usePermissionStore
              .getState()
              .permissions.some((s) => s.id === permission.id)
            if (alreadyShown) {
              pendingFirstSeen.delete(permission.id)
              continue
            }
            const firstSeen = pendingFirstSeen.get(permission.id)
            if (firstSeen == null) {
              pendingFirstSeen.set(permission.id, seenNow)
              while (pendingFirstSeen.size > PENDING_FIRST_SEEN_MAX) {
                const oldest = pendingFirstSeen.keys().next().value as string | undefined
                if (oldest === undefined) break
                pendingFirstSeen.delete(oldest)
              }
              continue
            }
            if (seenNow - firstSeen < PERMISSION_GRACE_MS) continue
            pendingFirstSeen.delete(permission.id)
            permissionEvents.emit({ type: 'add', permission })
          }
        }
        for (const id of [...pendingFirstSeen.keys()]) {
          if (!serverIDs.has(id)) pendingFirstSeen.delete(id)
        }
        const current = usePermissionStore.getState().permissions
        const stale = current.filter((p) => {
          if (scopeIDs && !scopeIDs.has(p.sessionID)) return false
          return !serverIDs.has(p.id)
        })
        if (stale.length > 0) {
          usePermissionStore.setState((state) => ({
            permissions: state.permissions.filter((p) => !stale.some((s) => s.id === p.id)),
          }))
        }
      } catch (error) {
        console.error('Failed to load pending permissions:', error)
      }
    }

    load()
    const interval = setInterval(load, 2000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [client, sessionID, relatedSessionIDs])
}

export function usePermissionRequests(sessionID?: string, relatedSessionIDs?: string[]) {
  const allPermissions = usePermissionStore((state) => state.permissions)
  const queryClient = useQueryClient()

  const scopeIDs = useMemo(() => {
    const ids = new Set<string>()
    if (sessionID) ids.add(sessionID)
    for (const id of relatedSessionIDs ?? []) ids.add(id)
    return ids
  }, [sessionID, relatedSessionIDs])

  const permissions = useMemo(
    () => scopeIDs.size > 0
      ? allPermissions.filter(p => scopeIDs.has(p.sessionID))
      : allPermissions,
    [allPermissions, scopeIDs],
  )

  const currentPermission = permissions[0] || null

  const dismissPermission = useCallback((permissionID: string) => {
    markPermissionDismissed(permissionID)
    const sid = usePermissionStore.getState().permissions.find(p => p.id === permissionID)?.sessionID
    usePermissionStore.setState((state) => ({
      permissions: state.permissions.filter(p => p.id !== permissionID),
    }))
    // 배지(방패) 즉시 정리 — 백엔드 1s + 프론트 2s 폴링을 기다리면 수 초간 잔류
    if (sid) {
      queryClient.setQueryData(['session-status-db'], (old: unknown) => {
        if (!Array.isArray(old)) return old
        return (old as Array<{ sessionId: string; pendingPermissions?: number }>).map((s) =>
          s?.sessionId === sid ? { ...s, pendingPermissions: Math.max(0, (s.pendingPermissions ?? 1) - 1) } : s,
        )
      })
    }
    queryClient.invalidateQueries({ queryKey: ['session-status-db'] })
  }, [queryClient])

  const clearAllPermissions = useCallback(() => {
    usePermissionStore.setState({ permissions: [] })
  }, [])

  return useMemo(() => ({
    currentPermission,
    pendingCount: permissions.length,
    dismissPermission,
    clearAllPermissions,
  }), [currentPermission, permissions.length, dismissPermission, clearAllPermissions])
}

