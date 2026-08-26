import { memo, useState, useEffect } from 'react'
import type { components } from '@/api/opencode-types'
import { Copy, Volume2, Square, Loader2 } from 'lucide-react'
import { TextPart } from './TextPart'
import { PatchPart } from './PatchPart'
import { ToolCallPart } from './ToolCallPart'
import { useTTS } from '@/hooks/useTTS'
import { useSettings } from '@/hooks/useSettings'
import { getFileStat } from '@/api/files'
import { OutputPreview } from '@/components/session/OutputPreview'

type Part = components['schemas']['Part']

interface MessagePartProps {
  part: Part
  role?: string
  allParts?: Part[]
  partIndex?: number
  onFileClick?: (filePath: string, lineNumber?: number) => void
  messageTextContent?: string
  directory?: string
  messageStreaming?: boolean
}

function getCopyableContent(part: Part, allParts?: Part[]): string {
  switch (part.type) {
    case 'text':
      return part.text || ''
    case 'patch':
      return `Patch: ${part.hash}\nFiles: ${part.files.join(', ')}`
    case 'tool':
      if (part.state.status === 'completed' && part.state.input) {
        return JSON.stringify(part.state.input, null, 2)
      } else if (part.state.status === 'running' && part.state.input) {
        return JSON.stringify(part.state.input, null, 2)
      }
      return `Tool: ${part.tool} (${part.state.status})`
    case 'reasoning':
      return part.text || ''
    case 'snapshot':
      return part.snapshot || ''
    case 'agent':
      return `Agent: ${part.name}`
    case 'step-finish':
      if (allParts) {
        return allParts
          .filter(p => p.type === 'text')
          .map(p => p.text || '')
          .join('\n\n')
          .trim()
      }
      return ''
    case 'file':
      return part.filename || part.url || 'File'
    default:
      return ''
  }
}

function CopyButton({ content, title, className = "" }: { content: string; title: string; className?: string }) {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content)
    } catch (error) {
      console.error('Failed to copy content:', error)
    }
  }

  if (!content.trim()) {
    return null
  }

  return (
    <button
      onClick={handleCopy}
      className={`p-1.5 rounded bg-card hover:bg-card-hover text-muted-foreground hover:text-foreground ${className}`}
      title={title}
    >
      <Copy className="w-4 h-4" />
    </button>
  )
}

interface TTSButtonProps {
  content: string
  className?: string
}

export function TTSButton({ content, className = "" }: TTSButtonProps) {
  const { speak, stop, isEnabled, isPlaying, isLoading, currentText } = useTTS()
  
  if (!isEnabled || !content.trim()) {
    return null
  }
  
  const isThisPlaying = (isPlaying || isLoading) && currentText === content
  
  const handleClick = () => {
    if (isThisPlaying) {
      stop()
    } else {
      speak(content)
    }
  }

  return (
    <button
      onClick={handleClick}
      className={`p-1.5 rounded ${isThisPlaying ? 'bg-red-500/20 text-red-500 hover:bg-red-500/30' : 'bg-card hover:bg-card-hover text-muted-foreground hover:text-foreground'} ${className}`}
      title={isThisPlaying ? "Stop playback" : "Read aloud"}
      disabled={isLoading && currentText !== content}
    >
      {isLoading && isThisPlaying ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : isThisPlaying ? (
        <Square className="w-4 h-4" />
      ) : (
        <Volume2 className="w-4 h-4" />
      )}
    </button>
  )
}

function resolveMentionPath(mentionText: string, directory?: string): string {
  if (!directory) return mentionText
  if (/^[a-zA-Z]:[\\/]/.test(mentionText) || mentionText.startsWith('/') || mentionText.startsWith('file:')) return mentionText
  const normalizedDir = directory.replace(/\\/g, '/')
  return mentionText.includes('/')
    ? `${normalizedDir}/${mentionText}`
    : `${normalizedDir}/chat_uploads/${mentionText}`
}

function FileMention({
  part,
  mentionText,
  directory,
  onFileClick,
}: {
  part: components['schemas']['TextPart']
  mentionText: string
  directory?: string
  onFileClick?: (filePath: string, lineNumber?: number) => void
}) {
  const [isFile, setIsFile] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    getFileStat(resolveMentionPath(mentionText, directory))
      .then((stat) => {
        if (!cancelled) setIsFile(stat.exists && !stat.isDirectory)
      })
      .catch(() => {
        if (!cancelled) setIsFile(false)
      })
    return () => {
      cancelled = true
    }
  }, [mentionText, directory])

  if (isFile !== true) {
    return <TextPart part={part} />
  }

  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-sm text-zinc-300 cursor-pointer hover:bg-zinc-700 hover:text-zinc-200"
      onClick={() => onFileClick?.(mentionText)}
    >
      <span className="text-blue-400">@</span>
      <span className="font-medium">{mentionText}</span>
    </span>
  )
}



export const MessagePart = memo(function MessagePart({ part, role, allParts, partIndex, onFileClick, messageTextContent, directory, messageStreaming }: MessagePartProps) {
  const { preferences } = useSettings()
  const showReasoning = preferences?.showReasoning ?? true
  const copyableContent = getCopyableContent(part, allParts)
  
  switch (part.type) {
    case 'text': {
      if (role === 'user' && allParts && partIndex !== undefined) {
        const nextPart = allParts[partIndex + 1]
        if (nextPart && nextPart.type === 'file') {
          return null
        }
      }
      const text = part.text || ''
      const mentionMatch = text.match(/@(?:"([^"]*)"|'([^']*)'|(\S+))/)
      if (!mentionMatch) {
        return <TextPart part={part} />
      }
      const mentionText = mentionMatch[1] ?? mentionMatch[2] ?? mentionMatch[3]
      return <FileMention part={part} mentionText={mentionText} directory={directory} onFileClick={onFileClick} />
    }
    case 'patch':
      return <PatchPart part={part} />
    case 'tool':
      return <ToolCallPart part={part} onFileClick={onFileClick} />
    case 'reasoning': {
      // 이 메시지에 text 파트가 없다면 reasoning 이 사실상 답변이다.
      // (big-pickle 등 일부 모델은 답변 전체를 reasoning 으로 출력한다)
      // 접거나 숨기지 않고 본문처럼 바로 보여준다.
      const hasTextPart = !!allParts?.some((p) => p.type === 'text');
      const reasoningIsAnswer = role === 'assistant' && !hasTextPart;
      if (!showReasoning && !reasoningIsAnswer) {
        const isLive =
          messageStreaming &&
          !!allParts &&
          allParts.length > 0 &&
          allParts[allParts.length - 1]?.id === part.id
        if (!isLive) return null
        return (
          <div className="flex items-center gap-2 text-xs text-zinc-500 my-1">
            <span className="animate-pulse">▋</span>
            <span className="shine-loading">Reasoning...</span>
          </div>
        )
      }
      if (reasoningIsAnswer) {
        const firstReasoningId = allParts?.find((p) => p.type === 'reasoning')?.id
        const isFirstReasoning = !firstReasoningId || part.id === firstReasoningId
        return (
          <div className="my-2 space-y-2">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Reasoning</div>
            <div className="p-4 bg-muted/50 border border-border rounded-lg text-sm text-foreground/90 whitespace-pre-wrap">
              {part.text}
            </div>
            {isFirstReasoning && <OutputPreview isStreaming={messageStreaming} />}
          </div>
        )
      }
      return (
        <details className="border border-border rounded-lg my-2">
          <summary className="px-4 py-2 bg-muted hover:bg-muted/80 cursor-pointer text-sm font-medium">
            Reasoning
          </summary>
          <div className="p-4 bg-muted/50 text-sm text-foreground/80 whitespace-pre-wrap">
            {part.text}
          </div>
        </details>
      )
    }
    case 'snapshot':
      return (
        <div className="border border-border rounded-lg p-4 my-2 bg-muted/50">
          <div className="text-xs text-muted-foreground font-mono">Snapshot: {part.snapshot}</div>
        </div>
      )
    case 'agent':
      return (
        <div className="border border-border rounded-lg p-4 my-2 bg-muted/50">
          <div className="text-sm font-medium text-blue-400">Agent: {part.name}</div>
        </div>
      )
    case 'step-finish':
      return (
        <div className="text-xs text-muted-foreground my-1 flex items-center gap-2">
          <span>${part.cost.toFixed(4)} • {part.tokens.input + part.tokens.output} tokens</span>
          <CopyButton content={copyableContent} title="Copy step complete" />
          {messageTextContent && <TTSButton content={messageTextContent} />}
        </div>
      )
    case 'file': {
      const fileClickTarget = part.url?.startsWith('data:')
        ? part.filename
          ? `chat_uploads/${part.filename}`
          : ''
        : part.url?.replace(/^file:\/{2,3}/, '') || part.filename || ''
      return (
        <span 
          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-sm text-zinc-300 cursor-pointer hover:bg-zinc-700 hover:text-zinc-200"
          onClick={() => onFileClick?.(fileClickTarget)}
        >
          <span className="text-blue-400">@</span>
          <span className="font-medium">{part.filename || 'File'}</span>
        </span>
      )
    }
    default:
      return 
  }
})
