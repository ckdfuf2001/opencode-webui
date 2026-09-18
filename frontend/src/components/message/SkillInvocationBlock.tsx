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
  /** 접힘 블록 요약줄. 스킬이면 'Skill template', 커맨드면 'Command' 등. */
  summaryLabel?: string
}

/**
 * 스킬/커맨드 호출 표시: `/이름 인자` 칩을 먼저 보여주고,
 * 본문(md 원문)은 접힘 md 블록으로 그린다.
 */
export const SkillInvocationBlock = memo(function SkillInvocationBlock({ name, args, body, part, summaryLabel = 'Skill template' }: SkillInvocationBlockProps) {
  // 한 줄 본문은 접힘 없이 칩만 그린다
  if (!body.includes('\n')) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-violet-500/15 border border-violet-500/30 text-violet-200 font-mono text-sm font-medium">
          <Zap className="w-3.5 h-3.5" />
          /{name}
        </span>
        {args ? (
          <span className="text-sm text-zinc-200 break-words">{args}</span>
        ) : (
          <span className="text-sm text-zinc-200 break-words">{body}</span>
        )}
      </div>
    )
  }
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
          {summaryLabel}
        </summary>
        <div className="px-3 pb-3 min-w-0">
          <TextPart part={{ ...part, text: body } as TextPartType} />
        </div>
      </details>
    </div>
  )
})
