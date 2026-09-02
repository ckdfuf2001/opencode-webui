import { useMemo } from 'react'
import { useMessages } from './useOpenCode'
import { useSettings } from './useSettings'
import { useQuery } from '@tanstack/react-query'
import type { components } from '@/api/opencode-types'

type AssistantMessage = components['schemas']['AssistantMessage']

type MessageListItem = {
  info: components['schemas']['Message']
  parts: components['schemas']['Part'][]
}

interface ContextUsage {
  totalTokens: number
  contextLimit: number | null
  usagePercentage: number | null
  currentModel: string | null
  isLoading: boolean
}

interface ModelLimit {
  context: number
  output: number
}

interface ProviderModel {
  id: string
  name: string
  limit: ModelLimit
}

interface Provider {
  id: string
  name: string
  models: Record<string, ProviderModel>
}

interface ProvidersResponse {
  providers: Provider[]
}

const isAssistantMessage = (message: MessageListItem): message is MessageListItem & { info: AssistantMessage } => {
  return message.info.role === 'assistant'
}

async function fetchProviders(opcodeUrl: string): Promise<ProvidersResponse> {
  const response = await fetch(`${opcodeUrl}/config/providers`)
  if (!response.ok) {
    throw new Error('Failed to fetch providers')
  }
  return response.json()
}

export const useContextUsage = (opcodeUrl: string | null | undefined, sessionID: string | undefined, directory?: string): ContextUsage => {
  const { data: messages, isLoading: messagesLoading } = useMessages(opcodeUrl, sessionID, directory)
  const { preferences } = useSettings()

  const { data: providersData } = useQuery({
    queryKey: ['providers', opcodeUrl],
    queryFn: () => fetchProviders(opcodeUrl!),
    enabled: !!opcodeUrl,
    staleTime: 5 * 60 * 1000,
  })

  return useMemo(() => {
    // Get current model from preferences immediately
    let currentModel = preferences?.defaultModel || null

    if (!messages || messages.length === 0) {
      // Still try to get context limit from preferences model even without messages
      let contextLimit: number | null = null
      
      if (currentModel && providersData) {
        const [providerId, modelId] = currentModel.split('/')
        const provider = providersData.providers.find(p => p.id === providerId)
        if (provider && provider.models) {
          const model = provider.models[modelId]
          if (model && model.limit) {
            contextLimit = model.limit.context
          }
        }
      }

      return {
        totalTokens: 0,
        contextLimit,
        usagePercentage: contextLimit ? 0 : null,
        currentModel,
        isLoading: messagesLoading
      }
    }
    
    // Context window usage: latest assistant message's tokens represent current window.
    // Summing all messages inflates to 900%+ — must use single turn, not cumulative.
    const assistantMessages = messages.filter(isAssistantMessage)
    let latestAssistantMessage = assistantMessages[assistantMessages.length - 1]

    // If the latest message has 0 tokens (still being created), use the previous one
    if (latestAssistantMessage) {
      const t = (latestAssistantMessage.info as unknown as { tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } }).tokens
      const latestTokens = ((t?.input ?? 0) + (t?.output ?? 0) + (t?.reasoning ?? 0) + (t?.cache?.read ?? 0) + (t?.cache?.write ?? 0))
      if (latestTokens === 0 && assistantMessages.length > 1) {
        latestAssistantMessage = assistantMessages[assistantMessages.length - 2]
      }
    }

    let totalTokens = 0
    if (latestAssistantMessage) {
      const t = (latestAssistantMessage.info as unknown as { tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } }).tokens
      totalTokens = ((t?.input ?? 0) + (t?.output ?? 0) + (t?.reasoning ?? 0) + (t?.cache?.read ?? 0) + (t?.cache?.write ?? 0))
      if (!currentModel && 'modelID' in latestAssistantMessage.info && 'providerID' in latestAssistantMessage.info) {
        currentModel = `${latestAssistantMessage.info.providerID}/${latestAssistantMessage.info.modelID}`
      }
    }

    // Find the model configuration from providers data (split once — modelId may contain '/')
    let contextLimit: number | null = null

    if (currentModel && providersData) {
      const slashIdx = currentModel.indexOf('/')
      const providerId = slashIdx >= 0 ? currentModel.slice(0, slashIdx) : currentModel
      const modelId = slashIdx >= 0 ? currentModel.slice(slashIdx + 1) : ''
      const provider = providersData.providers.find((p) => p.id === providerId)
      if (provider && provider.models) {
        const model = provider.models[modelId]
        if (model && model.limit) {
          contextLimit = model.limit.context
        }
      }
    }

    const rawPercentage = contextLimit ? (totalTokens / contextLimit) * 100 : null
    const usagePercentage = rawPercentage != null ? Math.min(100, Math.max(0, rawPercentage)) : null

    return {
      totalTokens,
      contextLimit,
      usagePercentage,
      currentModel,
      isLoading: false
    }
  }, [messages, messagesLoading, preferences?.defaultModel, providersData])
}