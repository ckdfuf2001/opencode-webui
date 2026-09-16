import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useMessageList, type MessageListItem } from '@/hooks/useOpenCode'
import { searchMessages, reindexMessages, type MessageSearchHit } from '@/api/search'
import { formatChatTime } from '@/lib/chatTime'

interface SessionJumpDialogProps {
  open: boolean
  onClose: () => void
  sessionId: string | undefined
  onJump: (messageID: string) => void
}

const ENTRY_LIMIT = 20
const SEARCH_PAGE = 20

export function SessionJumpDialog({ open, onClose, sessionId, onJump }: SessionJumpDialogProps) {
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const needle = q.trim()

  // 진입 시 FTS 인덱스를 증분 동기화 (화끈한 전체 rebuild가 아님) 후 목록 조회
  useEffect(() => {
    if (!open || !sessionId) return
    setQ('')
    setOffset(0)
    setEntryOffset(0)
    setEntryAcc([])
    void reindexMessages(sessionId).catch(() => {})
  }, [open, sessionId])

  // 검색어 없음: 전체를 오래된 것부터 나눠서 미리보기만 로드 (200자 cap, parts 없음).
  // "더 보기"는 offset 페이지네이션 + 누적 append — 60개 캐시와 무관하게 전체를 본다.
  const [entryOffset, setEntryOffset] = useState(0)
  const { data: entryPage, isLoading: entryLoading, isFetching: entryFetching } = useMessageList(sessionId, {
    limit: ENTRY_LIMIT,
    offset: entryOffset,
    order: 'asc',
    enabled: open && needle.length === 0,
  })
  const [entryAcc, setEntryAcc] = useState<MessageListItem[]>([])
  useEffect(() => {
    if (!entryPage) return
    setEntryAcc((prev) => {
      if (entryOffset === 0) return entryPage.items
      const seen = new Set(prev.map((p) => p.id))
      return [...prev, ...entryPage.items.filter((m) => !seen.has(m.id))]
    })
  }, [entryPage, entryOffset])
  const entryTotal = entryPage?.total ?? 0
  const entryHasMore = entryAcc.length < entryTotal

  // 검색어 있음: FTS 분할 검색 ("더 보기"는 누적 append)
  const { data: searchPage, isLoading: searchLoading, isFetching: searchFetching } = useQuery({
    queryKey: ['message-search', sessionId, needle, offset],
    queryFn: () => searchMessages({ q: needle, k: SEARCH_PAGE, offset, sessionId: sessionId! }),
    enabled: open && !!sessionId && needle.length > 0,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const [acc, setAcc] = useState<MessageSearchHit[]>([])
  useEffect(() => {
    setAcc([])
    setOffset(0)
  }, [needle, sessionId])
  useEffect(() => {
    if (!searchPage) return
    setAcc((prev) => {
      if (offset === 0) return searchPage.hits
      const seen = new Set(prev.map((p) => p.messageId))
      return [...prev, ...searchPage.hits.filter((h) => !seen.has(h.messageId))]
    })
  }, [searchPage, offset])

  const searchItems = acc
  const hasMore = searchPage?.hasMore ?? false
  const total = needle.length === 0 ? entryTotal : searchPage?.total
  const entryItems = entryAcc

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent
        className="max-w-lg max-h-[80vh] flex flex-col"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DialogTitle>Search / Go to message{total != null && total > 0 ? ` (${total})` : ''}</DialogTitle>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search (content · user / assistant)…"
          autoFocus
          className="h-8 px-2 rounded-md bg-muted/40 border border-border text-xs focus:border-primary focus:outline-none"
        />
        <div className="overflow-y-auto min-h-0 flex-1 -mx-1 px-1">
          {(entryLoading || searchLoading) && searchItems.length === 0 && entryItems.length === 0 && (
            <div className="text-xs text-muted-foreground py-6 text-center">Loading…</div>
          )}
          {!entryLoading && !searchLoading && needle.length === 0 && entryItems.length === 0 && (
            <div className="text-xs text-muted-foreground py-6 text-center">No messages found</div>
          )}
          {!searchLoading && needle.length > 0 && searchItems.length === 0 && (
            <div className="text-xs text-muted-foreground py-6 text-center">No messages found</div>
          )}
          {needle.length === 0
            ? entryItems.map((m: MessageListItem, i: number) => (
                <JumpRow
                  key={m.id}
                  no={i + 1}
                  role={m.role}
                  preview={m.preview}
                  created={m.created}
                  onJump={() => onJump(m.id)}
                />
              ))
            : searchItems.map((h: MessageSearchHit) => (
                <JumpRow
                  key={h.messageId}
                  no={h.turnIndex + 1}
                  role={h.role}
                  preview={h.snippet}
                  created={h.ts}
                  onJump={() => onJump(h.messageId)}
                />
              ))}
          {needle.length === 0 && entryHasMore && (
            <button
              onClick={() => setEntryOffset((o) => o + ENTRY_LIMIT)}
              disabled={entryFetching}
              className="w-full text-center px-2 py-2 rounded-md hover:bg-accent text-xs text-muted-foreground cursor-pointer disabled:opacity-50"
            >
              {entryFetching ? 'Loading…' : `Show more (${entryItems.length} / ${entryTotal})`}
            </button>
          )}
          {needle.length > 0 && hasMore && (
            <button
              onClick={() => setOffset((o) => o + SEARCH_PAGE)}
              disabled={searchFetching}
              className="w-full text-center px-2 py-2 rounded-md hover:bg-accent text-xs text-muted-foreground cursor-pointer disabled:opacity-50"
            >
              {searchFetching ? 'Loading…' : `Show more (${searchItems.length} / ${searchPage?.total})`}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function JumpRow({ no, role, preview, created, onJump }: {
  no: number
  role: string
  preview: string
  created: number
  onJump: () => void
}) {
  return (
    <button
      onClick={onJump}
      className="w-full text-left px-2 py-1.5 rounded-md hover:bg-accent flex items-baseline gap-2 cursor-pointer"
    >
      <span className="text-[10px] font-mono text-muted-foreground w-8 shrink-0">#{no}</span>
      <span className={`text-[10px] font-medium w-14 shrink-0 ${role === 'user' ? 'text-blue-500' : 'text-muted-foreground'}`}>
        {role === 'user' ? 'You' : 'Asst'}
      </span>
      <span className="text-xs truncate flex-1">{preview}</span>
      {created ? (
        <span className="text-[10px] text-muted-foreground shrink-0">
          {formatChatTime(created)}
        </span>
      ) : null}
    </button>
  )
}
