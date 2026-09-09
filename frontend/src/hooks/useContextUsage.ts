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

// 컴팩트 기준점: opencode summarize는 기존 메시지를 지우지 않고 요약
// 메시지만 추가한다 (새 ID로 append). 그래서 컴팩트 이전 assistant의
// 큰 토큰이 사용량 계산에 계속 잡혀 "줄었다가 다음 채팅에 다시 90%+"로
// 튀게 된다. 컴팩트 성공 시점을 세션별로 기록하고, 그 이전 생성 메시지는
// 사용량에서 제외한다 — 새 ID 메시지(그 이후)부터 다시 잰다.
const compactAtBySession = new Map<string, number>()

export function markSessionCompacted(sessionID: string, at: number = Date.now()): void {
  compactAtBySession.set(sessionID, at)
  try {
    sessionStorage.setItem(`compactAt:${sessionID}`, String(at))
  } catch { /* ignore */ }
}

function getSessionCompactedAt(sessionID: string | undefined): number | null {
  if (!sessionID) return null
  const mem = compactAtBySession.get(sessionID)
  if (mem != null) return mem
  try {
    const raw = sessionStorage.getItem(`compactAt:${sessionID}`)
    if (raw != null) {
      const n = Number(raw)
      if (Number.isFinite(n) && n > 0) {
        compactAtBySession.set(sessionID, n)
        return n
      }
    }
  } catch { /* ignore */ }
  return null
}

function createdAt(m: MessageListItem): number {
  return (m.info as unknown as { time?: { created?: number } }).time?.created ?? 0
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
    
    // 컴팩트 이전 메시지는 제외한다. 요약 메시지 자체(컴팩트 시점 이전
    // 생성)도 제외 — 컴팩트 성공 이후의 새 ID 메시지부터 다시 잰다.
    // (created 없는 메시지는 0으로 취급되어 제외된다)
    const compactAt = getSessionCompactedAt(sessionID)
    const effectiveMessages = compactAt != null
      ? messages.filter((m) => createdAt(m) > compactAt)
      : messages

    // Context window usage: latest assistant message's tokens represent current window.
    // Summing all messages inflates to 900%+ — must use single turn, not cumulative.
    const assistantMessages = effectiveMessages.filter(isAssistantMessage)
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
    let usageTokens = 0
    if (latestAssistantMessage) {
      const t = (latestAssistantMessage.info as unknown as { tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } }).tokens
      totalTokens = ((t?.input ?? 0) + (t?.output ?? 0) + (t?.reasoning ?? 0) + (t?.cache?.read ?? 0) + (t?.cache?.write ?? 0))
      // reasoning/cache도 컨텍스트를 차지하므로 포함한다.
      // input+output만 보면 reasoning 모델은 바가 오르지 않는다.
      usageTokens = totalTokens
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

    // 최신 단일 턴 기준 (전체 합산이던 900%+ 뻥튀기는 위에서 해결됨)
    const rawPercentage = contextLimit ? (usageTokens / contextLimit) * 100 : null
    const usagePercentage = rawPercentage != null ? Math.min(100, Math.max(0, rawPercentage)) : null

    return {
      totalTokens,
      contextLimit,
      usagePercentage,
      currentModel,
      isLoading: false
    }
  }, [messages, messagesLoading, preferences?.defaultModel, providersData, sessionID])
}