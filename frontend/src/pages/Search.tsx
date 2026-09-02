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
} from '@/api/search'
import { recall } from '@/api/search'
import { listRepos } from '@/api/repos'
import { Search as SearchIcon, History, GitCommit, Trash2, Copy, CornerDownLeft, X } from 'lucide-react'
import { showToast } from '@/lib/toast'



export function Search() {
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [submittedQ, setSubmittedQ] = useState('')
  const [selectedRepoId, setSelectedRepoId] = useState<string>('all')
  const [k, setK] = useState('20')
  const kParam = Math.min(50, Math.max(1, parseInt(k, 10) || 5))
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

  const handleSearch = () => {
    if (!q.trim()) return
    setSubmittedQ(q.trim())
    setDebouncedQ(q.trim())
    setExpandedId(null)
    setExpandedData(null)
    setCommitDetail(null)
    setDetailSha(null)
  }

  const effectiveQ = submittedQ || debouncedQ

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['recall-search', effectiveQ, repoIdParam, kParam],
    queryFn: () => recall(effectiveQ, { k: kParam, repoId: repoIdParam }),
    enabled: !!effectiveQ,
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
            <div className="w-[68px] shrink-0">
              <Select value={k} onValueChange={setK}>
                <SelectTrigger className="w-full h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="5">5 hits</SelectItem>
                  <SelectItem value="8">8 hits</SelectItem>
                  <SelectItem value="10">10 hits</SelectItem>
                  <SelectItem value="20">20 hits</SelectItem>
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
                <div className="flex items-center justify-between px-2.5 py-1.5 border-b">
                  <span className="text-[11px] font-medium">Recalls JSON {kind !== 'all' ? `(${kind})` : ''}</span>
                  <button onClick={() => setBlockOpen(false)} className="text-muted-foreground hover:text-foreground p-0.5">
                    <X className="w-3.5 h-3.5" />
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
          ) : filteredHits.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No results</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Checkbox checked={allSelected} onCheckedChange={(v) => {
                  if (v) setSelectedHits(new Set(filteredHits.map((h: any) => h.kind === 'message' ? h.messageId : `${h.repoId}:${h.sha}`)))
                  else setSelectedHits(new Set())
                }} />
                <span className="text-xs text-muted-foreground">Select all</span>
                <Button variant="destructive" size="sm" disabled={selectedHits.size === 0 || deleteMessagesMutation.isPending || deleteCommitsMutation.isPending} onClick={handleBulkDelete} className="ml-auto gap-1">
                  <Trash2 className="w-3.5 h-3.5" /> Delete index ({selectedHits.size})
                </Button>
              </div>
              <div className="space-y-2">
                {filteredHits.map((hit: any, i: number) => {
                  const key = hit.kind === 'message' ? hit.messageId : `${hit.repoId}:${hit.sha}`
                  const isMessage = hit.kind === 'message'
                  return (
                    <div key={key || i} onClick={() => isMessage && hit.messageId && handleExpand(hit.messageId)} className="rounded-md border border-input bg-background p-2.5 space-y-1.5 cursor-pointer hover:border-primary/30">
                      <div className="flex items-center gap-0 flex-nowrap overflow-hidden rounded-md bg-muted/20">
                        <Checkbox checked={selectedHits.has(key)} onCheckedChange={(v) => {
                          const next = new Set(selectedHits)
                          if (v) next.add(key); else next.delete(key)
                          setSelectedHits(next)
                        }} onClick={(e) => e.stopPropagation()} className="ml-1.5 mr-1 h-3.5 w-3.5" />
                        <span className={`px-1.5 py-1 text-[10px] ${isMessage ? 'bg-blue-500/15 text-blue-400' : 'bg-amber-500/15 text-amber-400'} shrink-0`}>{isMessage ? 'chat' : 'git'}</span>
                        {hit.ts && <span className="px-1.5 py-1 text-[10px] bg-muted/30 whitespace-nowrap shrink-0">{new Date(hit.ts).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
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
            </>
          )}
        </div>
      </div>
    </div>
  )
}
