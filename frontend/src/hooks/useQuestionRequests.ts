import { useState, useEffect, useCallback } from 'react'
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

export function useQuestionRequests() {
  const [questions, setQuestions] = useState<QuestionRequest[]>([])

  useEffect(() => {
    const unsubscribe = questionEvents.subscribe((event) => {
      if (event.type === 'add' && event.question) {
        setQuestions(prev => {
          const exists = prev.some(q => q.id === event.question!.id)
          if (exists) return prev
          return [...prev, event.question!]
        })
      } else if (event.type === 'remove' && event.requestID) {
        setQuestions(prev => prev.filter(q => q.id !== event.requestID))
      }
    })
    return unsubscribe
  }, [])

  const currentQuestion = questions[0] || null

  const dismissQuestion = useCallback((requestID: string) => {
    setQuestions(prev => prev.filter(q => q.id !== requestID))
  }, [])

  const clearAllQuestions = useCallback(() => {
    setQuestions([])
  }, [])

  return {
    currentQuestion,
    pendingCount: questions.length,
    dismissQuestion,
    clearAllQuestions
  }
}