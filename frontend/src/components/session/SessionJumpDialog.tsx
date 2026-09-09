import { useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import type { MessageWithParts } from '@/api/types'
import { stripMemoryRecall } from '@/lib/stripRecall'

interface SessionJumpDialogProps {
  open: boolean
  onClose: () => void
  messages?: MessageWithParts[]
  onJump: (messageID: string) => void
}

function previewOf(msg: MessageWithParts): string {
  for (const raw of msg.parts) {
    const p = raw as unknown as { type?: string; text?: unknown; tool?: unknown }
    if ((p.type === 'text' || p.type === 'reasoning') && typeof p.text === 'string') {
      const t = stripMemoryRecall(p.text).trim()
      if (t) return t.length > 90 ? t.slice(0, 90) + '…' : t
    }
    if (p.type === 'tool' && typeof p.tool === 'string') return `[tool:${p.tool}]`
    if (p.type === 'file') return '[file]'
  }
  return '(empty)'
}

export function SessionJumpDialog({ open, onClose, messages, onJump }: SessionJumpDialogProps) {
  const [q, setQ] = useState('')
  const items = useMemo(() => {
    const list = messages ?? []
    const needle = q.trim().toLowerCase()
    const mapped = list.map((m, i) => ({ m, i, preview: previewOf(m) }))
    if (!needle) return mapped
    return mapped.filter(({ m, preview }) => {
      const info = m.info as unknown as { role?: string }
      return preview.toLowerCase().includes(needle) || (info.role ?? '').includes(needle)
    })
  }, [messages, q])

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent
        className="max-w-lg max-h-[80vh] flex flex-col"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DialogTitle>Search / Go to message</DialogTitle>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search (content · user / assistant)…"
          autoFocus
          className="h-8 px-2 rounded-md bg-muted/40 border border-border text-xs focus:border-primary focus:outline-none"
        />
        <div className="overflow-y-auto min-h-0 flex-1 -mx-1 px-1">
          {items.length === 0 && (
            <div className="text-xs text-muted-foreground py-6 text-center">No messages found</div>
          )}
          {items.map(({ m, i, preview }) => {
            const info = m.info as unknown as { id: string; role?: string; time?: { created?: number } }
            return (
              <button
                key={info.id}
                onClick={() => onJump(info.id)}
                className="w-full text-left px-2 py-1.5 rounded-md hover:bg-accent flex items-baseline gap-2 cursor-pointer"
              >
                <span className="text-[10px] font-mono text-muted-foreground w-8 shrink-0">#{i + 1}</span>
                <span className={`text-[10px] font-medium w-14 shrink-0 ${info.role === 'user' ? 'text-blue-500' : 'text-muted-foreground'}`}>
                  {info.role === 'user' ? 'You' : 'Asst'}
                </span>
                <span className="text-xs truncate flex-1">{preview}</span>
                {info.time?.created ? (
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {new Date(info.time.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
