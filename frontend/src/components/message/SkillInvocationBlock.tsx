import { memo } from 'react'
import { Zap } from 'lucide-react'
import { TextPart } from './TextPart'
import type { components } from '@/api/opencode-types'

type TextPartType = components['schemas']['TextPart']

interface SkillInvocationBlockProps {
  name: string
  args: string
  body: string
  part: TextPartType
}

/**
 * 스킬 호출 표시: `/스킬 인자` 칩을 먼저 보여주고,
 * 템플릿 본문은 접힘 md 블록으로 그린다.
 */
export const SkillInvocationBlock = memo(function SkillInvocationBlock({ name, args, body, part }: SkillInvocationBlockProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-violet-500/15 border border-violet-500/30 text-violet-200 font-mono text-sm font-medium">
          <Zap className="w-3.5 h-3.5" />
          /{name}
        </span>
        {args && (
          <span className="text-sm text-zinc-200 break-words">{args}</span>
        )}
      </div>
      <details open className="border border-border rounded-lg">
        <summary className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer select-none">
          Skill template
        </summary>
        <div className="px-3 pb-3 min-w-0">
          <TextPart part={{ ...part, text: body } as TextPartType} />
        </div>
      </details>
    </div>
  )
})
