import { memo, useState, useEffect, type ReactNode } from 'react'
import type { components } from '@/api/opencode-types'
import { Copy, Volume2, Square, Loader2, Zap } from 'lucide-react'
import { TextPart } from './TextPart'
import { SkillInvocationBlock } from './SkillInvocationBlock'
import { parseSkillInvocation } from '@/lib/skillBlock'
import { PatchPart } from './PatchPart'
import { ToolCallPart, CappedOutput } from './ToolCallPart'
import { useTTS } from '@/hooks/useTTS'
import { useSettings } from '@/hooks/useSettings'
import { getFileStat } from '@/api/files'
import { copyTextToClipboard } from '@/lib/clipboard'

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
  /** 커맨드 호출 정보 — user 첫 텍스트 파트 위에 `/이름` 칩만 덧붙인다 (원본 유지) */
  invocation?: { name: string; runId: string }
  /** 칩 클릭 → 커맨드 히스토리 창 열기 */
  onCommandClick?: () => void
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
    const ok = await copyTextToClipboard(content)
    if (!ok) console.error('Failed to copy content')
  }

  if (!content.trim()) {
    return null
  }

  return (
    <button
      onClick={handleCopy}
      className={`p-1.5 rounded bg-card hover:bg-card-hover text-muted-foreground hover:text-foreground cursor-pointer ${className}`}
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
      className={`p-1.5 rounded cursor-pointer ${isThisPlaying ? 'bg-red-500/20 text-red-500 hover:bg-red-500/30' : 'bg-card hover:bg-card-hover text-muted-foreground hover:text-foreground'} ${className}`}
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

function mentionCandidates(mentionText: string, directory?: string): string[] {
  const primary = resolveMentionPath(mentionText, directory)
  if (!directory) return [primary]
  if (/^[a-zA-Z]:[\\/]/.test(mentionText) || mentionText.startsWith('/') || mentionText.startsWith('file:')) {
    return [primary]
  }
  if (mentionText.includes('/')) {
    // 레포 기준 상대경로면 workspace 기준 그대로도 시도 (이미 레포 prefix 포함 등)
    return primary === mentionText ? [primary] : [primary, mentionText]
  }
  const normalizedDir = directory.replace(/\\/g, '/')
  return [primary, `${normalizedDir}/${mentionText}`]
}

async function resolveExistingMentionPath(mentionText: string, directory?: string): Promise<string | null> {
  for (const candidate of mentionCandidates(mentionText, directory)) {
    try {
      const stat = await getFileStat(candidate)
      if (stat.exists && !stat.isDirectory) return candidate
    } catch {
      // 다음 후보 시도
    }
  }
  return null
}

function FileMention({  part,
  mentionText,
  directory,
  onFileClick,
}: {
  part: components['schemas']['TextPart']
  mentionText: string
  directory?: string
  onFileClick?: (filePath: string, lineNumber?: number) => void
}) {
  const [resolvedPath, setResolvedPath] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setResolvedPath(null)
    void resolveExistingMentionPath(mentionText, directory).then((found) => {
      if (!cancelled) setResolvedPath(found)
    })
    return () => {
      cancelled = true
    }
  }, [mentionText, directory])

  if (resolvedPath === null) {
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



export const MessagePart = memo(function MessagePart({ part, role, allParts, partIndex, onFileClick, messageTextContent, directory, messageStreaming, invocation, onCommandClick }: MessagePartProps) {
  const { preferences } = useSettings()
  const showReasoning = preferences?.showReasoning ?? true
  const copyableContent = getCopyableContent(part, allParts)
  
  switch (part.type) {
    case 'text': {
      const text = part.text || ''
      // 스킬/커맨드 호출 표시는 원본을 가리지 않는다.
      // - skill-template 마커: 템플릿 접힘 블록 (스킬 설명 보기용)
      // - run 이력 매칭: `/이름` 칩만 위에 덧붙이고 본문은 기존 렌더 그대로
      if (role === 'user' && partIndex === 0) {
        const skill = parseSkillInvocation(text)
        if (skill) {
          return <SkillInvocationBlock name={skill.name} args={skill.args} body={skill.body} part={part} />
        }
      }
      const chip = role === 'user' && partIndex === 0 && invocation ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCommandClick?.() }}
          title="커맨드 이력 보기"
          className="inline-flex items-center gap-1.5 px-2 py-0.5 mb-1.5 rounded-md bg-violet-500/15 border border-violet-500/30 text-violet-200 font-mono text-sm font-medium hover:bg-violet-500/25 cursor-pointer"
        >
          <Zap className="w-3.5 h-3.5" />
          /{invocation.name}
        </button>
      ) : null
      if (role === 'user' && allParts && partIndex !== undefined) {
        const nextPart = allParts[partIndex + 1]
        // 파일이 뒤따라도 본문은 버리지 않는다 (칩만 있으면 호출 표시가 된다)
        if (nextPart && nextPart.type === 'file') {
          return <>{chip}<TextPart part={part} /></>
        }
      }
      // 멘션(@...)만 칩으로 바꾸고 앞뒤 텍스트는 그대로 렌더한다.
      // 예전에는 텍스트 전체가 칩 하나로 바뀌어 앞뒤 말이 날아갔다.
      const nodes: ReactNode[] = []
      let last = 0
      for (const m of text.matchAll(/@(?:"([^"]*)"|'([^']*)'|(\S+))/g)) {
        const idx = m.index ?? 0
        if (idx > last) {
          nodes.push(<TextPart key={`t${last}`} part={{ ...part, text: text.slice(last, idx) } as typeof part} />)
        }
        const mentionText = m[1] ?? m[2] ?? m[3]
        if (mentionText) {
          // 폴백용으로는 멘션 구간만 넘긴다. 원문 전체를 넘기면 존재 확인 실패 시
          // 앞뒤 텍스트와 합쳐져 중복으로 보인다.
          const mentionPart = { ...part, text: m[0] } as typeof part
          nodes.push(<FileMention key={`m${idx}`} part={mentionPart} mentionText={mentionText} directory={directory} onFileClick={onFileClick} />)
        }
        last = idx + m[0].length
      }
      if (nodes.length === 0) {
        return <>{chip}<TextPart part={part} /></>
      }
      if (last < text.length) {
        nodes.push(<TextPart key="t-end" part={{ ...part, text: text.slice(last) } as typeof part} />)
      }
      return <>{chip}{nodes}</>
    }
    case 'patch':
      return <PatchPart part={part} />
    case 'tool':
      return <ToolCallPart part={part} onFileClick={onFileClick} directory={directory} />
    case 'reasoning': {
      // 암호문(security) reasoning은 절대 그리지 않는다 — 평문 없이 암호 블록만 있어
      // 패널·펄스가 떠도 내용이 영원히 안 찬다. 백엔드 security 플래그 또는 인라인 메타로 판별.
      const pAny = part as unknown as { security?: boolean; metadata?: { openai?: { reasoningEncryptedContent?: string } } }
      if (pAny.security) return null
      try {
        if (typeof pAny.metadata?.openai?.reasoningEncryptedContent === 'string' && pAny.metadata.openai.reasoningEncryptedContent) return null
      } catch { /* ignore malformed metadata */ }
      const hasReasonText = !!part.text?.trim()
      // showReasoning on이면 reasoning 파트가 있을 때 닫힌 패널을 먼저 깔아둔다.
      // 스트리밍 시작 직후(텍스트 아직 없음)에도 패널이 있어야 클릭해서 SSE를 볼 수 있다.
      // 완료 후에도 비어 있으면(암호문-only 모델) 그리지 않는다 — 매 턴 빈 패널 노이즈 방지.
      if (showReasoning && !hasReasonText && !messageStreaming) return null
      if (!showReasoning && !hasReasonText) return null
      // 이 메시지에 text 파트가 없다면 reasoning 이 사실상 답변이다.
      // (big-pickle 등 일부 모델은 답변 전체를 reasoning 으로 출력한다)
      // 접거나 숨기지 않고 본문처럼 바로 보여준다.
      const hasTextPart = !!allParts?.some((p) => p.type === 'text');
      const hasToolPart = !!allParts?.some((p) => p.type === 'tool');
      // 대화(text)가 없어도 tool/patch/file/agent 등 다른 파트가 있으면 reasoning을 답변으로 펼치지 않는다
      const hasOtherVisiblePart = !!allParts?.some((p) => p.type === 'patch' || p.type === 'file' || p.type === 'agent');
      const reasoningIsAnswer = role === 'assistant' && !hasTextPart && !hasToolPart && !hasOtherVisiblePart;
      // context는 text/patch/file/agent/snapshot 등 reasoning 외 가시적 응답을 의미
      const hasContextPart = hasTextPart || hasOtherVisiblePart || !!allParts?.some((p) => p.type === 'snapshot');
      const noContextNoTool = !hasToolPart && !hasContextPart;

      // showReasoning on이면 항상 접힘으로 보임 — bash처럼 어딜 눌러도 닫히고 복사 버튼은 우측.
      // 스트리밍 중 텍스트가 아직 비었으면 펄스 표시 (SSE가 채워준다).
      if (showReasoning) {
        const waiting = !hasReasonText && messageStreaming
        return (
          <details className="border border-border rounded-lg my-2">
            <summary className="px-4 py-2 bg-muted hover:bg-muted/80 cursor-pointer text-sm font-medium flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2">Reasoning{waiting && <span className="animate-pulse text-xs">▋</span>}</span>
              <span onClick={(e) => e.preventDefault()}>
                <CopyButton content={copyableContent} title="Copy reasoning" />
              </span>
            </summary>
            <div className="p-4 bg-muted/50 text-sm text-foreground/80 whitespace-pre-wrap cursor-pointer" onClick={(e) => { const d = (e.currentTarget.closest('details') as HTMLDetailsElement); if (d) d.open = false; }}>
              {waiting ? <span className="shine-loading text-xs">Reasoning...</span> : part.text}
            </div>
          </details>
        )
      }

      // showReasoning off: 스트리밍 중에는 숨긴다 (SSE 델타가 쌓여도 보이지 않게).
      // reasoning이 곧 답변인 모델(big-pickle 등)은 완료 시점에 아래 answer 분기로 펼쳐진다.
      if (messageStreaming) return null
      // showReasoning off: noContextNoTool/answer는 무조건 펼쳐서, 그 외 숨김
      if (noContextNoTool || reasoningIsAnswer) {
        return (
          <details open className="border border-border rounded-lg my-2">
            <summary className="px-4 py-2 bg-muted hover:bg-muted/80 cursor-pointer text-sm font-medium">
              Reasoning
            </summary>
            <div className="p-4 bg-muted/50 text-sm text-foreground/80 whitespace-pre-wrap">
              {part.text}
            </div>
          </details>
        )
      }
      return null
    }
    case 'snapshot':
      return (
        <div className="border border-border rounded-lg p-4 my-2 bg-muted/50">
          <div className="text-xs text-muted-foreground font-mono mb-2">Snapshot</div>
          <CappedOutput text={part.snapshot || ''} />
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
      // 이미지以外은 파일명만으로는 어느 파일인지 알 수 없어 클릭해도 못 찾는다.
      // 레포 기준 상대경로를 칩에 표시한다 (이미지는 기존대로 파일명만).
      const ext = (part.filename?.split('.').pop() ?? '').toLowerCase()
      const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)
      const normTarget = fileClickTarget.replace(/\\/g, '/')
      const normDir = (directory ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
      const label = !isImage && normDir && normTarget.startsWith(normDir + '/')
        ? normTarget.slice(normDir.length + 1)
        : part.filename || 'File'
      return (
        <span
          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-sm text-zinc-300 cursor-pointer hover:bg-zinc-700 hover:text-zinc-200"
          onClick={() => onFileClick?.(fileClickTarget)}
          title={fileClickTarget}
        >
          <span className="text-blue-400">@</span>
          <span className="font-medium">{label}</span>
        </span>
      )
    }
    default:
      return 
  }
})
