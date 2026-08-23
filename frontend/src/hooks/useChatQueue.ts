import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { enqueueQueuedChat, listQueuedChats, removeQueuedChat } from '@/api/chat-queue'
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
    refetchInterval: 5000,
  })
}

export function useEnqueueQueuedChat() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ sessionID, text }: { sessionID: string; text: string }) =>
      enqueueQueuedChat(sessionID, text),
    onSuccess: (queue, { sessionID }) => {
      queryClient.setQueryData(chatQueueKeys.session(sessionID), queue)
      showToast.info(`Queued — will send after the current response (#${queue.length})`, { duration: 3000 })
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
    onSuccess: (_data, { sessionID }) => {
      queryClient.invalidateQueries({ queryKey: chatQueueKeys.session(sessionID) })
    },
  })
}
