import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Header } from '@/components/layout/Header'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import {
  searchMessages,
  expandMessage,
  searchCommits,
  getCommitDetail,
  deleteMessageIndexes,
  deleteCommitIndexes,
  type MessageExpandResult,
  type CommitDetail,
} from '@/api/search'
import { listRepos } from '@/api/repos'
import { Search as SearchIcon, History, GitCommit, Trash2, Copy, MessageSquarePlus, CornerDownLeft } from 'lucide-react'
import { showToast } from '@/lib/toast'

function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[.*?\])/g)
  return (
    <span className="text-sm leading-relaxed">
      {parts.map((p, i) =>
        p.startsWith('[') && p.endsWith(']') ? (
          <mark key={i} className="bg-yellow-200 dark:bg-yellow-800 rounded px-0.5">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  )
}

export function Search() {
  const [q, setQ] = useState('')
  const [activeTab, setActiveTab] = useState<'messages' | 'commits'>('messages')
  const [submittedQ, setSubmittedQ] = useState('')
  const [selectedRepoId, setSelectedRepoId] = useState<string>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [expandedData, setExpandedData] = useState<MessageExpandResult | null>(null)
  const [commitDetail, setCommitDetail] = useState<CommitDetail | null>(null)
  const [detailSha, setDetailSha] = useState<string | null>(null)
  const [k, setK] = useState('20')
  const kParam = parseInt(k, 10)
  const [selectedMessages, setSelectedMessages] = useState<Set<string>>(new Set())
  const [selectedCommits, setSelectedCommits] = useState<Set<string>>(new Set())
  const queryClient = useQueryClient()

  const trimmed = q.trim()
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

  const messagesQuery = useQuery({
    queryKey: ['search-messages', submittedQ, activeTab, selectedRepoId, kParam],
    queryFn: () => searchMessages({ q: submittedQ, k: kParam, repoId: repoIdParam }),
    enabled: !!submittedQ && activeTab === 'messages',
  })

  const commitsQuery = useQuery({
    queryKey: ['search-commits', submittedQ, activeTab, selectedRepoId, kParam],
    queryFn: () => searchCommits({ q: submittedQ, k: kParam, repoId: repoIdParam }),
    enabled: !!submittedQ && activeTab === 'commits',
  })

  const handleSearch = () => {
    if (!trimmed) return
    setSubmittedQ(trimmed)
    setExpandedId(null)
    setExpandedData(null)
    setCommitDetail(null)
    setDetailSha(null)
  }

  const handleExpand = async (messageId: string) => {
    if (expandedId === messageId) {
      setExpandedId(null)
      setExpandedData(null)
      return
    }
    try {
      const data = await expandMessage(messageId, 3)
      setExpandedId(messageId)
      setExpandedData(data)
    } catch {
      // ignore
    }
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
    } catch {
      // ignore
    }
  }

  const deleteMessagesMutation = useMutation({
    mutationFn: (ids: string[]) => deleteMessageIndexes(ids),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['search-messages'] })
      setSelectedMessages(new Set())
    },
  })
  const deleteCommitsMutation = useMutation({
    mutationFn: (commits: { sha: string; repoId: number }[]) => deleteCommitIndexes(commits),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['search-commits'] })
      setSelectedCommits(new Set())
    },
  })

  const copyText = async (text: string) => {
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
  const openChatHref = (hit: { repoId: number | null; sessionId?: string; messageId?: string }) => {
    if (!hit.sessionId) return '#'
    const hash = hit.messageId ? `#message-${hit.messageId}` : ''
    if (hit.repoId != null && hit.repoId !== 0) return `/repos/${hit.repoId}/sessions/${hit.sessionId}${hash}`
    return `/session/${hit.sessionId}${hash}`
  }
  const highlightSnippet = (text: string) => {
    const qq = submittedQ.trim()
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

  return (
    <div className="h-dvh flex flex-col bg-gradient-to-br from-background via-background to-background overflow-hidden">
      <Header title="Search" backTo="/" />
      <div className="flex-1 overflow-y-auto">
        <div className="container mx-auto p-4 max-w-4xl space-y-3">
          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              placeholder="검색어 (한글 부분일치 지원, trigram) — 엔터로 검색"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearch()
              }}
              className="pl-8 h-8 text-xs"
            />
          </div>
          <div className="flex items-center gap-2 relative w-full py-0.5">
            <div className="flex-1 min-w-0">
              <Select value={selectedRepoId} onValueChange={setSelectedRepoId}>
                <SelectTrigger className="w-full h-7 text-xs min-w-0 [&>span]:truncate">
                  <SelectValue placeholder="레포 선택" />
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
            <Button onClick={handleSearch} disabled={!trimmed} size="sm" className="h-7 text-xs shrink-0">
              Search
            </Button>
          </div>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'messages' | 'commits')}>
          <TabsList className="h-7 shrink-0 flex-nowrap">
            <TabsTrigger value="messages" className="text-xs h-6 px-2 shrink-0 whitespace-nowrap gap-1"><History className="w-3 h-3" /> Messages</TabsTrigger>
            <TabsTrigger value="commits" className="text-xs h-6 px-1.5 gap-1 shrink-0 whitespace-nowrap"><GitCommit className="w-3 h-3" /> Commits</TabsTrigger>
          </TabsList>

          <TabsContent value="messages" className="space-y-3 mt-4">
            {!submittedQ ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                전체 대화(세션 메시지)를 검색합니다. idle 시점에 자동 인덱싱됩니다.
              </p>
            ) : messagesQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">검색 중…</p>
            ) : messagesQuery.isError ? (
              <p className="text-sm text-destructive">검색 실패: {(messagesQuery.error as Error).message}</p>
            ) : (messagesQuery.data?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">결과 없음</p>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={selectedMessages.size > 0 && selectedMessages.size === messagesQuery.data!.length}
                    onCheckedChange={(v) => {
                      if (v) setSelectedMessages(new Set(messagesQuery.data!.map((h) => h.messageId)))
                      else setSelectedMessages(new Set())
                    }}
                  />
                  <span className="text-xs text-muted-foreground">전체 선택</span>
                  <Button variant="destructive" size="sm" disabled={selectedMessages.size === 0 || deleteMessagesMutation.isPending} onClick={() => deleteMessagesMutation.mutate(Array.from(selectedMessages))} className="ml-auto gap-1">
                    <Trash2 className="w-3.5 h-3.5" /> 인덱스 삭제 ({selectedMessages.size})
                  </Button>
                </div>
                {messagesQuery.data!.map((hit) => (
                <Card key={hit.messageId} className="p-2.5 space-y-1.5 border border-input cursor-pointer hover:border-primary/30" onClick={() => handleExpand(hit.messageId)}>
                  <div className="flex items-center gap-0 flex-nowrap overflow-hidden rounded-md bg-muted/20">
                    <Checkbox checked={selectedMessages.has(hit.messageId)} onCheckedChange={(v) => {
                      const next = new Set(selectedMessages)
                      if (v) next.add(hit.messageId); else next.delete(hit.messageId)
                      setSelectedMessages(next)
                    }} onClick={(e) => e.stopPropagation()} className="ml-1.5 mr-1 h-3.5 w-3.5" />
                    <span className="px-1.5 py-1 text-[10px] bg-blue-500/15 text-blue-400 shrink-0">chat</span>
                    <span className="px-1.5 py-1 text-[10px] bg-muted/30 whitespace-nowrap shrink-0">{new Date(hit.ts).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                    <span className="px-1.5 py-1 text-[10px] bg-muted/40 truncate max-w-[110px] shrink-0" title={repoName(hit.repoId)}>{repoName(hit.repoId)}</span>
                    {hit.sessionId && <span className="px-1.5 py-1 text-[10px] bg-muted/30 truncate max-w-[90px] shrink-0" title={hit.sessionId}>session {hit.sessionId.slice(0,8)}</span>}
                    <span className="flex-1 min-w-0" />
                    <button onClick={(e) => { e.stopPropagation(); copyText(JSON.stringify(hit, null, 2)) }} className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-1 h-5 shrink-0 hover:bg-muted" title="Copy JSON"><Copy className="w-2.5 h-2.5" /> Copy</button>
                    <a href={openChatHref(hit)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-1 h-5 shrink-0 hover:bg-muted text-primary underline" title="open chat (new tab, Ctrl+click)"><CornerDownLeft className="w-2.5 h-2.5" /> open chat</a>
                  </div>
                  <div className="p-2 rounded text-xs bg-accent border border-input">
                    <div className="flex gap-2 text-[10px] text-muted-foreground mb-1"><span>{hit.role}</span><span>#{hit.turnIndex}</span></div>
                    <div className="whitespace-pre-wrap break-words">{highlightSnippet(hit.snippet)}</div>
                  </div>
                  {expandedId === hit.messageId && expandedData && (
                    <div className="border-t pt-3 space-y-2 mt-2">
                      <pre className="whitespace-pre-wrap break-words bg-muted/40 p-2 rounded text-xs font-mono">
                        {JSON.stringify(expandedData, null, 2)}
                      </pre>
                    </div>
                  )}
                </Card>
              ))}
              </>
            )}
          </TabsContent>

          <TabsContent value="commits" className="space-y-3 mt-4">
            {!submittedQ ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                git 커밋(subject/body/파일명)을 검색합니다. 5분마다 자동 인덱싱됩니다.
              </p>
            ) : commitsQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">검색 중…</p>
            ) : commitsQuery.isError ? (
              <p className="text-sm text-destructive">검색 실패: {(commitsQuery.error as Error).message}</p>
            ) : (commitsQuery.data?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">결과 없음</p>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={selectedCommits.size > 0 && selectedCommits.size === commitsQuery.data!.length}
                    onCheckedChange={(v) => {
                      if (v) setSelectedCommits(new Set(commitsQuery.data!.map((h) => `${h.repoId}:${h.sha}`)))
                      else setSelectedCommits(new Set())
                    }}
                  />
                  <span className="text-xs text-muted-foreground">전체 선택</span>
                  <Button variant="destructive" size="sm" disabled={selectedCommits.size === 0 || deleteCommitsMutation.isPending} onClick={() => {
                    const commits = Array.from(selectedCommits).map((k) => {
                      const [repoId, sha] = k.split(':')
                      return { repoId: parseInt(repoId, 10), sha }
                    }).filter((c) => !Number.isNaN(c.repoId) && c.sha)
                    deleteCommitsMutation.mutate(commits)
                  }} className="ml-auto gap-1">
                    <Trash2 className="w-3.5 h-3.5" /> 인덱스 삭제 ({selectedCommits.size})
                  </Button>
                </div>
                {commitsQuery.data!.map((hit) => (
                <Card key={`${hit.repoId}-${hit.sha}`} className="p-2.5 space-y-1.5 border border-input">
                  <div className="flex items-center gap-0 flex-nowrap overflow-hidden rounded-md bg-muted/20">
                    <Checkbox checked={selectedCommits.has(`${hit.repoId}:${hit.sha}`)} onCheckedChange={(v) => {
                      const next = new Set(selectedCommits)
                      const key = `${hit.repoId}:${hit.sha}`
                      if (v) next.add(key); else next.delete(key)
                      setSelectedCommits(next)
                    }} onClick={(e) => e.stopPropagation()} className="ml-1.5 mr-1 h-3.5 w-3.5" />
                    <span className="px-1.5 py-1 text-[10px] bg-amber-500/15 text-amber-400 shrink-0">git</span>
                    <span className="px-1.5 py-1 text-[10px] bg-muted/30 whitespace-nowrap shrink-0">{new Date(hit.committedAt).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                    {hit.repoId != null && <span className="px-1.5 py-1 text-[10px] bg-muted/40 truncate max-w-[110px] shrink-0" title={repoName(hit.repoId)}>{repoName(hit.repoId)}</span>}
                    <span className="px-1.5 py-1 text-[10px] bg-muted/30 whitespace-nowrap shrink-0">{hit.author}</span>
                    <code className="px-1.5 py-1 text-[10px] bg-muted/40 shrink-0">{hit.sha.slice(0, 7)}</code>
                    <span className="flex-1 min-w-0" />
                    <button onClick={(e) => { e.stopPropagation(); copyText(JSON.stringify(hit, null, 2)) }} className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-1 h-5 shrink-0 hover:bg-muted" title="Copy JSON"><Copy className="w-2.5 h-2.5" /> Copy</button>
                  </div>
                  <div className="p-2 rounded text-xs bg-accent border border-input font-medium">{highlightSnippet(hit.subject)}</div>
                  {hit.repoId != null && (
                    <Button variant="ghost" size="sm" onClick={() => handleCommitClick(hit.sha, hit.repoId)}>
                      {detailSha === hit.sha ? '접기' : '상세 보기'}
                    </Button>
                  )}
                  {detailSha === hit.sha && commitDetail && (
                    <div className="border-t pt-3 space-y-2 mt-2 text-sm">
                      <pre className="whitespace-pre-wrap break-words bg-muted/40 p-2 rounded text-xs font-mono">
                        {JSON.stringify(commitDetail, null, 2)}
                      </pre>
                    </div>
                  )}
                </Card>
              ))}
              </>
            )}
          </TabsContent>
        </Tabs>
        </div>
      </div>
    </div>
  )
}
