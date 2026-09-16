import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useMessageList, type MessageListItem } from '@/hooks/useOpenCode'
import { searchMessages, reindexMessages, type MessageSearchHit } from '@/api/search'
import { formatChatTime } from '@/lib/chatTime'

interface SessionJumpDialogProps {
  open: boolean
  onClose: () => void
  sessionId: string | undefined
  repoId?: number | null
  repoLabel?: string
  onJump: (messageID: string) => void
}

const ENTRY_LIMIT = 20
const SEARCH_PAGE = 20

export function SessionJumpDialog({ open, onClose, sessionId, repoId, repoLabel, onJump }: SessionJumpDialogProps) {
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const needle = q.trim()

  // 진입 시 FTS 인덱스를 증분 동기화 (화끈한 전체 rebuild가 아님) 후 목록 조회.
  // FTS 검색은 동기화 완료 후에만 켠다 — 동시에 쏘면 stale 인덱스로 빗나간다.
  // 같은 세션 재입장에서는 상태(검색어·목록·선택)를 유지하고, 60초 이내 동기화는 건너뛴다.
  // 매번 비우고 다시 로딩하면 깜빡이고 느리다.
  const [indexReady, setIndexReady] = useState(false)
  const lastSessionRef = useRef<string | null>(null)
  const lastSyncRef = useRef(0)
  useEffect(() => {
    if (!open || !sessionId) return
    const switched = lastSessionRef.current !== sessionId
    lastSessionRef.current = sessionId
    if (switched) {
      setQ('')
      setOffset(0)
      setEntryOffset(0)
      setEntryAcc([])
      setAcc([])
    }
    const fresh = Date.now() - lastSyncRef.current < 60_000 && !switched
    if (fresh) {
      setIndexReady(true)
      return
    }
    if (switched) setIndexReady(false)
    let cancelled = false
    void reindexMessages(sessionId)
      .catch(() => {})
      .finally(() => {
        if (cancelled) return
        lastSyncRef.current = Date.now()
        setIndexReady(true)
      })
    return () => { cancelled = true }
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
    enabled: open && !!sessionId && needle.length > 0 && indexReady,
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

  // 리스트 선택: 체크·범위 → 선택 출력 (검색 페이지와 같은 JSON 양식)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [outputOpen, setOutputOpen] = useState(false)
  const [rangeMode, setRangeMode] = useState(false)
  const [rangeStart, setRangeStart] = useState<string | null>(null)
  useEffect(() => {
    setSelectedIds(new Set())
    setOutputOpen(false)
    setRangeMode(false)
    setRangeStart(null)
  }, [sessionId])
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  // 출력 양식은 검색 페이지 selectedJson과 동일 키
  // (kind/repo/repoId/sessionId/messageId/turnIndex/role/ts/snippet/meta)
  const selectedOutput = useMemo(() => {
    if (selectedIds.size === 0) return ''
    const rows: Array<Record<string, unknown>> = []
    if (needle.length === 0) {
      // entry 목록은 turn 0부터 연속 누적되므로 인덱스가 곧 turnIndex다
      entryItems.forEach((m, i) => {
        if (!selectedIds.has(m.id)) return
        rows.push({
          kind: 'message', repo: repoLabel ?? '', repoId: repoId ?? null,
          sessionId, messageId: m.id, turnIndex: i, role: m.role, ts: m.created,
          snippet: m.preview, meta: `${m.role} turn ${i}`,
        })
      })
    } else {
      for (const h of searchItems) {
        if (!selectedIds.has(h.messageId)) continue
        rows.push({
          kind: 'message', repo: repoLabel ?? '', repoId: repoId ?? null,
          sessionId, messageId: h.messageId, turnIndex: h.turnIndex, role: h.role, ts: h.ts,
          snippet: h.snippet, meta: `${h.role} turn ${h.turnIndex}`,
        })
      }
    }
    return JSON.stringify(rows, null, 2)
  }, [selectedIds, needle, entryItems, searchItems, sessionId, repoId, repoLabel])

  const visibleIds = useMemo(() => {
    return needle.length === 0
      ? entryItems.map((m) => m.id)
      : searchItems.map((h) => h.messageId)
  }, [needle, entryItems, searchItems])

  const handleRowClick = (id: string) => {
    if (!rangeMode) {
      onJump(id)
      return
    }
    if (rangeStart == null) {
      setRangeStart(id)
      return
    }
    const a = visibleIds.indexOf(rangeStart)
    const b = visibleIds.indexOf(id)
    if (a === -1 || b === -1) {
      setRangeStart(id)
      return
    }
    const [from, to] = a <= b ? [a, b] : [b, a]
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (let i = from; i <= to; i++) next.add(visibleIds[i]!)
      return next
    })
    setRangeStart(null)
    setRangeMode(false)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent
        className="max-w-lg max-h-[80vh] flex flex-col"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DialogTitle>Search / Go to message{total != null && total > 0 ? ` (${total})` : ''}</DialogTitle>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {rangeMode
              ? (rangeStart ? '종료점을 누르세요' : '시작점을 누르세요')
              : selectedIds.size > 0 ? `${selectedIds.size}개 선택됨` : '행 클릭: 이동 · 체크: 선택'}
          </span>
          <span className="flex-1" />
          <button
            onClick={() => { setRangeMode((v) => !v); setRangeStart(null) }}
            title="범위 선택: 시작 행 → 종료 행"
            className={`text-[11px] px-2 py-1 rounded border ${rangeMode ? 'border-primary bg-primary/10 text-primary' : 'border-input hover:bg-accent text-muted-foreground'}`}
          >
            범위 선택{rangeMode ? (rangeStart ? ' (종료점…)' : ' (시작점…)') : ''}
          </button>
          {selectedIds.size > 0 && (
            <button
              onClick={() => setSelectedIds(new Set())}
              className="text-[11px] px-2 py-1 rounded hover:bg-accent text-muted-foreground"
            >
              선택 해제
            </button>
          )}
          <button
            onClick={() => setOutputOpen((v) => !v)}
            disabled={selectedIds.size === 0}
            className="text-[11px] px-2 py-1 rounded border border-input hover:bg-accent disabled:opacity-40"
          >
            선택 출력 ({selectedIds.size})
          </button>
        </div>
        {outputOpen && selectedOutput && (
          <div className="rounded-md border border-input bg-background">
            <div className="flex items-center justify-between px-2 py-1 border-b border-input">
              <span className="text-[11px] font-medium">선택 출력</span>
              <div className="flex gap-1">
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(selectedOutput)
                    } catch {
                      const ta = document.createElement('textarea')
                      ta.value = selectedOutput
                      document.body.appendChild(ta)
                      ta.select()
                      document.execCommand('copy')
                      document.body.removeChild(ta)
                    }
                  }}
                  className="text-[11px] px-2 py-0.5 rounded hover:bg-accent text-muted-foreground"
                >
                  Copy
                </button>
                <button
                  onClick={() => setOutputOpen(false)}
                  className="text-[11px] px-2 py-0.5 rounded hover:bg-accent text-muted-foreground"
                >
                  닫기
                </button>
              </div>
            </div>
            <pre className="text-[11px] whitespace-pre-wrap break-words font-mono p-2 max-h-48 overflow-y-auto">{selectedOutput}</pre>
          </div>
        )}
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
          {!indexReady && needle.length > 0 && (
            <div className="text-xs text-muted-foreground py-6 text-center">Indexing…</div>
          )}
          {!entryLoading && !searchLoading && needle.length === 0 && entryItems.length === 0 && (
            <div className="text-xs text-muted-foreground py-6 text-center">No messages found</div>
          )}
          {indexReady && !searchLoading && needle.length > 0 && searchItems.length === 0 && (
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
                  checked={selectedIds.has(m.id)}
                  rangeStart={rangeMode && rangeStart === m.id}
                  onCheck={() => toggleSelect(m.id)}
                  onJump={() => handleRowClick(m.id)}
                />
              ))
            : searchItems.map((h: MessageSearchHit) => (
                <JumpRow
                  key={h.messageId}
                  no={h.turnIndex + 1}
                  role={h.role}
                  preview={h.snippet}
                  created={h.ts}
                  checked={selectedIds.has(h.messageId)}
                  rangeStart={rangeMode && rangeStart === h.messageId}
                  onCheck={() => toggleSelect(h.messageId)}
                  onJump={() => handleRowClick(h.messageId)}
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

function JumpRow({ no, role, preview, created, checked, rangeStart, onCheck, onJump }: {
  no: number
  role: string
  preview: string
  created: number
  checked: boolean
  rangeStart: boolean
  onCheck: () => void
  onJump: () => void
}) {
  return (
    <div
      onClick={onJump}
      className={`w-full text-left px-2 py-1.5 rounded-md hover:bg-accent flex items-baseline gap-2 cursor-pointer ${checked ? 'bg-primary/5 ring-1 ring-primary/30' : ''} ${rangeStart ? 'ring-1 ring-primary/60 bg-primary/10' : ''}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onCheck}
        onClick={(e) => e.stopPropagation()}
        className="h-3.5 w-3.5 shrink-0 accent-primary"
        title="선택"
      />
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
    </div>
  )
}
