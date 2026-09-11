import { useState, useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listRepos } from '@/api/repos'
import { useSessions, useSessionStatusMap } from '@/hooks/useOpenCode'
import { OPENCODE_API_ENDPOINT } from '@/config'
import { FolderGit2, MessageSquare, Plus, ChevronDown, ChevronRight, Loader2, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface NavigationTreeProps {
  onNavigate?: () => void
  onNewRepo?: () => void
}

export function NavigationTree({ onNavigate, onNewRepo }: NavigationTreeProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const [expandedRepos, setExpandedRepos] = useState<Set<number>>(() => {
    const m = location.pathname.match(/\/repos\/(\d+)/)
    return m ? new Set([parseInt(m[1], 10)]) : new Set()
  })

  const { data: repos, isLoading: reposLoading } = useQuery({ queryKey: ['repos'], queryFn: listRepos })
  const { data: dbStatuses } = useSessionStatusMap()

  const toggleRepo = (repoId: number) => {
    setExpandedRepos(prev => {
      const next = new Set(prev)
      if (next.has(repoId)) next.delete(repoId)
      else next.add(repoId)
      return next
    })
  }

  // Auto-expand current repo when location changes
  useEffect(() => {
    const m = location.pathname.match(/\/repos\/(\d+)/)
    if (m) {
      const id = parseInt(m[1], 10)
      if (!expandedRepos.has(id)) {
        setExpandedRepos(prev => new Set([...prev, id]))
      }
    }
  }, [location.pathname])

  const isRepoActive = (repoId: number) => location.pathname === `/repos/${repoId}` || location.pathname.startsWith(`/repos/${repoId}/`)

  const getWorkingCount = (repoId: number) => {
    if (!dbStatuses || !repos) return 0
    const repo = repos.find(r => r.id === repoId)
    if (!repo) return 0
    return dbStatuses.filter(s => s.status === 'busy' && (s.repoId === repoId || s.directory === repo.fullPath)).length
  }

  const getPendingCount = (repoId: number) => {
    if (!dbStatuses || !repos) return 0
    const repo = repos.find(r => r.id === repoId)
    if (!repo) return 0
    return dbStatuses.filter(s => s.repoId === repoId || s.directory === repo.fullPath).reduce((acc, s) => acc + (s.pendingPermissions ?? 0), 0)
  }

  const handleNewSession = async (repoId: number, directory?: string) => {
    try {
      const { createOpenCodeClient } = await import('@/api/opencode')
      const client = createOpenCodeClient(OPENCODE_API_ENDPOINT, directory)
      await client.createSession({})
      queryClient.invalidateQueries({ queryKey: ['opencode', 'sessions', OPENCODE_API_ENDPOINT, directory] })
      // Just attach to tree — do not navigate
      setExpandedRepos(prev => new Set([...prev, repoId]))
    } catch {}
  }

  return (
    <div className="flex flex-col gap-1 py-2">
      {/* Repo List Header */}
      <div className="flex items-center gap-1 px-2">
        <a
          href="/"
          onClick={(e) => {
            if (e.ctrlKey || e.metaKey) return
            e.preventDefault()
            navigate('/')
            onNavigate?.()
          }}
          className="flex-1 flex items-center gap-2 px-2 py-1 text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-accent rounded"
        >
          <FolderGit2 className="w-3 h-3" />
          repositories
        </a>
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => onNewRepo?.()} title="새 레포">
          <Plus className="w-3 h-3" />
        </Button>
      </div>

      {/* Repos */}
      <div className="flex flex-col gap-0.5">
        {repos?.map(repo => {
          const repoName = repo.repoUrl ? repo.repoUrl.split('/').pop()?.replace('.git','') || repo.localPath : repo.localPath
          const isActive = isRepoActive(repo.id)
          const isExpanded = expandedRepos.has(repo.id)
          const working = getWorkingCount(repo.id)
          const pending = getPendingCount(repo.id)
          return (
            <div key={repo.id} className="flex flex-col">
              <div className="flex items-center gap-1 px-2">
                <button
                  onClick={() => toggleRepo(repo.id)}
                  className="h-6 w-6 flex items-center justify-center hover:bg-accent rounded shrink-0"
                >
                  {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                </button>
                <a
                  href={`/repos/${repo.id}`}
                  onClick={(e) => {
                    if (e.ctrlKey || e.metaKey) return
                    e.preventDefault()
                    navigate(`/repos/${repo.id}`)
                    onNavigate?.()
                  }}
                  className={`flex-1 flex items-center gap-2 px-1 py-1 rounded text-sm truncate hover:bg-accent text-left ${isActive ? 'bg-accent text-accent-foreground' : 'text-foreground'}`}
                >
                  <FolderGit2 className="w-3 h-3 shrink-0" />
                  <span className="truncate text-xs">{repoName}</span>
                  {working > 0 && <span className="ml-auto flex items-center gap-0.5 text-[10px] text-blue-500"><Loader2 className="w-3 h-3 animate-spin" />{working}</span>}
                  {pending > 0 && !working && <span className="ml-auto flex items-center gap-0.5 text-[10px] text-amber-500"><ShieldAlert className="w-3 h-3" />{pending}</span>}
                </a>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  onClick={() => handleNewSession(repo.id, repo.fullPath)}
                  title="새 세션"
                >
                  <Plus className="w-3 h-3" />
                </Button>
              </div>
              {isExpanded && (
                <RepoSessions repoId={repo.id} directory={repo.fullPath} onNavigate={onNavigate} />
              )}
            </div>
          )
        })}
        {(!repos || repos.length === 0) && (
          <div className="px-4 py-2 text-xs text-muted-foreground">{reposLoading || !repos ? '로딩 중...' : '레포가 없습니다'}</div>
        )}
      </div>
    </div>
  )
}

function RepoSessions({ repoId, directory, onNavigate }: { repoId: number; directory?: string; onNavigate?: () => void }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { data: sessions, isLoading: sessionsLoading } = useSessions(OPENCODE_API_ENDPOINT, directory)
  const { data: dbStatuses } = useSessionStatusMap()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // 세션트리와 같은 parentID 트리: subagent는 숨겨진 하위로
  interface NavSessionNode {
    id: string
    title?: string
    parentID?: string
    children: NavSessionNode[]
  }
  const roots: NavSessionNode[] = useMemo(() => {
    if (!sessions) return []
    const nodes = new Map<string, NavSessionNode>()
    for (const s of sessions) {
      nodes.set(s.id, { id: s.id, title: s.title, parentID: (s as { parentID?: string }).parentID, children: [] })
    }
    const rs: NavSessionNode[] = []
    for (const n of nodes.values()) {
      const p = n.parentID ? nodes.get(n.parentID) : undefined
      if (p) p.children.push(n)
      else rs.push(n)
    }
    return rs
  }, [sessions])

  // 활성 세션이 접힌 하위에 있으면 조상 펼치기
  useEffect(() => {
    if (!sessions) return
    const active = sessions.find(s => location.pathname.includes(s.id))
    const parentID = (active as { parentID?: string } | undefined)?.parentID
    if (active && parentID) {
      const byId = new Map(sessions.map(s => [s.id, s] as const))
      const chain: string[] = []
      let cur: string | undefined = parentID
      while (cur && byId.has(cur)) {
        chain.push(cur)
        cur = (byId.get(cur) as { parentID?: string } | undefined)?.parentID
      }
      if (chain.length > 0) setExpanded(prev => new Set([...prev, ...chain]))
    }
  }, [location.pathname, sessions])

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (!sessions) {
    return <div className="ml-8 px-2 py-1 text-xs text-muted-foreground">{sessionsLoading ? '로딩 중...' : '세션 없음'}</div>
  }
  if (sessions.length === 0) {
    return <div className="ml-8 px-2 py-1 text-xs text-muted-foreground">세션 없음</div>
  }

  const renderRow = (id: string, title?: string) => {
    const isActive = location.pathname.includes(id)
    const isBusy = dbStatuses?.some(e => e.sessionId === id && e.status === 'busy')
    const pending = dbStatuses?.find(e => e.sessionId === id)?.pendingPermissions ?? 0
    return (
      <a
        key={id}
        href={`/repos/${repoId}/sessions/${id}`}
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey) return
          e.preventDefault()
          navigate(`/repos/${repoId}/sessions/${id}`)
          onNavigate?.()
        }}
        className={`flex items-center gap-2 px-2 py-1 rounded text-xs truncate hover:bg-accent text-left ${isActive ? 'bg-accent' : ''}`}
      >
        <MessageSquare className="w-3 h-3 shrink-0" />
        <span className="truncate flex-1">{title || 'Untitled'}</span>
        {isBusy && <Loader2 className="w-3 h-3 animate-spin text-blue-500 shrink-0" />}
        {pending > 0 && !isBusy && <ShieldAlert className="w-3 h-3 text-amber-500 shrink-0" />}
      </a>
    )
  }

  const visibleRoots = roots.slice(0, 10)

  const renderNavNode = (node: NavSessionNode): ReactNode => {
    const hasChildren = node.children.length > 0
    const isOpen = expanded.has(node.id)
    return (
      <div key={node.id} className="flex flex-col gap-0.5">
        <div className="flex items-center gap-0.5">
          {hasChildren ? (
            <button
              onClick={() => toggle(node.id)}
              className="h-5 w-5 flex items-center justify-center hover:bg-accent rounded shrink-0"
              title={isOpen ? '하위 세션 접기' : '하위 세션 펼치기'}
            >
              {isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </button>
          ) : (
            <span className="w-5 shrink-0" />
          )}
          <div className="flex-1 min-w-0">{renderRow(node.id, node.title)}</div>
        </div>
        {hasChildren && isOpen && (
          <div className="ml-4 border-l border-border pl-1 flex flex-col gap-0.5">
            {node.children.map((child) => renderNavNode(child))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="ml-6 border-l border-border pl-2 flex flex-col gap-0.5 mt-0.5">
      {visibleRoots.map((node) => renderNavNode(node))}
      {sessions.length > 10 && <div className="px-2 py-1 text-xs text-muted-foreground">+{sessions.length - 10} more</div>}
    </div>
  )
}
