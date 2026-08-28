import { useCallback, useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useQueryClient } from '@tanstack/react-query'
import type { QuestionRequest } from '@/api/types'

type QuestionEventType = 'add' | 'remove'

interface QuestionEvent {
  type: QuestionEventType
  question?: QuestionRequest
  requestID?: string
}

type QuestionListener = (event: QuestionEvent) => void

const listeners = new Set<QuestionListener>()

export const questionEvents = {
  emit: (event: QuestionEvent) => {
    listeners.forEach(listener => listener(event))
  },
  subscribe: (listener: QuestionListener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
}

interface QuestionStore {
  questions: QuestionRequest[]
}

const useQuestionStore = create<QuestionStore, [['zustand/persist', Pick<QuestionStore, 'questions'>]]>(
  persist(
    (): QuestionStore => ({
      questions: [],
    }),
    {
      name: 'opencode-webui-questions',
      partialize: (state) => ({ questions: state.questions }),
    },
  ),
)

let storeSubscriptionStarted = false

/** 낙관 dismiss 직후 폴링이 미처리 요청을 되살려 깜빡이는 것을 막는 가드. */
const RECENTLY_DISMISSED_MS = 12_000
const recentlyDismissed = new Map<string, number>()

export function markQuestionDismissed(requestID: string): void {
  recentlyDismissed.set(requestID, Date.now())
}

function isRecentlyDismissed(requestID: string): boolean {
  const at = recentlyDismissed.get(requestID)
  if (!at) return false
  if (Date.now() - at > RECENTLY_DISMISSED_MS) {
    recentlyDismissed.delete(requestID)
    return false
  }
  return true
}

function startStoreSubscription(): void {
  if (storeSubscriptionStarted) return
  storeSubscriptionStarted = true
  questionEvents.subscribe((event) => {
    if (event.type === 'add' && event.question) {
      useQuestionStore.setState((state) => {
        const exists = state.questions.some(q => q.id === event.question!.id)
        if (exists) return state
        return { questions: [...state.questions, event.question!] }
      })
    } else if (event.type === 'remove' && event.requestID) {
      useQuestionStore.setState((state) => ({
        questions: state.questions.filter(q => q.id !== event.requestID),
      }))
    }
  })
}

startStoreSubscription()

function normalizeQuestion(raw: unknown): QuestionRequest | null {
  const r = raw as QuestionRequest
  if (!r || !r.id || !r.sessionID) return null
  return r
}

export function useLoadPendingQuestions(client: { listQuestions(): Promise<unknown[]> } | null, sessionID?: string) {
  useEffect(() => {
    if (!client) return
    let cancelled = false

    const load = async () => {
      try {
        const pending = await client.listQuestions()
        if (cancelled) return
        const scope = sessionID
          ? pending.filter((q) => (q as QuestionRequest).sessionID === sessionID)
          : pending
        const serverIDs = new Set<string>()
        for (const q of scope) {
          const question = normalizeQuestion(q)
          if (question) {
            serverIDs.add(question.id)
            if (!isRecentlyDismissed(question.id)) {
              questionEvents.emit({ type: 'add', question })
            }
          }
        }
        const current = useQuestionStore.getState().questions
        const stale = current.filter((q) => {
          if (sessionID && q.sessionID !== sessionID) return false
          return !serverIDs.has(q.id)
        })
        if (stale.length > 0) {
          useQuestionStore.setState((state) => ({
            questions: state.questions.filter((q) => !stale.some((s) => s.id === q.id)),
          }))
        }
      } catch (error) {
        console.error('Failed to load pending questions:', error)
      }
    }

    load()
    const interval = setInterval(load, 2000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [client, sessionID])
}

export function useQuestionRequests(sessionID?: string) {
  const allQuestions = useQuestionStore((state) => state.questions)
  const queryClient = useQueryClient()

  const questions = useMemo(
    () => sessionID
      ? allQuestions.filter(q => q.sessionID === sessionID)
      : allQuestions,
    [allQuestions, sessionID],
  )

  const currentQuestion = questions[0] || null

  const dismissQuestion = useCallback((requestID: string) => {
    markQuestionDismissed(requestID)
    useQuestionStore.setState((state) => ({
      questions: state.questions.filter(q => q.id !== requestID),
    }))
    // 방패 배지 카운트(세션 상태 DB 폴링)도 즉시 갱신 — 다음 폴링(2s)까지 기다리지 않음
    queryClient.invalidateQueries({ queryKey: ['session-status-db'] })
  }, [queryClient])

  const clearAllQuestions = useCallback(() => {
    useQuestionStore.setState({ questions: [] })
  }, [])

  return useMemo(() => ({
    currentQuestion,
    pendingCount: questions.length,
    dismissQuestion,
    clearAllQuestions,
  }), [currentQuestion, questions.length, dismissQuestion, clearAllQuestions])
}
