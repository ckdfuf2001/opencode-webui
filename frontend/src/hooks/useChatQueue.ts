import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { enqueueQueuedChat, listQueuedChats, moveQueuedChat, removeQueuedChat } from '@/api/chat-queue'
import { showToast } from '@/lib/toast'

export const chatQueueKeys = {
  all: ['chat-queue'] as const,
  session: (sessionID: string) => ['chat-queue', sessionID] as const,
}

export function useQueuedChats(sessionID?: string | null) {
  return useQuery({
    queryKey: chatQueueKeys.session(sessionID ?? ''),
    queryFn: () => listQueuedChats(sessionID!),
    enabled: !!sessionID,
    refetchInterval: 2000,
  })
}

export function useEnqueueQueuedChat() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ sessionID, text }: { sessionID: string; text: string }) =>
      enqueueQueuedChat(sessionID, text),
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
    onMutate: ({ sessionID, id }) => {
      // 낙관 제거: 폴링이 되살리기 전에 즉시 화면에서 뺀다.
      queryClient.setQueryData(chatQueueKeys.session(sessionID), (old: { id: string }[] | undefined) =>
        (old ?? []).filter((item) => item.id !== id),
      )
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
