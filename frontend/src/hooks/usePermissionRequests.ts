import { useCallback, useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
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

export function usePendingPermissionCounts(): Record<string, number> {
  const allPermissions = usePermissionStore((state) => state.permissions)
  return useMemo(() => {
    const counts: Record<string, number> = {}
    for (const p of allPermissions) {
      counts[p.sessionID] = (counts[p.sessionID] ?? 0) + 1
    }
    return counts
  }, [allPermissions])
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

export function useLoadPendingPermissions(client: { listPermissions(): Promise<unknown[]> } | null, sessionID?: string) {
  useEffect(() => {
    if (!client) return
    let cancelled = false

    const load = async () => {
      try {
        const pending = await client.listPermissions()
        if (cancelled) return
        const scope = sessionID
          ? pending.filter((p) => (p as { sessionID?: string }).sessionID === sessionID)
          : pending
        const serverIDs = new Set<string>()
        for (const p of scope) {
          const permission = normalizePermission(p)
          if (permission) {
            serverIDs.add(permission.id)
            permissionEvents.emit({ type: 'add', permission })
          }
        }
        const current = usePermissionStore.getState().permissions
        const stale = current.filter((p) => {
          if (sessionID && p.sessionID !== sessionID) return false
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
    const interval = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [client, sessionID])
}

export function usePermissionRequests(sessionID?: string) {
  const allPermissions = usePermissionStore((state) => state.permissions)

  const permissions = useMemo(
    () => sessionID
      ? allPermissions.filter(p => p.sessionID === sessionID)
      : allPermissions,
    [allPermissions, sessionID],
  )

  const currentPermission = permissions[0] || null

  const dismissPermission = useCallback((permissionID: string) => {
    usePermissionStore.setState((state) => ({
      permissions: state.permissions.filter(p => p.id !== permissionID),
    }))
  }, [])

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
