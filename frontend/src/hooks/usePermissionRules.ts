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
    enabled: repoId !== undefined && repoId !== null && !!repoId,
  })
}

export function useCreatePermissionRule() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ repoId, permission, pattern }: { repoId: number; permission: string; pattern: string }) =>
      createPermissionRule(repoId, permission, pattern),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['permission-rules', variables.repoId] })
    },
  })
}

export function useDeletePermissionRule() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { id: number; repoId: number }) => deletePermissionRule(input.id),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['permission-rules', variables.repoId] })
    },
  })
}
