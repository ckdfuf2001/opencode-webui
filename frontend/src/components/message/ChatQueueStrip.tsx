import { Clock, X } from 'lucide-react'
import { useQueuedChats, useRemoveQueuedChat } from '@/hooks/useChatQueue'

interface ChatQueueStripProps {
  sessionID: string
}

export function ChatQueueStrip({ sessionID }: ChatQueueStripProps) {
  const { data: items = [] } = useQueuedChats(sessionID)
  const removeChat = useRemoveQueuedChat()

  if (items.length === 0) return null

  return (
    <div className="w-full max-w-3xl px-4 pb-1">
      <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs">
        <div className="mb-1 flex items-center gap-1.5 font-medium text-muted-foreground">
          <Clock className="h-3 w-3" />
          Waiting to send ({items.length})
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
