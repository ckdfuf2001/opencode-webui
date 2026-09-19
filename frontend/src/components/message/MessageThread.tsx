import { memo, useMemo, useEffect, useRef } from 'react'
import { useSettings } from '@/hooks/useSettings'
import { useAbortSession } from '@/hooks/useOpenCode'
import { MessagePart } from './MessagePart'
import { CornerDownLeft, Scissors, Eraser, X, Copy } from 'lucide-react'
import type { MessageWithParts } from '@/api/types'
import { ERROR_MESSAGE_ID_PREFIX } from '@/lib/chatErrors'
import { MENTION_PATTERN } from '@/lib/promptParser'
import { stripMemoryRecall } from '@/lib/stripRecall'
import { parseSkillInvocation } from '@/lib/skillBlock'
import { absToWsPath } from '@/lib/repoPath'
import { formatChatTime } from '@/lib/chatTime'
import { copyTextToClipboard } from '@/lib/clipboard'
import { showToast } from '@/lib/toast'

function getMessageTextContent(msg: MessageWithParts): string {
  return stripMemoryRecall(
    msg.parts
      .filter(p => p.type === 'text')
      .map(p => p.text || '')
      .join('\n\n')
      .trim(),
  )
}

function getRawMessageTextContent(msg: MessageWithParts): string {
  return msg.parts
    .filter(p => p.type === 'text')
    .map(p => p.text || '')
    .join('\n\n')
    .trim()
}

function getEditablePrompt(msg: MessageWithParts, invocation?: { name: string; args: string | null }, workspaceRoot: string = ''): string {
  const lines: string[] = []
  const fileLines: string[] = []
  let headText = ''
  for (const p of msg.parts) {
    if (p.type === 'file') {
      // /command 호출은 opencode가 템플릿을 펼쳐 저장해서 원문에 `/이름`이 없다.
      // run 기록의 이름·인자로 복원해야 edit 재전송이 커맨드로 동작한다.
      // file 파트는 절대경로(p.url)에서 wsPath로 환산해 재전송 시 커맨드로 동작하게 한다.
      let mention = ''
      if (p.url) {
        const abs = p.url.replace(/^file:\/{2,3}/, '')
        const ws = absToWsPath(abs, workspaceRoot || '')
        mention = `@"${ws || p.filename || 'File'}"`
      } else {
        const filename = p.filename || p.url?.replace(/^file:\/{2,3}/, '').split('/').pop() || 'File'
        mention = `@"${filename}"`
      }
      lines.push(mention)
      fileLines.push(mention)
    } else if (p.type === 'text' && p.text) {
      const text = stripMemoryRecall(p.text.trim())
      if (!text) continue
      if (/^Called the \w+ tool with the following input:/i.test(text)) continue
      // 스킬 합성문(`/이름 인자` + 템플릿 전문)은 `/이름 인자`로 되돌린다 —
      // edit창에 스크립트 전문이 들어가면 재전송이 어긋난다.
      const skill = parseSkillInvocation(text)
      const line = skill
        ? `/${skill.name}${skill.args ? ` ${skill.args}` : ''}`
        : text.replace(MENTION_PATTERN, (m, quoted, single, unquoted) => quoted || single ? m : `@"${unquoted}"`)
      lines.push(line)
      if (!headText) headText = line
    }
  }
  // /command 호출은 opencode가 템플릿을 펼쳐 저장해서 원문에 `/이름`이 없다.
  // run 기록의 이름·인자로 복원해야 edit 재전송이 커맨드로 동작한다.
  if (invocation && !headText.startsWith(`/${invocation.name}`)) {
    const cmd = `/${invocation.name}${invocation.args ? ` ${invocation.args}` : ''}`
    return [cmd, ...fileLines].join(' ').trim()
  }
  return lines.join(' ').trim()
}

const isErrorMessage = (msg: MessageWithParts): boolean => {
  return msg.info.id.startsWith(ERROR_MESSAGE_ID_PREFIX)
}

interface MessageThreadProps {
  opcodeUrl: string
  sessionID: string
  directory?: string
  messages?: MessageWithParts[]
  onFileClick?: (filePath: string, lineNumber?: number) => void
  onEditMessage?: (messageID: string, text: string) => void
  onTruncate?: (messageID: string) => void
  onDelete?: (messageID: string) => void
  hiddenAfterID?: string | null
  onCancelEdit?: () => void
  highlightedMessageID?: string | null
  isLoading?: boolean
  /** trigger user 메시지id → 호출 정보 (원본 위에 `/이름` 칩만 덧붙인다) */
  invocations?: Map<string, { name: string; runId: string; args: string | null }>
  /** 칩 클릭 → 커맨드 히스토리 창 열기 */
  onOpenCommandHistory?: () => void
}

export const isMessageStreaming = (msg: MessageWithParts): boolean => {
  if (msg.info.role !== 'assistant') return false
  return !('completed' in msg.info.time && msg.info.time.completed)
}

const isMessageThinking = (msg: MessageWithParts): boolean => {
  if (msg.info.role !== 'assistant') return false
  return msg.parts.length === 0 && isMessageStreaming(msg)
}

export const MessageThread = memo(function MessageThread({ messages, onFileClick, onEditMessage, onTruncate, onDelete, hiddenAfterID, onCancelEdit, highlightedMessageID, directory, isLoading, sessionID, invocations, onOpenCommandHistory, opcodeUrl }: MessageThreadProps) {
  // 윈도우는 SessionDetail이 단일 소유 (WINDOW_SIZE/windowStart).
  // 여기서 이중으로 자르면 "Show earlier"가 동작 안 하고 스크롤이 튄다.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void sessionID
  const editIndex = (hiddenAfterID && messages) ? messages.findIndex((m) => m.info.id === hiddenAfterID) : -1
  const baseVisible = editIndex >= 0 && messages ? messages.slice(0, editIndex + 1) : (messages ?? [])
  const prepared = useMemo(() => baseVisible.map((msg) => {
    const parts = msg.parts
      .map((part) => {
        if ((part as { type?: string }).type === 'text' && typeof (part as { text?: string }).text === 'string') {
          const original = (part as { text: string }).text
          // opencode가 task tool 뒤에 주입하는 synthetic 유저 메시지
          // ("Summarize the task tool output above...") — 내가 보낸 게 아니므로 그리지 않는다
          if (msg.info.role === 'user'
            && (part as { synthetic?: boolean }).synthetic === true
            && /summarize the task tool output above/i.test(original)) {
            return null
          }
          const t = stripMemoryRecall(original)
          if (!t) return null
          if (t === original) return part
          return { ...part, text: t } as typeof part
        }
        return part
      })
      .filter(Boolean)
    const assistantText = msg.info.role === 'assistant' ? getMessageTextContent(msg) : undefined
    return { msg, parts, assistantText }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [messages, hiddenAfterID])
  const hasSending = baseVisible.some((m) => m.info.id.startsWith("optimistic_sending_"))
  const preVisible = hasSending
    ? prepared.filter(({ msg }) => !(msg.info.role === "assistant" && msg.parts.length === 0 && !("completed" in msg.info.time && (msg.info.time as { completed?: number }).completed)))
    : prepared
  const highlightedIdx = highlightedMessageID ? preVisible.findIndex(({ msg }) => msg.info.id === highlightedMessageID) : -1
  void highlightedIdx
  // SSE off 모드: 폴링으로 완료됐을 때만 보여준다. 생성 중 partial은 숨기고
  // Generating 플레이스홀더만 그린다 (뒤에서 실시간 병합이 도는 느낌 제거).
  const { preferences } = useSettings()
  const sseOn = preferences?.sseStreaming ?? true
  // bash 감시자: opencode가 timeout에 kill하지 못하고 running이 고착되면
  // 중단 확인 토스트만 띄운다 (자동 abort 금지 — 되돌릴 수 없는 동작이라 사용자 판단에 맡긴다).
  // (opencode 기본 2분·최대 10분 강제 + grace 60초. 정상 종료분은 status가 바뀌어 스킵된다.)
  // 표시 여부(SSE off 숨김)와 무관하게 여기서 감시한다.
  const abortSession = useAbortSession(opcodeUrl, directory)
  const abortRef = useRef(abortSession.mutate)
  abortRef.current = abortSession.mutate
  const watchdogFiredRef = useRef<{ sessionID: string; keys: Set<string> }>({ sessionID: '', keys: new Set() })
  useEffect(() => {
    if (!messages || !sessionID) return
    if (watchdogFiredRef.current.sessionID !== sessionID) {
      watchdogFiredRef.current = { sessionID, keys: new Set() }
    }
    const fired = watchdogFiredRef.current.keys
    if (fired.size > 1000) fired.clear()
    for (const m of messages) {
      if (m.info.role !== 'assistant') continue
      for (const p of m.parts ?? []) {
        if ((p as { type?: string }).type !== 'tool') continue
        const tool = (p as { tool?: string }).tool
        if (tool !== 'bash' && tool !== 'shell' && tool !== 'terminal') continue
        const st = (p as { state?: { status?: string; time?: { start?: number }; input?: { timeout?: number } } }).state
        if (st?.status !== 'running') continue
        const inputTimeout = typeof st.input?.timeout === 'number' && st.input.timeout > 0 ? st.input.timeout : 120_000
        const timeoutMs = Math.min(inputTimeout, 600_000)
        const start = st.time?.start ?? m.info.time?.created ?? 0
        if (!start || Date.now() - start < timeoutMs + 60_000) continue
        const pid = (p as { id?: string }).id ?? ''
        const key = `bash-stuck:${sessionID}:${m.info.id}:${pid}`
        if (fired.has(key)) continue
        fired.add(key)
        const secs = Math.round(timeoutMs / 1000)
        showToast.warning(`Bash가 timeout(${secs}s)을 넘겨도 실행 중입니다 — 고착이면 중단하세요`, {
          id: key,
          duration: 15000,
          action: {
            label: '중단하기',
            onClick: () => abortRef.current(sessionID),
          },
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, sessionID])
  if (!messages) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-zinc-600 gap-2">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-600 border-t-transparent" />
        <div>Loading messages...</div>
      </div>
    )
  }
  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-zinc-600 gap-2">
        {isLoading ? (
          <>
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-600 border-t-transparent" />
            <div>Loading messages...</div>
          </>
        ) : (
          "No messages yet. Start a conversation below."
        )}
      </div>
    )
  }

  const visibleMessages = preVisible

  return (
    <div className="flex flex-col space-y-2 p-2 overflow-x-hidden">
      {visibleMessages.map(({ msg, parts, assistantText }) => {
        const isSendingPlaceholder = msg.info.id.startsWith("optimistic_sending_")
        // sending 표시는 입력창 위 오버레이(SendingPill)가 담당. 본문에는 그리지 않는다.
        if (isSendingPlaceholder) {
          return null
        }
        // 필터(synthetic task 문구 등)로 가시 파트가 하나도 안 남으면 버블 자체를 그리지 않는다
        if (msg.info.role === 'user' && parts.length === 0) {
          return null
        }
        const streaming = isMessageStreaming(msg)
        const thinking = isMessageThinking(msg)
        const isAborted = (() => {
          const errName = (msg.info as any)?.error?.name ?? (msg.info as any)?.error?.data?.name
          if (errName === "MessageAbortedError") return true
          if ((msg.info as any)?.finish === "aborted") return true
          if (msg.parts?.some((p: any) => p.type === "step-finish" && p.reason === "aborted")) return true
          return false
        })()
        const isError = !isAborted && isErrorMessage(msg)
        const isLength = (() => {
          const finish = (msg.info as any)?.finish
          const errName = (msg.info as any)?.error?.name
          if (finish === "length" || errName === "MessageOutputLengthError") return true
          if (msg.parts?.some((p: any) => p.type === "step-finish" && p.reason === "length")) return true
          return false
        })()
        
        return (
            <div
              key={msg.info.id}
              id={`message-${msg.info.id}`}
              className={`flex flex-col group ${highlightedMessageID === msg.info.id ? 'message-highlight' : ''}`}
            >
              <div
              className={`w-full rounded-lg p-1.5 ${
                isLength
                  ? 'bg-red-500/20 border border-red-500/50 animate-pulse'
                  : isAborted
                    ? 'bg-zinc-500/10 border border-zinc-500/30'
                    : isError
                      ? 'bg-red-600/15 border border-red-600/40'
                      : msg.info.role === 'user'
                        ? 'bg-blue-600/20 border border-blue-600/30'
                        : 'bg-card/50 border border-border'
              } ${streaming ? 'animate-pulse-subtle' : ''}`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-xs font-medium ${isLength ? 'text-red-500 font-bold' : isAborted ? 'text-zinc-400' : isError ? 'text-red-400' : 'text-zinc-400'}`}>
                  {isLength ? 'Truncated due to context limit' : isAborted ? 'Canceled' : isError ? 'Error' : msg.info.role === 'user' ? 'You' : (msg.info.role === 'assistant' && 'modelID' in msg.info ? msg.info.modelID : 'Assistant')}
                </span>
                {msg.info.time && (
                  <span className="text-xs text-muted-foreground" title={new Date(msg.info.time.created).toLocaleString()}>
                    {formatChatTime(msg.info.time.created)}
                  </span>
                )}
                {msg.info.id.startsWith("optimistic_") && (
                  <span className="text-xs text-amber-400 flex items-center gap-1">
                    <span className="h-3 w-3 animate-spin rounded-full border border-amber-400 border-t-transparent" />
                    sending...
                  </span>
                )}
                {streaming && (
                  <span className="text-xs text-blue-400 flex items-center gap-1">
                    <span className="animate-pulse">●</span> <span className="shine-loading">Generating...</span>
                  </span>
                )}
                {msg.info.role === 'user' && !streaming && (
                  <button
                    onClick={() => {
                      const raw = getRawMessageTextContent(msg)
                      void copyTextToClipboard(raw)
                    }}
                    className="ml-auto p-1 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary cursor-pointer"
                    title="Copy (including <memory-recall>)"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                )}
                {msg.info.role === 'user' && onEditMessage && !streaming && (
                  <button
                    onClick={() => onEditMessage(msg.info.id, getEditablePrompt(msg, invocations?.get(msg.info.id), directory))}
                    className="p-1 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary cursor-pointer"
                    title="Edit and resend"
                  >
                    <CornerDownLeft className="w-3.5 h-3.5" />
                  </button>
                )}
                {msg.info.role === 'user' && onTruncate && !streaming && (
                  <button
                    onClick={() => onTruncate(msg.info.id)}
                    className="p-1 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary cursor-pointer"
                    title="Delete this message and everything after"
                  >
                    <Scissors className="w-3.5 h-3.5" />
                  </button>
                )}
                {msg.info.role === 'user' && onDelete && (
                  <button
                    onClick={() => onDelete(msg.info.id)}
                    className="p-1 rounded-md hover:bg-red-500/10 text-muted-foreground hover:text-red-500 cursor-pointer"
                    title="Delete this message turn"
                  >
                    <Eraser className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              
              {thinking ? (
                <div className="flex items-center gap-2 text-zinc-500">
                  <span className="animate-pulse">▋</span>
                  <span className="text-sm shine-loading">Thinking...</span>
                </div>
              ) : (
                <div className="space-y-2">
                  {!sseOn && streaming && msg.info.role === 'assistant' ? (
                    <div className="flex items-center gap-2 text-zinc-500">
                      <span className="animate-pulse">▋</span>
                      <span className="text-sm shine-loading">Generating...</span>
                    </div>
                  ) : (
                  parts.map((part, index) => (
                      <div key={`${msg.info.id}-${(part as { id: string }).id}-${index}`}>
                        <MessagePart
                          part={part as typeof msg.parts[number]}
                          role={msg.info.role}
                          allParts={msg.parts}
                          partIndex={index}
                          onFileClick={onFileClick}
                          messageTextContent={assistantText}
                          directory={directory}
                          messageStreaming={streaming}
                          invocation={msg.info.role === 'user' ? invocations?.get(msg.info.id) : undefined}
                          onCommandClick={onOpenCommandHistory}
                        />
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })}
      {editIndex >= 0 && (
        <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground border border-dashed rounded-md border-primary/40 bg-primary/5">
          <span>Editing from this message — the rest is hidden</span>
          {onCancelEdit && (
            <button
              onClick={onCancelEdit}
              className="ml-auto flex items-center gap-1 p-1 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary cursor-pointer"
              title="Cancel edit and restore messages"
            >
              <X className="w-3 h-3" />
              <span>Cancel</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
})
