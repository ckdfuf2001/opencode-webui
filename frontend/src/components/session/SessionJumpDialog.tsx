import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { API_BASE_URL } from '@/config'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import type { MessageListItem } from '@/hooks/useOpenCode'
import { searchMessages, reindexMessages, expandMessage, type MessageSearchHit, type MessageExpandRow } from '@/api/search'
import { toggleTurn } from '@/lib/turnSelection'
import { groupSearchHits } from '@opencode-webui/shared/lib/searchTurns'
import { SelectedExportButtons } from '@/components/session/SelectedExportButtons'
import { formatChatTime } from '@/lib/chatTime'

interface SessionJumpDialogProps {
  open: boolean
  onClose: () => void
  sessionId: string | undefined
  onJump: (messageID: string) => void
}

const ENTRY_PAGE = 100
const SEARCH_PAGE = 50

export function SessionJumpDialog({ open, onClose, sessionId, onJump }: SessionJumpDialogProps) {
  const [q, setQ] = useState('')
  const needle = q.trim()
  const queryClient = useQueryClient()
  // 다이얼로그는 닫혀도 마운트가 유지돼 observer가 남아 캐시가 안 비워진다.
  // close 시점에 쿼리를 직접 제거해 전체 로드분을 즉시 반납한다 (진행 중 루프는 signal abort).
  useEffect(() => {
    if (!open) {
      queryClient.removeQueries({ queryKey: ['message-list-all'] })
      queryClient.removeQueries({ queryKey: ['message-search-all'] })
    }
  }, [open, queryClient])

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

  // 검색어 없음: 전체를 오래된 것부터 미리보기만 자동 로드 (200자 cap, parts 없음).
  // 검색어 있음: FTS 전체 자동 로드. 닫으면 캐시가 반납되므로 열려 있는 동안만 전체를 들고 있는다.
  const { data: entryAll, isLoading: entryLoading, isFetching: entryFetching } = useQuery({
    queryKey: ['message-list-all', sessionId],
    queryFn: async ({ signal }) => {
      const items: MessageListItem[] = []
      let total = 0
      let offset = 0
      for (;;) {
        const params = new URLSearchParams({ limit: String(ENTRY_PAGE), offset: String(offset), order: 'asc' })
        const res = await fetch(`${API_BASE_URL}/api/session-messages/${sessionId!}/list?${params.toString()}`, { signal })
        if (!res.ok) throw new Error('Failed to load message list')
        const page = (await res.json()) as { total: number; items: MessageListItem[] }
        total = page.total
        const seen = new Set(items.map((m) => m.id))
        const fresh = page.items.filter((m) => !seen.has(m.id))
        items.push(...fresh)
        if (items.length >= total || fresh.length === 0) break
        offset += ENTRY_PAGE
      }
      return { total, items }
    },
    enabled: open && !!sessionId && needle.length === 0,
    staleTime: 15_000,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const entryItems = entryAll?.items ?? []
  const entryTotal = entryAll?.total ?? 0

  const { data: searchAll, isLoading: searchLoading, isFetching: searchFetching } = useQuery({
    queryKey: ['message-search-all', sessionId, needle],
    queryFn: async ({ signal }) => {
      const hits: MessageSearchHit[] = []
      const seen = new Set<string>()
      let offset = 0
      let total = 0
      for (;;) {
        const page = await searchMessages({ q: needle, k: SEARCH_PAGE, offset, sessionId: sessionId!, signal })
        total = page.total
        let added = 0
        for (const h of page.hits) {
          if (!h.messageId || seen.has(h.messageId)) continue
          seen.add(h.messageId)
          hits.push(h)
          added++
        }
        if (!page.hasMore || added === 0) break
        offset += SEARCH_PAGE
      }
      return { total, hits }
    },
    enabled: open && !!sessionId && needle.length > 0 && indexReady,
    staleTime: 15_000,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const searchItems = searchAll?.hits ?? []
  const total = needle.length === 0 ? entryTotal : (searchAll?.total ?? 0)

  // 리스트 선택: 체크·범위 → 선택 출력 드롭다운 (md/txt/html/pdf/json)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [rangeMode, setRangeMode] = useState(false)
  const [rangeStart, setRangeStart] = useState<string | null>(null)
  // F1-2: 3단계 펼침 상태 (턴 키 기준). 상세 내용은 턴 단위로 불러와 캐시한다.
  const [expandedTurnKey, setExpandedTurnKey] = useState<string | null>(null)
  const [detailTurnKey, setDetailTurnKey] = useState<string | null>(null)
  const [detailLoadingKey, setDetailLoadingKey] = useState<string | null>(null)
  const detailCache = useRef(new Map<string, MessageExpandRow[]>())
  useEffect(() => {
    setSelectedIds(new Set())
    setRangeMode(false)
    setRangeStart(null)
    setExpandedTurnKey(null)
    setDetailTurnKey(null)
  }, [sessionId])

  const visibleIds = useMemo(() => {
    return needle.length === 0
      ? entryItems.map((m) => m.id)
      : searchItems.map((h) => h.messageId)
  }, [needle, entryItems, searchItems])

  // F1-2: 검색 결과는 턴 단위로 묶어 보여준다 (user → 다음 user).
  const turnGroups = useMemo(
    () => (needle.length === 0 ? [] : groupSearchHits(searchItems)),
    [needle, searchItems],
  )
  const turnKeys = useMemo(() => turnGroups.map((g) => g.key), [turnGroups])
  const turnOf = (key: string): MessageSearchHit[] => {
    const g = turnGroups.find((x) => x.key === key)
    if (!g) return []
    return g.hitIndexes.map((i) => searchItems[i]).filter((h): h is MessageSearchHit => !!h)
  }
  const turnUserOf = (key: string): { messageId: string; text: string } | null => {
    for (const h of turnOf(key)) {
      if (h.turnUser) return { messageId: h.turnUser.messageId, text: h.turnUser.text }
    }
    const firstUser = turnOf(key).find((h) => h.role === 'user')
    if (firstUser) return { messageId: firstUser.messageId, text: firstUser.snippet }
    return null
  }

  // 체크 토글: user면 다음 user 전까지 턴 단위, assistant는 낱개 (해제도 낱개 가능)
  const toggleSelect = (id: string) => {
    const ids = visibleIds
    const roles =
      needle.length === 0
        ? entryItems.map((m) => m.role as string | undefined)
        : searchItems.map((h) => h.role as string | undefined)
    const index = ids.indexOf(id)
    if (index === -1) {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      return
    }
    setSelectedIds((prev) => toggleTurn(prev, ids, roles, index))
  }

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

  // F1-2: 턴 단위 선택 토글 (턴 안 메시지 전체를 한 번에).
  const toggleSelectTurn = (key: string): void => {
    const ids = turnOf(key).map((h) => h.messageId).filter(Boolean)
    if (ids.length === 0) return
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (ids.every((k) => next.has(k))) for (const k of ids) next.delete(k)
      else for (const k of ids) next.add(k)
      return next
    })
  }

  const handleTurnRowClick = (key: string): void => {
    if (rangeMode) {
      if (rangeStart == null) {
        setRangeStart(key)
        return
      }
      const a = turnKeys.indexOf(rangeStart)
      const b = turnKeys.indexOf(key)
      if (a === -1 || b === -1) {
        setRangeStart(key)
        return
      }
      const [from, to] = a <= b ? [a, b] : [b, a]
      setSelectedIds((prev) => {
        const next = new Set(prev)
        for (let i = from; i <= to; i++) for (const h of turnOf(turnKeys[i]!)) next.add(h.messageId)
        return next
      })
      setRangeStart(null)
      setRangeMode(false)
      return
    }
    // 1단계: 그 턴의 마지막 assistant 응답을 펼친다.
    setDetailTurnKey(null)
    setExpandedTurnKey((prev) => (prev === key ? null : key))
  }

  // F1-2: 2단계 상세 — 턴 전체(도구 호출·중간 응답 포함)를 그때 불러와 캐시한다.
  const loadTurnDetail = async (key: string): Promise<void> => {
    if (detailTurnKey === key) {
      setDetailTurnKey(null)
      return
    }
    const cached = detailCache.current.get(key)
    if (cached) {
      setDetailTurnKey(key)
      return
    }
    const tu = turnUserOf(key)
    if (!tu) return
    const groupHits = turnOf(key)
    const userTi = Math.min(...groupHits.map((h) => h.turnIndex ?? 0))
    setDetailLoadingKey(key)
    try {
      const d = await expandMessage(tu.messageId, 20)
      const sorted = [...d.rows].sort((a, b) => a.turnIndex - b.turnIndex)
      const out: MessageExpandRow[] = []
      let started = false
      for (const r of sorted) {
        if (!started) {
          if (r.turnIndex < userTi) continue
          started = true
        } else if (r.turnIndex > userTi && r.role === 'user') {
          break
        }
        out.push(r)
      }
      detailCache.current.set(key, out.length > 0 ? out : sorted)
      setDetailTurnKey(key)
    } catch {
      /* 무시 — 다음 클릭에 재시도 */
    } finally {
      setDetailLoadingKey(null)
    }
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
          : selectedIds.size > 0 ? `${selectedIds.size}개 선택됨` : '행 클릭: 펼치기 · 체크: 선택'}
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
          <SelectedExportButtons
            ids={[...selectedIds]}
            title={sessionId ? `선택 출력 ${selectedIds.size}개` : undefined}
          />
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search (content · user / assistant)…"
          autoFocus
          className="h-8 px-2 rounded-md bg-muted/40 border border-border text-xs focus:border-primary focus:outline-none"
        />
        <div className="overflow-y-auto min-h-0 flex-1 -mx-1 px-1">
          {(entryLoading || searchLoading || entryFetching || searchFetching) && searchItems.length === 0 && entryItems.length === 0 && (
            <div className="text-xs text-muted-foreground py-6 text-center">Loading all…{total > 0 ? ` (${total})` : ''}</div>
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
            : searchItems.length === 0 ? null : turnGroups.map((g) => {
                const hits = turnOf(g.key)
                if (hits.length === 0) return null
                const first = hits[0]!
                const tu = turnUserOf(g.key)
                const respOnly = hits.length > 0 && hits.every((h) => h.role !== 'user')
                const last = hits.map((h) => h.turnLast).find((x) => !!x) ?? null
                const allIds = hits.map((h) => h.messageId)
                const allChecked = allIds.length > 0 && allIds.every((k) => selectedIds.has(k))
                return (
                  <TurnRow
                    key={g.key}
                    turnKey={g.key}
                    userText={tu?.text ?? first.snippet}
                    created={first.ts}
                    respOnly={respOnly}
                    expanded={expandedTurnKey === g.key}
                    lastText={last?.text ?? null}
                    detailOpen={detailTurnKey === g.key}
                    detailLoading={detailLoadingKey === g.key}
                    detailRows={detailCache.current.get(g.key) ?? null}
                    checked={allChecked}
                    rangeStart={rangeMode && rangeStart === g.key}
                    onCheck={() => toggleSelectTurn(g.key)}
                    onToggleExpand={() => handleTurnRowClick(g.key)}
                    onToggleDetail={() => void loadTurnDetail(g.key)}
                    onJump={() => onJump(tu?.messageId ?? first.messageId)}
                  />
                )
              })}
          {(entryFetching || searchFetching) && (searchItems.length > 0 || entryItems.length > 0) && (
            <div className="w-full text-center px-2 py-2 text-xs text-muted-foreground">
              Loading… ({Math.max(searchItems.length, entryItems.length)}{total > 0 ? ` / ${total}` : ''})
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TurnRow({ turnKey, userText, created, respOnly, expanded, lastText, detailOpen, detailLoading, detailRows, checked, rangeStart, onCheck, onToggleExpand, onToggleDetail, onJump }: {
  turnKey: string
  userText: string
  created: number
  respOnly: boolean
  expanded: boolean
  lastText: string | null
  detailOpen: boolean
  detailLoading: boolean
  detailRows: MessageExpandRow[] | null
  checked: boolean
  rangeStart: boolean
  onCheck: () => void
  onToggleExpand: () => void
  onToggleDetail: () => void
  onJump: () => void
}) {
  return (
    <div
      data-testid="jump-turn-row"
      data-turn-key={turnKey}
      onClick={onToggleExpand}
      className={`w-full text-left px-2 py-1.5 rounded-md hover:bg-accent cursor-pointer ${checked ? 'bg-primary/5 ring-1 ring-primary/30' : ''} ${rangeStart ? 'ring-1 ring-primary/60 bg-primary/10' : ''}`}
    >
      <div className="flex items-baseline gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={onCheck}
          onClick={(e) => e.stopPropagation()}
          className="h-3.5 w-3.5 shrink-0 accent-primary"
          title="선택"
        />
        <span className="text-[10px] font-medium w-14 shrink-0 text-blue-500">You</span>
        <span className="text-xs truncate flex-1">{userText || '(empty)'}</span>
        {respOnly && (
          <span className="text-[10px] rounded bg-amber-500/15 text-amber-500 px-1 shrink-0" title="검색어가 응답에만 있어 속한 턴을 보여줍니다">응답에서 일치</span>
        )}
        {created ? (
          <span className="text-[10px] text-muted-foreground shrink-0">
            {formatChatTime(created)}
          </span>
        ) : null}
      </div>
      {expanded && (
        <div className="mt-1.5 ml-6 rounded bg-muted/30 p-2 text-xs" data-testid="jump-turn-last">
          {lastText ? (
            <div className="whitespace-pre-wrap break-words">{lastText}</div>
          ) : (
            <div className="text-muted-foreground">아직 응답 없음</div>
          )}
          <div className="mt-1.5 flex gap-1">
            <button
              type="button"
              data-testid="jump-turn-detail-btn"
              onClick={(e) => { e.stopPropagation(); onToggleDetail() }}
              className="text-[11px] px-2 py-0.5 rounded border border-input hover:bg-accent text-muted-foreground"
            >
              {detailOpen ? '상세 닫기' : detailLoading ? '불러오는 중…' : '상세'}
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onJump() }}
              className="text-[11px] px-2 py-0.5 rounded border border-input hover:bg-accent text-muted-foreground"
              title="해당 메시지로 이동"
            >
              이동
            </button>
          </div>
        </div>
      )}
      {expanded && detailOpen && (
        <div className="mt-1.5 ml-6 max-h-64 overflow-y-auto rounded border border-input bg-background/90 p-2 space-y-1.5" data-testid="jump-turn-detail">
          {(detailRows ?? []).map((row) => (
            <div key={row.messageId} className="text-xs">
              <div className="flex gap-2 text-[10px] text-muted-foreground mb-0.5">
                <span>{row.role}</span>
                <span>#{row.turnIndex}</span>
              </div>
              <div className="whitespace-pre-wrap break-words">{row.text || '(empty)'}</div>
            </div>
          ))}
        </div>
      )}
    </div>
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
