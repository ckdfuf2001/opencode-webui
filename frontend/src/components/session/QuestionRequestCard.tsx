import { useState, useEffect } from 'react'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { QuestionRequest, QuestionInfo } from '@/api/types'
import { cn } from '@/lib/utils'
import { showToast } from '@/lib/toast'

interface QuestionRequestCardProps {
  question: QuestionRequest
  onReply: (requestID: string, answers: string[][]) => Promise<void>
  onReject: (requestID: string) => Promise<void>
  onDismiss?: (requestID: string) => void
}

interface QuestionSelection {
  selected: string[]
  custom: string
}

function QuestionPrompt({
  q,
  selection,
  onSelectionChange,
}: {
  q: QuestionInfo
  selection: QuestionSelection
  onSelectionChange: (next: QuestionSelection) => void
}) {
  const multiple = !!q.multiple

  const toggleLabel = (label: string) => {
    const next = selection.selected.includes(label)
      ? selection.selected.filter(l => l !== label)
      : multiple
        ? [...selection.selected, label]
        : [label]
    onSelectionChange({ ...selection, selected: next })
  }

  return (
    <div className="space-y-3 border rounded-md p-4">
      <div className="space-y-1">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {q.header}
        </div>
        <div className="text-sm">{q.question}</div>
      </div>

      <div className="space-y-2">
        {q.options.map((option) => {
          const checked = selection.selected.includes(option.label)
          return (
            <button
              key={option.label}
              type="button"
              onClick={() => toggleLabel(option.label)}
              className={cn(
                "w-full text-left flex items-start gap-3 border rounded-md p-3 transition-colors",
                checked
                  ? "border-primary bg-primary/5"
                  : "border-input hover:border-primary/50"
              )}
            >
              <div className="pt-0.5">
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary",
                    checked && "bg-primary text-primary-foreground"
                  )}
                >
                  {checked && <Check className="h-4 w-4" />}
                </span>
              </div>
              <div className="space-y-0.5">
                <div className="text-sm font-medium">{option.label}</div>
                {option.description && (
                  <div className="text-xs text-muted-foreground">
                    {option.description}
                  </div>
                )}
              </div>
            </button>
          )
        })}

        <div className="space-y-1.5 border rounded-md p-3">
          <Label className="text-xs text-muted-foreground">직접 답변</Label>
          <Input
            value={selection.custom}
            onChange={(e) => onSelectionChange({ ...selection, custom: e.target.value })}
            placeholder="Type your own answer"
          />
        </div>
      </div>
    </div>
  )
}

export function QuestionRequestCard({
  question,
  onReply,
  onReject,
  onDismiss,
}: QuestionRequestCardProps) {
  const [selections, setSelections] = useState<QuestionSelection[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [action, setAction] = useState<'reply' | 'reject' | null>(null)
  const [page, setPage] = useState(0)

  const total = question.questions.length
  // 질문이 바뀌면(다른 요청) 첫 페이지부터 보여준다
  const questionId = question.id
  useEffect(() => {
    setSelections(question.questions.map(() => ({ selected: [], custom: '' })))
    setPage(0)
  }, [questionId])

  const handleReply = async () => {
    const answers = question.questions.map((_q, i) => {
      const sel = selections[i] || { selected: [], custom: '' }
      const values = [...sel.selected]
      if (sel.custom.trim()) values.push(sel.custom.trim())
      return values
    })
    if (answers.some(a => a.length === 0)) return
    setIsLoading(true)
    setAction('reply')
    onDismiss?.(question.id)
    try {
      await onReply(question.id, answers)
    } catch (error) {
      console.error('Failed to reply to question:', error)
      showToast.error(
        `Failed to reply: ${error instanceof Error ? error.message : "unknown error"}`,
        { duration: 6000 },
      )
    } finally {
      setIsLoading(false)
      setAction(null)
    }
  }

  const handleReject = async () => {
    setIsLoading(true)
    setAction('reject')
    onDismiss?.(question.id)
    try {
      await onReject(question.id)
    } catch (firstError) {
      console.error('Failed to reject question:', firstError)
      // reject 가 빠지면 방패 배지 숫자가 줄지 않는다. 일시적 실패는 한 번 재시도한다.
      try {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        await onReject(question.id)
      } catch (retryError) {
        console.error('Failed to reject question (retry):', retryError)
        showToast.error(
          `Failed to dismiss question: ${retryError instanceof Error ? retryError.message : "unknown error"}`,
          { duration: 6000 },
        )
      }
    } finally {
      setIsLoading(false)
      setAction(null)
    }
  }

  const safePage = Math.min(page, Math.max(total - 1, 0))
  const current = question.questions[safePage]
  const allAnswered = question.questions.every((_q, i) => {
    const sel = selections[i] || { selected: [], custom: '' }
    return sel.selected.length > 0 || sel.custom.trim().length > 0
  })
  const isFirst = safePage === 0
  const isLast = safePage === total - 1

  return (
    <div className="w-full rounded-lg p-1.5 bg-card/60 border border-primary/30 animate-pulse-subtle">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-medium text-primary">Question</span>
        {total > 1 && (
          <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
            <span>(</span>
            <button
              type="button"
              aria-label="Previous question"
              disabled={isFirst || isLoading}
              onClick={() => setPage(safePage - 1)}
              className="rounded p-0.5 hover:bg-accent disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="font-mono tabular-nums">{safePage + 1}/{total}</span>
            <button
              type="button"
              aria-label="Next question"
              disabled={isLast || isLoading}
              onClick={() => setPage(safePage + 1)}
              className="rounded p-0.5 hover:bg-accent disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <span>)</span>
          </span>
        )}
      </div>
      {current && (
        <QuestionPrompt
          q={current}
          selection={selections[safePage] || { selected: [], custom: '' }}
          onSelectionChange={(next) =>
            setSelections(prev => prev.map((s, idx) => (idx === safePage ? next : s)))
          }
        />
      )}
      <div className="mt-3 flex justify-end gap-2">
        {total <= 1 || isLast ? (
          <>
            <Button
              variant="outline"
              onClick={handleReject}
              disabled={isLoading}
              className={cn(action === 'reject' && "opacity-70")}
            >
              {action === 'reject' ? 'Rejecting...' : 'Dismiss'}
            </Button>
            <Button
              variant="default"
              onClick={handleReply}
              disabled={isLoading || !allAnswered}
              className={cn(action === 'reply' && "opacity-70")}
            >
              {action === 'reply' ? 'Submitting...' : 'Submit'}
            </Button>
          </>
        ) : isFirst ? (
          <>
            <Button
              variant="outline"
              onClick={handleReject}
              disabled={isLoading}
              className={cn(action === 'reject' && "opacity-70")}
            >
              {action === 'reject' ? 'Rejecting...' : 'Dismiss'}
            </Button>
            <Button
              variant="default"
              onClick={() => setPage(safePage + 1)}
              disabled={isLoading}
            >
              Next
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              onClick={() => setPage(safePage - 1)}
              disabled={isLoading}
            >
              Prev
            </Button>
            <Button
              variant="default"
              onClick={() => setPage(safePage + 1)}
              disabled={isLoading}
            >
              Next
            </Button>
          </>
        )}
      </div>
    </div>
  )
}