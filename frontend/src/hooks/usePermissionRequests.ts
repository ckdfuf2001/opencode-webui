import { useCallback, useEffect, useMemo, useRef } from 'react'
import { create } from 'zustand'
import { showToast } from '@/lib/toast'
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
  notifiedIDs: Record<string, boolean>
}

const usePermissionStore = create<PermissionStore>(() => ({
  permissions: [],
  notifiedIDs: {},
}))

function toastPermissions(): void {
  const { permissions, notifiedIDs } = usePermissionStore.getState()
  for (const permission of permissions) {
    if (notifiedIDs[permission.id]) continue
    const typeLabel = permission.permission ?? permission.type ?? 'permission'
    const description = permission.metadata?.command
      ?? permission.metadata?.path
      ?? permission.metadata?.url
      ?? ''
    showToast.info(`Permission requested: ${typeLabel}`, {
      id: `permission-${permission.id}`,
      description: description ? String(description).slice(0, 120) : undefined,
      duration: 10000,
    })
    usePermissionStore.setState((state) => ({
      notifiedIDs: { ...state.notifiedIDs, [permission.id]: true },
    }))
  }
}

export function usePermissionRequests() {
  const permissions = usePermissionStore((state) => state.permissions)
  const subscribeStartedRef = useRef(false)

  useEffect(() => {
    if (subscribeStartedRef.current) return
    subscribeStartedRef.current = true

    const unsubscribe = permissionEvents.subscribe((event) => {
      if (event.type === 'add' && event.permission) {
        usePermissionStore.setState((state) => {
          const exists = state.permissions.some(p => p.id === event.permission!.id)
          if (exists) return state
          return { permissions: [...state.permissions, event.permission!] }
        })
        toastPermissions()
      } else if (event.type === 'remove' && event.permissionID) {
        usePermissionStore.setState((state) => ({
          permissions: state.permissions.filter(p => p.id !== event.permissionID),
        }))
      }
    })
    return unsubscribe
  }, [])

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
