import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  clearSessionCommandRuns,
  createCommandRun,
  deleteCommandRun,
  finishCommandRun,
  listCommandRunsByRange,
  listCommandRunsBySession,
  setCommandRunMessage,
  type CommandRun,
  type CommandRunStatus,
  type CreateCommandRunInput,
} from '@/api/command-runs'
import { dateKey } from '@/lib/cron'
import { showToast } from '@/lib/toast'

export const commandRunKeys = {
  all: ['command-runs'] as const,
  range: (start: Date, end: Date) => ['command-runs', 'range', dateKey(start), dateKey(end)] as const,
  session: (sessionId: string) => ['command-runs', 'session', sessionId] as const,
}

/** 달력 뷰(6주 윈도우) 범위의 run 목록. 서버 DB 가 단일 진실 공급원. */
export function useCommandRunsInRange(start: Date, end: Date, enabled = true) {
  return useQuery({
    queryKey: commandRunKeys.range(start, end),
    // 윈도우 경계 포함: start 00:00:00.000 ~ end 23:59:59.999
    queryFn: () => {
      const from = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime()
      const to = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999).getTime()
      return listCommandRunsByRange(from, to)
    },
    enabled,
    staleTime: 15_000,
  })
}

export function useCommandRunsBySession(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: commandRunKeys.session(sessionId),
    queryFn: () => listCommandRunsBySession(sessionId),
    enabled: enabled && !!sessionId,
  })
}

function useInvalidateRuns() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: commandRunKeys.all })
}

export function useCreateCommandRun() {
  const invalidate = useInvalidateRuns()
  return useMutation<CommandRun, Error, CreateCommandRunInput>({
    mutationFn: createCommandRun,
    onSuccess: () => { void invalidate() },
    onError: (error) => {
      // 조용한 유실 방지: 예전 store 는 console.warn 만 했다.
      showToast.error(`Failed to record command history: ${error.message}`)
    },
  })
}

export function useFinishCommandRun() {
  const invalidate = useInvalidateRuns()
  return useMutation<void, Error, { id: string; status: Exclude<CommandRunStatus, 'started'> }>({
    mutationFn: ({ id, status }) => finishCommandRun(id, status),
    onSuccess: () => { void invalidate() },
    onError: (error) => console.warn('[commandRuns] finish failed:', error),
  })
}

export function useSetCommandRunMessage() {
  const invalidate = useInvalidateRuns()
  return useMutation<void, Error, { id: string; messageId: string }>({
    mutationFn: ({ id, messageId }) => setCommandRunMessage(id, messageId),
    onSuccess: () => { void invalidate() },
    onError: (error) => console.warn('[commandRuns] setMessage failed:', error),
  })
}

export function useDeleteCommandRun() {
  const invalidate = useInvalidateRuns()
  return useMutation<void, Error, string>({
    mutationFn: deleteCommandRun,
    onSuccess: () => { void invalidate() },
    onError: (error) => showToast.error(`Failed to delete: ${error.message}`),
  })
}

export function useClearSessionCommandRuns() {
  const invalidate = useInvalidateRuns()
  return useMutation<void, Error, string>({
    mutationFn: clearSessionCommandRuns,
    onSuccess: () => { void invalidate() },
    onError: (error) => showToast.error(`Failed to clear: ${error.message}`),
  })
}
