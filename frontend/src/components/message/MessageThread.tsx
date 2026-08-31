import { memo } from 'react'
import { MessagePart } from './MessagePart'
import { CornerDownLeft, Scissors, Eraser, X } from 'lucide-react'
import type { MessageWithParts } from '@/api/types'
import { ERROR_MESSAGE_ID_PREFIX } from '@/lib/chatErrors'
import { MENTION_PATTERN } from '@/lib/promptParser'
import { stripMemoryRecall } from '@/lib/stripRecall'

function getMessageTextContent(msg: MessageWithParts): string {
  return stripMemoryRecall(
    msg.parts
      .filter(p => p.type === 'text')
      .map(p => p.text || '')
      .join('\n\n')
      .trim(),
  )
}

function getEditablePrompt(msg: MessageWithParts): string {
  const lines: string[] = []
  for (const p of msg.parts) {
    if (p.type === 'file') {
      const filename = p.filename || p.url?.replace(/^file:\/{2,3}/, '').split('/').pop() || 'File'
      lines.push(`@"${filename}"`)
    } else if (p.type === 'text' && p.text) {
      const text = stripMemoryRecall(p.text.trim())
      if (!text) continue
      if (/^Called the \w+ tool with the following input:/i.test(text)) continue
      lines.push(text.replace(MENTION_PATTERN, (m, quoted, single, unquoted) => quoted || single ? m : `@"${unquoted}"`))
    }
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
}

export const isMessageStreaming = (msg: MessageWithParts): boolean => {
  if (msg.info.role !== 'assistant') return false
  return !('completed' in msg.info.time && msg.info.time.completed)
}

const isMessageThinking = (msg: MessageWithParts): boolean => {
  if (msg.info.role !== 'assistant') return false
  return msg.parts.length === 0 && isMessageStreaming(msg)
}

export const MessageThread = memo(function MessageThread({ messages, onFileClick, onEditMessage, onTruncate, onDelete, hiddenAfterID, onCancelEdit, highlightedMessageID, directory, isLoading }: MessageThreadProps) {
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

  const editIndex = hiddenAfterID ? messages.findIndex((m) => m.info.id === hiddenAfterID) : -1
  const visibleMessages = editIndex >= 0 ? messages.slice(0, editIndex + 1) : messages

  return (
    <div className="flex flex-col space-y-2 p-2 overflow-x-hidden">
      {visibleMessages.map((msg) => {
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
                  <span className="text-xs text-muted-foreground">
                    {new Date(msg.info.time.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                  </span>
                )}
                {streaming && (
                  <span className="text-xs text-blue-400 flex items-center gap-1">
                    <span className="animate-pulse">●</span> <span className="shine-loading">Generating...</span>
                  </span>
                )}
                {msg.info.role === 'user' && onEditMessage && !streaming && (
                  <button
                    onClick={() => onEditMessage(msg.info.id, getEditablePrompt(msg))}
                    className="ml-auto p-1 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary cursor-pointer"
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
                  {msg.parts
                    .map((part) => {
                      if ((part as { type?: string }).type === 'text' && typeof (part as { text?: string }).text === 'string') {
                        const t = stripMemoryRecall((part as { text: string }).text)
                        if (!t) return null
                        return { ...part, text: t } as typeof part
                      }
                      return part
                    })
                    .filter(Boolean)
                    .map((part, index) => (
                      <div key={`${msg.info.id}-${(part as { id: string }).id}-${index}`}>
                        <MessagePart
                          part={part as typeof msg.parts[number]}
                          role={msg.info.role}
                          allParts={msg.parts}
                          partIndex={index}
                          onFileClick={onFileClick}
                          messageTextContent={msg.info.role === 'assistant' ? getMessageTextContent(msg) : undefined}
                          directory={directory}
                          messageStreaming={streaming}
                        />
                      </div>
                    ))}
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
