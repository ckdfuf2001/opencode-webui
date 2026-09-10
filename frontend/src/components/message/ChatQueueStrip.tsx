import { useState } from 'react'
import { ChevronDown, ChevronRight, ChevronUp, ChevronsUp, Clock, X } from 'lucide-react'
import { useMoveQueuedChat, useQueuedChats, useRemoveQueuedChat } from '@/hooks/useChatQueue'

interface ChatQueueStripProps {
  sessionID: string
}

export function ChatQueueStrip({ sessionID }: ChatQueueStripProps) {
  const { data: items = [] } = useQueuedChats(sessionID)
  const removeChat = useRemoveQueuedChat()
  const moveChat = useMoveQueuedChat()
  const [minimized, setMinimized] = useState(true)
  const sendingItem = items.find((item) => item.status === 'sending')
  const failedItem = !sendingItem ? items.find((item) => item.status === 'failed') : undefined
  // failed 항목은 목록에 남겨 X로 지울 수 있게 한다. sending만 제목으로 올린다.
  const restItems = sendingItem ? items.filter((item) => item.id !== sendingItem.id) : items

  if (items.length === 0) return null

  if (minimized) {
    return (
      <div className="w-full max-w-4xl px-4 pb-1">
        <button
          type="button"
          onClick={() => setMinimized(false)}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted transition-colors"
          title="Expand queue"
        >
          {sendingItem ? (
            <Clock className="h-3 w-3 shrink-0 animate-spin" />
          ) : failedItem ? (
            <X className="h-3 w-3 shrink-0 text-destructive" />
          ) : (
            <Clock className="h-3 w-3 shrink-0" />
          )}
          {sendingItem ? (
            <span className="truncate opacity-60">Sending... {sendingItem.text}</span>
          ) : failedItem ? (
            <span className="truncate text-destructive">Failed to send — tap X on the item to remove</span>
          ) : (
            <span className="shrink-0">Waiting to send</span>
          )}
          <span className="shrink-0">({restItems.length})</span>
          <ChevronRight className="h-3 w-3 shrink-0" />
        </button>
      </div>
    )
  }

  return (
    <div className="w-full max-w-4xl px-4 pb-1">
      <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs">
        <div className="mb-1 flex items-center gap-1.5 font-medium text-muted-foreground">
          {sendingItem ? (
            <Clock className="h-3 w-3 shrink-0 animate-spin" />
          ) : failedItem ? (
            <X className="h-3 w-3 shrink-0 text-destructive" />
          ) : (
            <Clock className="h-3 w-3 shrink-0" />
          )}
          {sendingItem ? (
            <span className="min-w-0 flex-1 truncate opacity-60">Sending... {sendingItem.text}</span>
          ) : failedItem ? (
            <span className="min-w-0 flex-1 truncate text-destructive">Failed to send — remove the item below</span>
          ) : (
            <span className="flex-1">Waiting to send</span>
          )}
          <span className="shrink-0">({restItems.length})</span>
          <button
            type="button"
            aria-label="Minimize queue"
            className="rounded p-0.5 text-muted-foreground opacity-60 transition-opacity hover:opacity-100 hover:text-foreground"
            onClick={() => setMinimized(true)}
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>
        <ul className="space-y-1">
          {restItems.map((item, index) => (
            <li key={item.id} className="group flex items-center gap-2">
              <span className="shrink-0 text-muted-foreground">{index + 1}.</span>
              <span className={`min-w-0 flex-1 truncate break-words ${item.status === 'failed' ? 'text-destructive' : 'text-foreground/80'}`}>
                {item.text}
                {item.status === 'failed' && (
                  <span className="ml-1.5 text-[10px]">failed</span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  aria-label="Move to first"
                  title="Move to first"
                  disabled={index === 0}
                  className="rounded p-0.5 text-muted-foreground opacity-60 transition-opacity hover:opacity-100 hover:text-foreground disabled:pointer-events-none disabled:opacity-20"
                  onClick={() => moveChat.mutate({ sessionID, id: item.id, toTop: true })}
                >
                  <ChevronsUp className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  aria-label="Move up one"
                  title="Move up one"
                  disabled={index === 0}
                  className="rounded p-0.5 text-muted-foreground opacity-60 transition-opacity hover:opacity-100 hover:text-foreground disabled:pointer-events-none disabled:opacity-20"
                  onClick={() => moveChat.mutate({ sessionID, id: item.id, toTop: false })}
                >
                  <ChevronUp className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  aria-label="Remove queued message"
                  className="rounded p-0.5 text-muted-foreground opacity-60 transition-opacity hover:opacity-100 hover:text-destructive"
                  onClick={() => removeChat.mutate({ sessionID, id: item.id })}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
