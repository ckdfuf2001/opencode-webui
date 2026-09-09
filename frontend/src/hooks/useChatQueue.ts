import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { enqueueQueuedChat, listQueuedChats, moveQueuedChat, removeQueuedChat } from '@/api/chat-queue'
import { showToast } from '@/lib/toast'

export const chatQueueKeys = {
  all: ['chat-queue'] as const,
  session: (sessionID: string) => ['chat-queue', sessionID] as const,
}

// 삭제한 항목이 서버에 반영되기 전 뜬 폴링이 되살리지 못하게 5초간 무시
const RECENTLY_REMOVED_MS = 5000
const recentlyRemovedAt = new Map<string, number>()

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
    refetchOnReconnect: false,
  })
}

export function useEnqueueQueuedChat() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ sessionID, text, directory }: { sessionID: string; text: string; directory?: string }) =>
      enqueueQueuedChat(sessionID, text, directory),
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
      recentlyRemovedAt.set(`${sessionID}:${id}`, Date.now())
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
