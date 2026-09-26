import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { enqueueQueuedChat, listQueuedChats, moveQueuedChat, removeQueuedChat, retryQueuedChat, setQueuePaused, updateQueuedChatsModel, type EnqueueChatOptions } from '@/api/chat-queue'
import { showToast } from '@/lib/toast'

export const chatQueueKeys = {
  all: ['chat-queue'] as const,
  session: (sessionID: string) => ['chat-queue', sessionID] as const,
}

// 삭제한 항목이 서버에 반영되기 전 뜬 폴링이 되살리지 못하게 5초간 무시
const RECENTLY_REMOVED_MS = 5000
// 폴링 때만 만료 청소되므로 상한을 둔다 (삭제 많은 세션 무한 누적 방지)
const RECENTLY_REMOVED_MAX = 500
const recentlyRemovedAt = new Map<string, number>()
function trackRemoved(key: string): void {
  recentlyRemovedAt.set(key, Date.now())
  while (recentlyRemovedAt.size > RECENTLY_REMOVED_MAX) {
    const oldest = recentlyRemovedAt.keys().next().value as string | undefined
    if (oldest === undefined) break
    recentlyRemovedAt.delete(oldest)
  }
}

export function useQueuedChats(sessionID?: string | null) {
  return useQuery({
    queryKey: chatQueueKeys.session(sessionID ?? ''),
    queryFn: async () => {
      const list = await listQueuedChats(sessionID!)
      // 삭제 직후 뜬 폴링이 서버 반영 전 목록으로 되살리는 것 방지 (5초간 무시)
      const now = Date.now()
      return list.filter((item) => {
        const key = `${sessionID}:${item.id}`
        const at = recentlyRemovedAt.get(key)
        if (at == null) return true
        if (now - at > RECENTLY_REMOVED_MS) {
          recentlyRemovedAt.delete(key)
          return true
        }
        return false
      })
    },
    enabled: !!sessionID,
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  })
}

export function useEnqueueQueuedChat() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ sessionID, text, directory, model, agent, reviewWanted, autoApply }: { sessionID: string; text: string; directory?: string } & EnqueueChatOptions) =>
      enqueueQueuedChat(sessionID, text, directory, { model, agent, reviewWanted, autoApply }),
    onSuccess: (queue, { sessionID }) => {
      queryClient.setQueryData(chatQueueKeys.session(sessionID), queue)
    },
    onError: (error) => {
      showToast.error(error instanceof Error ? error.message : 'Failed to queue message', { duration: 5000 })
    },
  })
}

export function useRemoveQueuedChat() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ sessionID, id }: { sessionID: string; id: string }) =>
      removeQueuedChat(sessionID, id),
    onMutate: async ({ sessionID, id }) => {
      // 낙관 제거: 진행 중·직후 폴링이 옛날 목록으로 되살리기 전에 즉시 화면에서 뺀다.
      await queryClient.cancelQueries({ queryKey: chatQueueKeys.session(sessionID) })
      trackRemoved(`${sessionID}:${id}`)
      const previous = queryClient.getQueryData<{ id: string }[]>(chatQueueKeys.session(sessionID))
      queryClient.setQueryData(chatQueueKeys.session(sessionID), (old: { id: string }[] | undefined) =>
        (old ?? []).filter((item) => item.id !== id),
      )
      return { previous }
    },
    onError: (_error, { sessionID, id }, context) => {
      // 실패 시 롤백 (다음 폴링에서도 살아나지만 즉시 복원)
      recentlyRemovedAt.delete(`${sessionID}:${id}`)
      if (context?.previous) {
        queryClient.setQueryData(chatQueueKeys.session(sessionID), context.previous)
      }
      showToast.error('Failed to remove queued message', { duration: 4000 })
    },
    onSuccess: (_data, { sessionID }) => {
      queryClient.invalidateQueries({ queryKey: chatQueueKeys.session(sessionID) })
    },
  })
}

export function useMoveQueuedChat() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ sessionID, id, toTop }: { sessionID: string; id: string; toTop: boolean }) =>
      moveQueuedChat(sessionID, id, toTop),
    onSuccess: (queue, { sessionID }) => {
      queryClient.setQueryData(chatQueueKeys.session(sessionID), queue)
    },
    onError: (error) => {
      showToast.error(error instanceof Error ? error.message : 'Failed to reorder queue', { duration: 5000 })
    },
  })
}

export function useRetryQueuedChat() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ sessionID, id }: { sessionID: string; id: string }) =>
      retryQueuedChat(sessionID, id),
    onSuccess: (queue, { sessionID }) => {
      queryClient.setQueryData(chatQueueKeys.session(sessionID), queue)
    },
    onError: (error) => {
      showToast.error(error instanceof Error ? error.message : 'Failed to retry queued message', { duration: 5000 })
    },
  })
}

export function useSetQueuePaused() {
  return useMutation({
    mutationFn: ({ sessionID, paused }: { sessionID: string; paused: boolean }) =>
      setQueuePaused(sessionID, paused),
    onError: (error) => {
      showToast.error(error instanceof Error ? error.message : 'Failed to set queue pause', { duration: 4000 })
    },
  })
}

/**
 * 세션 모델 변경 시 큐의 스냅샷 모델 동기화용.
 * 실패해도 세션 전환 자체를 되돌리지 않는다 — 큐 다음 발송이 stale 모델로
 * 나갈 수 있다는 경고만 남긴다 (ModelSelectDialog에서 호출).
 */
export function useUpdateQueuedChatsModel() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ sessionID, providerID, modelID }: { sessionID: string; providerID: string; modelID: string }) =>
      updateQueuedChatsModel(sessionID, { providerID, modelID }),
    onSuccess: (queue, { sessionID }) => {
      queryClient.setQueryData(chatQueueKeys.session(sessionID), queue)
    },
  })
}
