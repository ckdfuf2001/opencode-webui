import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Header } from '@/components/layout/Header'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  searchMessages,
  expandMessage,
  searchCommits,
  getCommitDetail,
  type MessageExpandResult,
  type CommitDetail,
} from '@/api/search'
import { listRepos } from '@/api/repos'
import { Search as SearchIcon, History, GitCommit, ExternalLink } from 'lucide-react'

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
    queryKey: ['search-messages', submittedQ, activeTab, selectedRepoId],
    queryFn: () => searchMessages({ q: submittedQ, k: 20, repoId: repoIdParam }),
    enabled: !!submittedQ && activeTab === 'messages',
  })

  const commitsQuery = useQuery({
    queryKey: ['search-commits', submittedQ, activeTab, selectedRepoId],
    queryFn: () => searchCommits({ q: submittedQ, k: 20, repoId: repoIdParam }),
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

  return (
    <div className="h-dvh flex flex-col bg-gradient-to-br from-background via-background to-background overflow-hidden">
      <Header title="Search" backTo="/" />
      <div className="flex-1 overflow-y-auto">
        <div className="container mx-auto p-4 max-w-4xl space-y-4">
          <div className="flex gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="검색어 (한글 부분일치 지원, trigram) — 엔터로 검색"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSearch()
                }}
                className="pl-9"
              />
            </div>
            <Select value={selectedRepoId} onValueChange={setSelectedRepoId}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="레포 선택" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체 레포</SelectItem>
                <SelectItem value="0">host (opencode-webui)</SelectItem>
                {repos?.map((r) => (
                  <SelectItem key={r.id} value={String(r.id)}>
                    {r.localPath} (#{r.id})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={handleSearch} disabled={!trimmed}>
              Search
            </Button>
          </div>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'messages' | 'commits')}>
          <TabsList>
            <TabsTrigger value="messages" className="gap-1.5">
              <History className="w-4 h-4" /> Messages
            </TabsTrigger>
            <TabsTrigger value="commits" className="gap-1.5">
              <GitCommit className="w-4 h-4" /> Commits
            </TabsTrigger>
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
              messagesQuery.data!.map((hit) => (
                <Card key={hit.messageId} className="p-4 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline">{hit.role}</Badge>
                    <Badge variant="secondary">turn {hit.turnIndex}</Badge>
                    <Badge variant="secondary" title={hit.repoId == null ? 'unknown (재색인 필요)' : repoName(hit.repoId)}>{hit.repoId == null ? 'unknown' : repoName(hit.repoId)}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {new Date(hit.ts).toLocaleString()}
                    </span>
                    {hit.sessionId && (
                      <Link
                        to={
                          hit.repoId != null && hit.repoId !== 0
                            ? `/repos/${hit.repoId}/sessions/${hit.sessionId}`
                            : `/session/${hit.sessionId}`
                        }
                        className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1 ml-auto"
                      >
                        세션 열기 <ExternalLink className="w-3 h-3" />
                      </Link>
                    )}
                  </div>
                  <div className="text-sm break-words">
                    <Snippet text={hit.snippet} />
                  </div>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={() => handleExpand(hit.messageId)}>
                      {expandedId === hit.messageId ? '접기' : '주변 대화 보기'}
                    </Button>
                  </div>
                  {expandedId === hit.messageId && expandedData && (
                    <div className="border-t pt-3 space-y-2 mt-2">
                      {expandedData.rows.map((row) => (
                        <div
                          key={row.messageId}
                          className={`p-2 rounded text-sm ${
                            row.messageId === expandedData.center.messageId
                              ? 'bg-accent border border-border'
                              : 'bg-muted/40'
                          }`}
                        >
                          <div className="flex gap-2 text-xs text-muted-foreground mb-1">
                            <span>{row.role}</span>
                            <span>#{row.turnIndex}</span>
                          </div>
                          <div className="whitespace-pre-wrap break-words text-sm">{row.text || '(empty)'}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              ))
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
              commitsQuery.data!.map((hit) => (
                <Card key={`${hit.repoId}-${hit.sha}`} className="p-4 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{hit.sha.slice(0, 7)}</code>
                    {hit.repoId != null && <Badge variant="secondary" title={repoName(hit.repoId)}>{repoName(hit.repoId)}</Badge>}
                    <span className="text-xs text-muted-foreground">{hit.author}</span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(hit.committedAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="font-medium text-sm">{hit.subject}</div>
                  {hit.repoId != null && (
                    <Button variant="ghost" size="sm" onClick={() => handleCommitClick(hit.sha, hit.repoId)}>
                      {detailSha === hit.sha ? '접기' : '상세 보기'}
                    </Button>
                  )}
                  {detailSha === hit.sha && commitDetail && (
                    <div className="border-t pt-3 space-y-2 mt-2 text-sm">
                      {commitDetail.body && (
                        <pre className="whitespace-pre-wrap break-words bg-muted/40 p-2 rounded text-xs">
                          {commitDetail.body}
                        </pre>
                      )}
                      {commitDetail.files.length > 0 && (
                        <div>
                          <div className="text-xs text-muted-foreground mb-1">
                            files ({commitDetail.files.length})
                          </div>
                          <ul className="text-xs space-y-0.5 list-disc list-inside">
                            {commitDetail.files.map((f) => (
                              <li key={f} className="break-all">
                                {f}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              ))
            )}
          </TabsContent>
        </Tabs>
        </div>
      </div>
    </div>
  )
}
