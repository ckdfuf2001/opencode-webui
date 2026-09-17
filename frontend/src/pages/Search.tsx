import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Header } from '@/components/layout/Header'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { ChevronRight } from 'lucide-react'
import {
  expandMessage,
  getCommitDetail,
  deleteMessageIndexes,
  deleteCommitIndexes,
  type MessageExpandResult,
  type CommitDetail,
  type RecallHit,
} from '@/api/search'
import { recall, syncRecentSessions } from '@/api/search'
import { listRepos } from '@/api/repos'
import { Search as SearchIcon, History, GitCommit, Trash2, Copy, CornerDownLeft, X } from 'lucide-react'
import { showToast } from '@/lib/toast'
import { toggleTurn } from '@/lib/turnSelection'
import { SelectedExportButtons } from '@/components/session/SelectedExportButtons'



export function Search() {
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [submittedQ, setSubmittedQ] = useState('')
  const [selectedRepoId, setSelectedRepoId] = useState<string>('all')
  // 전체 자동로드라 k는 라운드당 페이지 크기로만 쓴다 (결과 개수 제한 아님)
  const kParam = 200
  const [kind, setKind] = useState<'all' | 'message' | 'commit'>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [expandedData, setExpandedData] = useState<MessageExpandResult | null>(null)
  const [commitDetail, setCommitDetail] = useState<CommitDetail | null>(null)
  const [detailSha, setDetailSha] = useState<string | null>(null)
  const [selectedHits, setSelectedHits] = useState<Set<string>>(new Set())
  const queryClient = useQueryClient()

  const repoIdParam = selectedRepoId === 'all' ? undefined : parseInt(selectedRepoId, 10)

  const { data: repos } = useQuery({
    queryKey: ['repos'],
    queryFn: listRepos,
  })

  const repoName = (id: number | null | undefined) => {
    if (id == null) return String(id)
    if (id === 0) return 'host (opencode-webui)'
    const r = repos?.find((x) => x.id === id)
    return r ? `${r.localPath} (#${r.id})` : `repo #${id}`
  }

  // live search debounced like RecallPanel, but also support submit
  useEffect(() => {
    const t = q.trim()
    if (!t) return
    const id = setTimeout(() => setDebouncedQ(t), 350)
    return () => clearTimeout(id)
  }, [q])

  // 최근 활성 세션을 증분 동기화한 뒤 검색을 새로고침한다.
  // 안 하면 채팅 직후 검색이 stale 인덱스를 맞아 새 내용을 놓친다.
  const syncAndRefresh = () => {
    void syncRecentSessions(25)
      .catch(() => {})
      .finally(() => {
        queryClient.invalidateQueries({ queryKey: ['recall-search'] })
      })
  }
  useEffect(() => {
    syncAndRefresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSearch = () => {
    if (!q.trim()) return
    setSubmittedQ(q.trim())
    setDebouncedQ(q.trim())
    setExpandedId(null)
    setExpandedData(null)
    setCommitDetail(null)
    setDetailSha(null)
    syncAndRefresh()
  }

  const effectiveQ = submittedQ || debouncedQ

  // 검색 화면은 일부가 아닌 전체를 보여준다 — 내부적으로 최종 페이지까지
  // 반복 로드한다. 쿼리 키가 바뀌면(signal abort) 진행 중 루프는 버려진다.
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['recall-search', effectiveQ, repoIdParam, kParam],
    queryFn: async ({ signal }) => {
      const all: RecallHit[] = []
      const seen = new Set<string>()
      let offset: number | null = 0
      for (;;) {
        const page = await recall(effectiveQ, { k: kParam, repoId: repoIdParam, offset: offset ?? 0, signal })
        let added = 0
        for (const h of page.hits) {
          const key = h.kind === 'message' ? h.messageId : `${h.repoId}:${h.sha}`
          if (!key || seen.has(key)) continue
          seen.add(key)
          all.push(h)
          added++
        }
        // 인덱스가 도는 사이 바뀌어도 0건 진전이면 멈춘다 (무한 루프 방지)
        if (page.nextOffset == null || added === 0) break
        offset = page.nextOffset
      }
      return { block: '', hits: all }
    },
    enabled: !!effectiveQ,
    // 페이지 나가면 즉시 반납 (닫힌 뒤 5분 캐시 유지 안 함). signal abort로 진행 중 루프도 중단된다.
    gcTime: 0,
  })

  const filteredHits = useMemo(() => {
    if (!data?.hits) return []
    if (kind === 'all') return data.hits
    return data.hits.filter((h: any) => h.kind === kind)
  }, [data?.hits, kind])

  // 필터 옆 클립보드/채팅 버튼은 전체 블록 — 정제: 상세보기와 동일 양식, 전후 확장 시 해당 히트는 전후 전체로
  const filteredBlock = useMemo(() => {
    if (!data?.hits) return ''
    if (filteredHits.length === 0) return ''
    const lines = ['=======', '<memory-recall>', `query: "${effectiveQ}"`]
    for (const h of filteredHits) {
      const repo = repoName(h.repoId)
      if (h.kind === 'message' && h.messageId && expandedId === h.messageId && expandedData) {
        lines.push(`- [${h.kind}] ${repo} session ${h.sessionId?.slice(0,8) ?? ''}`)
        for (const r of expandedData.rows) lines.push(`${r.role} #${r.turnIndex}\n${r.text}`)
      } else {
        lines.push(`- [${h.kind}] ${h.snippet} — ${h.meta} repo ${repo}`)
      }
    }
    lines.push('</memory-recall>')
    return lines.join('\n')
  }, [data?.hits, filteredHits, effectiveQ, repos, expandedId, expandedData])

  const filteredJson = useMemo(() => {
    if (!filteredHits.length) return ''
    const arr = filteredHits.map((h) => {
      if (h.kind === 'message' && h.messageId && expandedId === h.messageId && expandedData) {
        return { kind: h.kind, repo: repoName(h.repoId), repoId: h.repoId, sessionId: h.sessionId, messageId: h.messageId, turnIndex: h.turnIndex, role: h.role, ts: h.ts, snippet: h.snippet, expanded: expandedData.rows }
      }
      return { kind: h.kind, repo: repoName(h.repoId), repoId: h.repoId, sessionId: h.sessionId, messageId: h.messageId, turnIndex: h.turnIndex, role: h.role, ts: h.ts, snippet: h.snippet, meta: h.meta }
    })
    return JSON.stringify(arr, null, 2)
  }, [filteredHits, expandedId, expandedData, repos])

  const [blockOpen, setBlockOpen] = useState(false)
  // 범위 선택 모드: 시작 행 클릭 → 종료 행 클릭으로 사이 전체 체크
  const [rangeMode, setRangeMode] = useState(false)
  const [rangeStart, setRangeStart] = useState<string | null>(null)

  const hitKeyOf = (h: any): string =>
    h.kind === 'message' ? h.messageId : `${h.repoId}:${h.sha}`

  // 체크박스 토글: user면 다음 user 전까지 턴 단위로 묶고, assistant/커밋은 낱개.
  // 턴으로 묶인 답변은 각자 낱개로 해제할 수 있다.
  const handleCheck = (_hit: any, index: number) => {
    const ids = filteredHits.map(hitKeyOf)
    const roles = filteredHits.map((h: any) => (h.kind === 'message' ? (h.role as string | undefined) : undefined))
    setSelectedHits((prev) => toggleTurn(prev, ids, roles, index))
  }

  const handleRowClick = (hit: any) => {
    if (!rangeMode) {
      if (hit.kind === 'message' && hit.messageId) void handleExpand(hit.messageId)
      return
    }
    const key = hitKeyOf(hit)
    if (!key) return
    if (rangeStart == null) {
      setRangeStart(key)
      showToast.info('시작점 선택됨 — 종료점을 누르세요')
      return
    }
    const keys = filteredHits.map(hitKeyOf)
    const a = keys.indexOf(rangeStart)
    const b = keys.indexOf(key)
    if (a === -1 || b === -1) {
      setRangeStart(key)
      showToast.info('시작점 선택됨 — 종료점을 누르세요')
      return
    }
    const [from, to] = a <= b ? [a, b] : [b, a]
    const next = new Set(selectedHits)
    for (let i = from; i <= to; i++) {
      const k = keys[i]
      if (k) next.add(k)
    }
    setSelectedHits(next)
    setRangeStart(null)
    setRangeMode(false)
    showToast.success(`${to - from + 1}개 선택됨`)
  }



  const copyText = async (text: string, _label?: string) => {
    try {
      await navigator.clipboard.writeText(text)
      showToast.success('Copied JSON')
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      showToast.success('Copied JSON')
    }
  }
  const openChatHref = (hit: any) => {
    if (!hit.sessionId) return '#'
    const hash = hit.messageId ? `#message-${hit.messageId}` : ''
    if (hit.repoId != null && hit.repoId !== 0) return `/repos/${hit.repoId}/sessions/${hit.sessionId}${hash}`
    return `/session/${hit.sessionId}${hash}`
  }
  const highlightSnippet = (text: string) => {
    const qq = effectiveQ.trim()
    if (!qq) return text
    const tokens = qq.split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}_\-]/gu, '').trim()).filter((t) => t.length >= 1)
    if (tokens.length === 0) return text
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`(${tokens.map(esc).join('|')})`, 'gi')
    const parts = text.split(pattern)
    const lowerTokens = new Set(tokens.map((t) => t.toLowerCase()))
    return parts.map((part, i) =>
      part && lowerTokens.has(part.toLowerCase()) ? (
        <span key={i} className="bg-blue-500/20 text-blue-600 dark:text-blue-400 font-medium rounded px-0.5">{part}</span>
      ) : (
        <span key={i}>{part}</span>
      )
    )
  }

  const handleExpand = async (messageId: string) => {
    if (expandedId === messageId) {
      setExpandedId(null)
      setExpandedData(null)
      return
    }
    try {
      const d = await expandMessage(messageId, 3)
      setExpandedId(messageId)
      setExpandedData(d)
    } catch {}
  }
  const handleCommitClick = async (sha: string, repoId: number | null) => {
    if (repoId == null) return
    if (detailSha === sha) {
      setDetailSha(null)
      setCommitDetail(null)
      return
    }
    try {
      const d = await getCommitDetail(sha, repoId)
      setDetailSha(sha)
      setCommitDetail(d)
    } catch {}
  }

  const deleteMessagesMutation = useMutation({
    mutationFn: (ids: string[]) => deleteMessageIndexes(ids),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recall-search'] })
      setSelectedHits(new Set())
    },
  })
  const deleteCommitsMutation = useMutation({
    mutationFn: (commits: { sha: string; repoId: number }[]) => deleteCommitIndexes(commits),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recall-search'] })
      setSelectedHits(new Set())
    },
  })
  const handleBulkDelete = () => {
    const msgIds: string[] = []
    const commits: { sha: string; repoId: number }[] = []
    for (const key of selectedHits) {
      const hit: any = filteredHits.find((h: any) => (h.kind === 'message' ? h.messageId : `${h.repoId}:${h.sha}`) === key)
      if (!hit) continue
      if (hit.kind === 'message' && hit.messageId) msgIds.push(hit.messageId)
      else if (hit.kind === 'commit' && hit.sha && hit.repoId != null) commits.push({ sha: hit.sha, repoId: hit.repoId })
    }
    if (msgIds.length) deleteMessagesMutation.mutate(msgIds)
    if (commits.length) deleteCommitsMutation.mutate(commits)
  }

  const allSelected = filteredHits.length > 0 && selectedHits.size === filteredHits.length

  return (
    <div className="h-dvh flex flex-col bg-gradient-to-br from-background via-background to-background overflow-hidden">
      <Header title="Search" backTo="/" />
      <div className="flex-1 overflow-y-auto">
        <div className="container mx-auto p-4 max-w-4xl space-y-3">
          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              placeholder="messages & commits search ( min length 2 char, * is supported )"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSearch() }}
              className="pl-8 h-8 text-xs"
            />
          </div>
          <div className="flex items-center gap-2 relative w-full py-0.5">
            <div className="flex-1 min-w-0">
              <Select value={selectedRepoId} onValueChange={setSelectedRepoId}>
                <SelectTrigger className="w-full h-7 text-xs min-w-0 [&>span]:truncate">
                  <SelectValue placeholder="Select repo" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Repositories</SelectItem>
                  <SelectItem value="0">host (opencode-webui)</SelectItem>
                  {repos?.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)}>
                      {r.localPath} (#{r.id})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={handleSearch} disabled={!q.trim()} size="sm" className="h-7 text-xs shrink-0">
              Search
            </Button>
          </div>

          <div className="flex items-center gap-2 relative w-full py-0.5">
            <div className="inline-flex items-center gap-1 rounded-md border border-input bg-background shrink-0 h-7 px-1">
              <button
                onClick={() => filteredBlock && setBlockOpen((v) => !v)}
                disabled={!filteredBlock}
                className={`inline-flex items-center gap-1 text-xs h-6 px-2 rounded shrink-0 ${blockOpen ? 'bg-primary/10 text-primary' : 'hover:bg-muted'} disabled:opacity-40 disabled:cursor-not-allowed`}
                title={filteredBlock ? 'Recalls overlay' : 'No recalls to show'}
              >
                <ChevronRight className={`w-3 h-3 transition-transform ${blockOpen ? 'rotate-90' : ''}`} />
                Recalls
              </button>
              <div className="inline-flex items-center rounded overflow-hidden border border-input shrink-0">
                <button
                  onClick={() => copyText(filteredJson || filteredBlock, 'Recalls copied (JSON)')}
                  disabled={!filteredJson}
                  className="inline-flex items-center gap-0.5 text-xs h-5 px-1.5 rounded-none border-r border-input shrink-0 hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Copy Recalls JSON"
                >
                  <Copy className="w-2.5 h-2.5" /> <span className="text-[10px]">Copy</span>
                </button>
              </div>
            </div>

              {blockOpen && filteredJson && (
                <div className="absolute top-full mt-1 left-0 right-0 z-50 rounded-md border bg-background shadow-xl min-w-[500px] max-w-[800px]">
                  <div className="flex items-center justify-between px-2.5 py-1.5 border-b gap-2">
                    <span className="text-[11px] font-medium shrink-0">Recalls JSON {kind !== 'all' ? `(${kind})` : ''}</span>
                    <button onClick={() => setBlockOpen(false)} className="text-muted-foreground hover:text-foreground p-0.5 shrink-0">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <pre className="text-[11px] whitespace-pre-wrap break-words font-mono p-2.5 max-h-64 overflow-y-auto">
                    {filteredJson}
                  </pre>
                </div>
              )}
          </div>

          <Tabs value={kind} onValueChange={(v) => setKind(v as any)} className="shrink-0">
            <TabsList className="h-7 shrink-0 flex-nowrap">
              <TabsTrigger value="all" className="text-xs h-6 px-2 shrink-0 whitespace-nowrap">All</TabsTrigger>
              <TabsTrigger value="message" className="text-xs h-6 px-1.5 gap-1 shrink-0 whitespace-nowrap"><History className="w-3 h-3" /> Chat</TabsTrigger>
              <TabsTrigger value="commit" className="text-xs h-6 px-1.5 gap-1 shrink-0 whitespace-nowrap"><GitCommit className="w-3 h-3" /> Git</TabsTrigger>
            </TabsList>
          </Tabs>

          {!effectiveQ ? (
            <p className="text-sm text-muted-foreground py-8 text-center">Search related memories in messages and commits. Indexed automatically when idle.</p>
          ) : isLoading ? (
            <p className="text-sm text-muted-foreground">Searching...</p>
          ) : isError ? (
            <p className="text-sm text-destructive">Search failed: {(error as Error).message}</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Checkbox checked={allSelected} onCheckedChange={(v) => {
                  if (v) setSelectedHits(new Set(filteredHits.map((h: any) => h.kind === 'message' ? h.messageId : `${h.repoId}:${h.sha}`)))
                  else setSelectedHits(new Set())
                }} />
                <span className="text-xs text-muted-foreground">Select all</span>
                <Button
                  variant={rangeMode ? 'default' : 'outline'} size="sm" className="h-7 text-xs"
                  title={rangeMode ? (rangeStart ? '종료점을 누르세요 (취소: 다시 클릭)' : '시작점을 누르세요 (취소: 다시 클릭)') : '범위 선택: 시작 행 → 종료 행'}
                  onClick={() => { setRangeMode((v) => !v); setRangeStart(null) }}
                >
                  범위 선택{rangeMode ? (rangeStart ? ' (종료점…)' : ' (시작점…)') : ''}
                </Button>
                {selectedHits.size > 0 && (
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelectedHits(new Set())}>
                    선택 해제
                  </Button>
                )}
                {(() => {
                  // 선택 출력은 메시지 전용 — 커밋 키(${repoId}:${sha})를 그대로 넘기면
                  // 메시지 조회가 빗나가 "불러온 메시지가 없어요"가 된다.
                  const msgIds = filteredHits
                    .filter((h: any) => h.kind === 'message' && selectedHits.has(hitKeyOf(h)))
                    .map((h: any) => h.messageId)
                    .filter(Boolean)
                  const excludedCommits = filteredHits.filter(
                    (h: any) => h.kind !== 'message' && selectedHits.has(hitKeyOf(h)),
                  ).length
                  return (
                    <>
                      {excludedCommits > 0 && (
                        <span className="text-[11px] text-muted-foreground" title="커밋은 메시지 출력에 포함되지 않습니다">
                          커밋 {excludedCommits}개 제외
                        </span>
                      )}
                      <SelectedExportButtons
                        ids={msgIds}
                        title={`선택 출력 ${msgIds.length}개`}
                      />
                    </>
                  )
                })()}
                <Button variant="destructive" size="sm" disabled={selectedHits.size === 0 || deleteMessagesMutation.isPending || deleteCommitsMutation.isPending} onClick={handleBulkDelete} className="ml-auto gap-1">
                  <Trash2 className="w-3.5 h-3.5" /> Delete index ({selectedHits.size})
                </Button>
              </div>
              {filteredHits.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">No results</p>
              ) : (
              <div className="space-y-2">
                {filteredHits.map((hit: any, i: number) => {
                  const key = hit.kind === 'message' ? hit.messageId : `${hit.repoId}:${hit.sha}`
                  const isMessage = hit.kind === 'message'
                  const isRangeStart = rangeMode && rangeStart != null && rangeStart === key
                  return (
                    <div key={key || i} onClick={() => handleRowClick(hit)} className={`rounded-md border p-2.5 space-y-1.5 cursor-pointer hover:border-primary/30 ${isRangeStart ? 'border-primary ring-1 ring-primary/40 bg-primary/5' : 'border-input bg-background'}`}>
                      <div className="flex items-center gap-0 flex-nowrap overflow-hidden rounded-md bg-muted/20">
                        <Checkbox checked={selectedHits.has(key)} onCheckedChange={() => handleCheck(hit, i)} onClick={(e) => e.stopPropagation()} className="ml-1.5 mr-1 h-3.5 w-3.5" />
                        <span className={`px-1.5 py-1 text-[10px] ${isMessage ? 'bg-blue-500/15 text-blue-400' : 'bg-amber-500/15 text-amber-400'} shrink-0`}>{isMessage ? 'chat' : 'git'}</span>
                        {hit.ts && <span className="px-1.5 py-1 text-[10px] bg-muted/30 whitespace-nowrap shrink-0">{new Date(hit.ts).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
                        {hit.repoId != null && <span className="px-1.5 py-1 text-[10px] bg-muted/40 truncate max-w-[110px] shrink-0" title={repoName(hit.repoId)}>{repoName(hit.repoId)}</span>}
                        {hit.sessionId && <span className="px-1.5 py-1 text-[10px] bg-muted/30 truncate max-w-[90px] shrink-0" title={hit.sessionId}>session {hit.sessionId.slice(0,8)}</span>}
                        {!isMessage && hit.sha && <code className="px-1.5 py-1 text-[10px] bg-muted/40 shrink-0">{hit.sha.slice(0,7)}</code>}
                        <span className="flex-1 min-w-0" />
                        <button onClick={(e) => { e.stopPropagation(); copyText(JSON.stringify(hit, null, 2)) }} className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-1 h-5 shrink-0 hover:bg-muted" title="Copy JSON"><Copy className="w-2.5 h-2.5" /> Copy</button>
                        {isMessage && hit.sessionId && <a href={openChatHref(hit)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-1 h-5 shrink-0 hover:bg-muted text-primary underline" title="open chat (new tab)"><CornerDownLeft className="w-2.5 h-2.5" /> open chat</a>}
                      </div>
                      {isMessage ? (
                        expandedId === hit.messageId && expandedData ? (
                          <div className="space-y-1.5">
                            {expandedData.rows.map((row) => {
                              const isCenter = row.messageId === expandedData.center.messageId
                              return (
                                <div key={row.messageId} className={`p-2 rounded text-xs relative ${isCenter ? 'bg-accent border border-input' : 'bg-muted/30'}`}>
                                  <div className="flex gap-2 text-[10px] text-muted-foreground mb-1 pr-20">
                                    <span>{row.role}</span>
                                    <span>#{row.turnIndex}</span>
                                  </div>
                                  {isCenter && <a href={openChatHref(hit)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="absolute top-1.5 right-1.5 inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-background/90 backdrop-blur border border-input shadow-sm hover:bg-muted text-primary underline"><CornerDownLeft className="w-2.5 h-2.5" /> open chat</a>}
                                  <div className="whitespace-pre-wrap break-words">{row.text ? highlightSnippet(row.text) : '(empty)'}</div>
                                </div>
                              )
                            })}
                          </div>
                        ) : (
                          <div className="p-2 rounded text-xs bg-accent border border-input">
                            <div className="flex gap-2 text-[10px] text-muted-foreground mb-1"><span>{hit.role ?? hit.kind}</span><span>#{hit.turnIndex ?? ''}</span></div>
                            <div className="whitespace-pre-wrap break-words">{highlightSnippet(hit.snippet)}</div>
                          </div>
                        )
                      ) : (
                        <>
                          <div className="p-2 rounded text-xs bg-accent border border-input font-medium">{highlightSnippet(hit.snippet)}</div>
                          <div className="flex gap-2">
                            <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleCommitClick(hit.sha, hit.repoId) }}>{detailSha === hit.sha ? 'Collapse' : 'View detail'}</Button>
                          </div>
                          {detailSha === hit.sha && commitDetail && (
                            <div className="border-t pt-3 space-y-2 mt-2 text-sm">
                              {commitDetail.body && <pre className="whitespace-pre-wrap break-words bg-muted/40 p-2 rounded text-xs">{commitDetail.body}</pre>}
                              {commitDetail.files.length > 0 && (
                                <div>
                                  <div className="text-xs text-muted-foreground mb-1">files ({commitDetail.files.length})</div>
                                  <ul className="text-xs space-y-0.5 list-disc list-inside">
                                    {commitDetail.files.map((f: string) => <li key={f} className="break-all">{f}</li>)}
                                  </ul>
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
