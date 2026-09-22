import { useCallback, useEffect, useMemo } from 'react'
import { create } from 'zustand'
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

// permission과 동일 — 수 분 내 소멸하는 임시 데이터라 persist하지 않는다.
const useQuestionStore = create<QuestionStore>()((): QuestionStore => ({
  questions: [],
}))

let storeSubscriptionStarted = false

/** ?��? dismiss 직후 ?�링??미처�??�청???�살??깜빡?�는 것을 막는 가?? */
const RECENTLY_DISMISSED_MS = 12_000
const recentlyDismissed = new Map<string, number>()

// 조회될 때만 만료 청소되므로 상한을 둔다 (장시간 세션 무한 누적 방지)
const RECENTLY_DISMISSED_MAX = 500
export function markQuestionDismissed(requestID: string): void {
  recentlyDismissed.set(requestID, Date.now())
  while (recentlyDismissed.size > RECENTLY_DISMISSED_MAX) {
    const oldest = recentlyDismissed.keys().next().value as string | undefined
    if (oldest === undefined) break
    recentlyDismissed.delete(oldest)
  }
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

export function useLoadPendingQuestions(client: { listQuestions(): Promise<unknown[]> } | null, sessionID?: string, relatedSessionIDs?: string[]) {
  useEffect(() => {
    if (!client) return
    let cancelled = false

    const scopeIDs = sessionID ? new Set([sessionID, ...(relatedSessionIDs ?? [])]) : null

    const load = async () => {
      // 백그라운드 탭에서는 폴링 스킵 — 브라우저 스로틀만 믿지 않는다
      if (typeof document !== 'undefined' && document.hidden) return
      try {
        const pending = await client.listQuestions()
        if (cancelled) return
        const scope = scopeIDs
          ? pending.filter((q) => scopeIDs.has((q as QuestionRequest).sessionID ?? ''))
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
          if (scopeIDs && !scopeIDs.has(q.sessionID)) return false
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
  }, [client, sessionID, relatedSessionIDs])
}

export function useQuestionRequests(sessionID?: string, relatedSessionIDs?: string[]) {
  const allQuestions = useQuestionStore((state) => state.questions)
  const queryClient = useQueryClient()

  const scopeIDs = useMemo(() => {
    const ids = new Set<string>()
    if (sessionID) ids.add(sessionID)
    for (const id of relatedSessionIDs ?? []) ids.add(id)
    return ids
  }, [sessionID, relatedSessionIDs])

  const questions = useMemo(
    () => scopeIDs.size > 0
      ? allQuestions.filter(q => scopeIDs.has(q.sessionID))
      : allQuestions,
    [allQuestions, scopeIDs],
  )

  const currentQuestion = questions[0] || null

  const dismissQuestion = useCallback((requestID: string) => {
    markQuestionDismissed(requestID)
    useQuestionStore.setState((state) => ({
      questions: state.questions.filter(q => q.id !== requestID),
    }))
    // 방패 배�? 카운???�션 ?�태 DB ?�링)??즉시 갱신 ???�음 ?�링(2s)까�? 기다리�? ?�음
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

