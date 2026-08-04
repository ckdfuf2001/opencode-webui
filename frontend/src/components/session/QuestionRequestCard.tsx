import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { QuestionRequest, QuestionInfo } from '@/api/types'
import { cn } from '@/lib/utils'

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
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => toggleLabel(option.label)}
                  onClick={(e) => e.stopPropagation()}
                />
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

  useEffect(() => {
    setSelections(question.questions.map(() => ({ selected: [], custom: '' })))
  }, [question])

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
    try {
      await onReply(question.id, answers)
      onDismiss?.(question.id)
    } catch (error) {
      console.error('Failed to reply to question:', error)
    } finally {
      setIsLoading(false)
      setAction(null)
    }
  }

  const handleReject = async () => {
    setIsLoading(true)
    setAction('reject')
    try {
      await onReject(question.id)
      onDismiss?.(question.id)
    } catch (error) {
      console.error('Failed to reject question:', error)
    } finally {
      setIsLoading(false)
      setAction(null)
    }
  }

  return (
    <div className="w-full rounded-lg p-1.5 bg-card/60 border border-primary/30 animate-pulse-subtle">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-medium text-primary">Question</span>
      </div>
      <div className="space-y-4">
        {question.questions.map((q, i) => (
          <QuestionPrompt
            key={i}
            q={q}
            selection={selections[i] || { selected: [], custom: '' }}
            onSelectionChange={(next) =>
              setSelections(prev => prev.map((s, idx) => (idx === i ? next : s)))
            }
          />
        ))}
      </div>
      <div className="mt-3 flex justify-end gap-2">
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
          disabled={isLoading}
          className={cn(action === 'reply' && "opacity-70")}
        >
          {action === 'reply' ? 'Submitting...' : 'Submit'}
        </Button>
      </div>
    </div>
  )
}