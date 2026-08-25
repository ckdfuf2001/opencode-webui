import { useState } from 'react'
import { ChevronDown, ChevronRight, Clock, X } from 'lucide-react'
import { useQueuedChats, useRemoveQueuedChat } from '@/hooks/useChatQueue'

interface ChatQueueStripProps {
  sessionID: string
}

export function ChatQueueStrip({ sessionID }: ChatQueueStripProps) {
  const { data: items = [] } = useQueuedChats(sessionID)
  const removeChat = useRemoveQueuedChat()
  const [minimized, setMinimized] = useState(true)

  if (items.length === 0) return null

  if (minimized) {
    return (
      <div className="w-full max-w-3xl px-4 pb-1">
        <button
          type="button"
          onClick={() => setMinimized(false)}
          className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted transition-colors"
          title="Expand queue"
        >
          <Clock className="h-3 w-3" />
          Waiting to send ({items.length})
          <ChevronRight className="h-3 w-3" />
        </button>
      </div>
    )
  }

  return (
    <div className="w-full max-w-3xl px-4 pb-1">
      <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs">
        <div className="mb-1 flex items-center gap-1.5 font-medium text-muted-foreground">
          <Clock className="h-3 w-3" />
          <span className="flex-1">Waiting to send ({items.length})</span>
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
          {items.map((item, index) => (
            <li key={item.id} className="group flex items-start gap-2">
              <span className="shrink-0 text-muted-foreground">{index + 1}.</span>
              <span className="line-clamp-2 min-w-0 flex-1 break-words text-foreground/80">
                {item.text}
              </span>
              <button
                type="button"
                aria-label="Remove queued message"
                className="shrink-0 rounded p-0.5 text-muted-foreground opacity-60 transition-opacity hover:opacity-100 hover:text-destructive"
                onClick={() => removeChat.mutate({ sessionID, id: item.id })}
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
