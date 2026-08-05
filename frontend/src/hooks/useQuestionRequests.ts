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

export function useQuestionRequests(sessionID?: string) {
  const [allQuestions, setAllQuestions] = useState<QuestionRequest[]>([])

  useEffect(() => {
    const unsubscribe = questionEvents.subscribe((event) => {
      if (event.type === 'add' && event.question) {
        setAllQuestions(prev => {
          const exists = prev.some(q => q.id === event.question!.id)
          if (exists) return prev
          return [...prev, event.question!]
        })
      } else if (event.type === 'remove' && event.requestID) {
        setAllQuestions(prev => prev.filter(q => q.id !== event.requestID))
      }
    })
    return unsubscribe
  }, [])

  const questions = sessionID
    ? allQuestions.filter(q => q.sessionID === sessionID)
    : allQuestions

  const currentQuestion = questions[0] || null

  const dismissQuestion = useCallback((requestID: string) => {
    setAllQuestions(prev => prev.filter(q => q.id !== requestID))
  }, [])

  const clearAllQuestions = useCallback(() => {
    setAllQuestions([])
  }, [])

  return {
    currentQuestion,
    pendingCount: questions.length,
    dismissQuestion,
    clearAllQuestions
  }
}