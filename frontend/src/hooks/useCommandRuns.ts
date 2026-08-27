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
 * 而ㅻ㎤???⑤꼸/罹섎┛?붿슜 ?ㅼ퐫??酉? ?쒕쾭媛 ?ㅼ퐫???꾪꽣留곴낵
 * repoName쨌sessionTitle 梨꾩????대떦?쒕떎. enabled媛 open??臾띠뿬
 * ?⑤꼸?????뚮쭏??=?섏씠吏 ?대룞 ??泥??ㅽ뵂) 理쒖떊媛믪쓣 諛쏆븘?⑤떎.
 */
export function useCommandRunView(
  scope: CommandRunViewScope,
  repoId: number | undefined,
  sessionId: string | undefined,
  start?: Date,
  end?: Date,
  enabled = true,
) {
  return useQuery({
    queryKey: commandRunKeys.view(scope, repoId, sessionId, start, end),
    queryFn: () => fetchCommandRunView({ scope, repoId, sessionId, start, end }),
    enabled,
    // ?좎뼵???대쭅: 而댄룷?뚰듃 ?섎챸怨?臾닿??섍쾶 ?듭뀡??利됱떆 ?곸슜?쒕떎.
    refetchOnMount: 'always',
    refetchInterval: enabled ? 5_000 : false,
    refetchIntervalInBackground: true,
    staleTime: 0,
  })
}
/** ?щ젰 酉?6二??덈룄?? 踰붿쐞??run 紐⑸줉. */
export function useCommandRunsInRange(start: Date, end: Date, enabled = true) {
  return useQuery({
    queryKey: commandRunKeys.range(start, end),
    // ?덈룄??寃쎄퀎 ?ы븿: start 00:00:00.000 ~ end 23:59:59.999
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
      // 議곗슜???좎떎 諛⑹?: ?덉쟾 store ??console.warn 留??덈떎.
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

