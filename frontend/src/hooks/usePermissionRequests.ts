import { useCallback, useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useQueryClient } from '@tanstack/react-query'
import type { Permission } from '@/api/types'
import { showToast } from '@/lib/toast'

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

const usePermissionStore = create<PermissionStore, [['zustand/persist', Pick<PermissionStore, 'permissions'>]]>(
  persist(
    (): PermissionStore => ({
      permissions: [],
    }),
    {
      name: 'opencode-webui-permissions',
      partialize: (state) => ({ permissions: state.permissions }),
    },
  ),
)

let storeSubscriptionStarted = false

/** 낙관 dismiss 직후 폴링이 미처리 요청을 되살려 깜빡이는 것을 막는 가드. */
const RECENTLY_DISMISSED_MS = 12_000
const recentlyDismissed = new Map<string, number>()

export function markPermissionDismissed(permissionID: string): void {
  recentlyDismissed.set(permissionID, Date.now())
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

let lastPermissionErrorToast = 0
export function useLoadPendingPermissions(client: { listPermissions(): Promise<unknown[]> } | null, sessionID?: string, relatedSessionIDs?: string[]) {
  useEffect(() => {
    if (!client) return
    let cancelled = false

    const scopeIDs = sessionID ? new Set([sessionID, ...(relatedSessionIDs ?? [])]) : null

    const load = async () => {
      try {
        const pending = await client.listPermissions()
        if (cancelled) return
        const scope = scopeIDs
          ? pending.filter((p) => scopeIDs.has((p as { sessionID?: string }).sessionID ?? ''))
          : pending
        const serverIDs = new Set<string>()
        for (const p of scope) {
          const permission = normalizePermission(p)
          if (permission) {
            serverIDs.add(permission.id)
            if (!isRecentlyDismissed(permission.id)) {
              permissionEvents.emit({ type: 'add', permission })
            }
          }
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
        const now = Date.now()
        if (now - lastPermissionErrorToast > 30000) {
          lastPermissionErrorToast = now
          const msg = error instanceof Error ? error.message : String(error)
          showToast.error(`[Poll] permissions 500: ${msg} - opencode/backend connection check`, { duration: 5000 })
        }
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
    usePermissionStore.setState((state) => ({
      permissions: state.permissions.filter(p => p.id !== permissionID),
    }))
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
