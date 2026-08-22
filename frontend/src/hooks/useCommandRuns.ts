import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  clearSessionCommandRuns,
  createCommandRun,
  deleteCommandRun,
  fetchCommandRunView,
  finishCommandRun,
  listCommandRunsByRange,
  listCommandRunsBySession,
  setCommandRunMessage,
  type CommandRun,
  type CommandRunViewScope,
  type CommandRunStatus,
  type CreateCommandRunInput,
} from '@/api/command-runs'
import { dateKey } from '@/lib/cron'
import { showToast } from '@/lib/toast'

export const commandRunKeys = {
  all: ['command-runs'] as const,
  range: (start: Date, end: Date) => ['command-runs', 'range', dateKey(start), dateKey(end)] as const,
  session: (sessionId: string) => ['command-runs', 'session', sessionId] as const,
  view: (scope: CommandRunViewScope, repoId: number | undefined, sessionId: string | undefined, start?: Date, end?: Date) =>
    ['command-runs', 'view', scope, repoId ?? null, sessionId ?? null, start ? dateKey(start) : null, end ? dateKey(end) : null] as const,
}

/**
 * 커맨드 패널/캘린더용 스코프 뷰. 서버가 스코프 필터링과
 * repoName·sessionTitle 채움을 담당한다. enabled가 open에 묶여
 * 패널을 열 때마다(=페이지 이동 후 첫 오픈) 최신값을 받아온다.
 */
export function useCommandRunView(
  scope: CommandRunViewScope,
  repoId: number | undefined,
  sessionId: string | undefined,
  start?: Date,
  end?: Date,
  enabled = true,
) {
  useEffect(() => {
    console.debug('[useCommandRunView] v2 mounted', { scope, repoId, sessionId })
  }, [])
  return useQuery({
    queryKey: commandRunKeys.view(scope, repoId, sessionId, start, end),
    queryFn: () => fetchCommandRunView({ scope, repoId, sessionId, start, end }),
    enabled,
    refetchOnMount: 'always',
    staleTime: 0,
  })
}
/** 달력 뷰(6주 윈도우) 범위의 run 목록. */
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
