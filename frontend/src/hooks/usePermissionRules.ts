import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  listPermissionRules,
  createPermissionRule,
  deletePermissionRule,
  listSessionPermissionRules,
  createSessionPermissionRule,
  deleteSessionPermissionRule,
} from '@/api/permission-rules'

export function usePermissionRules(repoId?: number) {
  return useQuery({
    queryKey: ['permission-rules', repoId ?? 'global'],
    queryFn: () => listPermissionRules(repoId),
    enabled: true,
  })
}

/** Settings 전역 탭용: 전역 룰만 (scope=global). */
export function useGlobalPermissionRules() {
  return useQuery({
    queryKey: ['permission-rules', 'global-scope'],
    queryFn: () => listPermissionRules(undefined, 'global'),
    enabled: true,
  })
}

export function useCreatePermissionRule() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ repoId, permission, pattern }: { repoId: number | null; permission: string; pattern: string }) =>
      createPermissionRule(repoId, permission, pattern),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['permission-rules', variables.repoId ?? 'global'] })
      queryClient.invalidateQueries({ queryKey: ['permission-rules', 'global-scope'] })
    },
  })
}

export function useDeletePermissionRule() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { id: number; repoId?: number | null }) => deletePermissionRule(input.id),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['permission-rules', variables.repoId ?? 'global'] })
      queryClient.invalidateQueries({ queryKey: ['permission-rules', 'global-scope'] })
    },
  })
}

/** 세션 전용 룰 (백단 소유 — 탭 닫힘과 무관하게 자동승인된다). */
export function useSessionPermissionRules(sessionId?: string | null) {
  return useQuery({
    queryKey: ['session-permission-rules', sessionId ?? ''],
    queryFn: () => listSessionPermissionRules(sessionId!),
    enabled: !!sessionId,
  })
}

export function useCreateSessionPermissionRule() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ sessionId, permission, pattern }: { sessionId: string; permission: string; pattern: string }) =>
      createSessionPermissionRule(sessionId, permission, pattern),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['session-permission-rules', variables.sessionId] })
    },
  })
}

export function useDeleteSessionPermissionRule() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id }: { id: string; sessionId: string }) => deleteSessionPermissionRule(id),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['session-permission-rules', variables.sessionId] })
    },
  })
}
