import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  listPermissionRules,
  createPermissionRule,
  deletePermissionRule,
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
