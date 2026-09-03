import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { listRepos } from '@/api/repos'
import { useSessions, useSessionStatusMap } from '@/hooks/useOpenCode'
import { OPENCODE_API_ENDPOINT } from '@/config'
import { Home, FolderGit2, MessageSquare, Plus, ChevronDown, ChevronRight, Loader2, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface NavigationTreeProps {
  onNavigate?: () => void
  onNewRepo?: () => void
}

export function NavigationTree({ onNavigate, onNewRepo }: NavigationTreeProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const [expandedRepos, setExpandedRepos] = useState<Set<number>>(new Set())

  const { data: repos } = useQuery({ queryKey: ['repos'], queryFn: listRepos })
  const { data: dbStatuses } = useSessionStatusMap()

  const toggleRepo = (repoId: number) => {
    setExpandedRepos(prev => {
      const next = new Set(prev)
      if (next.has(repoId)) next.delete(repoId)
      else next.add(repoId)
      return next
    })
  }

  const isHomeActive = location.pathname === '/'
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

  return (
    <div className="flex flex-col gap-1 py-2">
      {/* Home */}
      <div className="flex items-center gap-1 px-2">
        <button
          onClick={() => { navigate('/'); onNavigate?.() }}
          className={`flex-1 flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-accent text-left ${isHomeActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          <Home className="w-4 h-4 shrink-0" />
          <span className="truncate">홈</span>
        </button>
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => onNewRepo?.()} title="새 레포">
          <Plus className="w-3 h-3" />
        </Button>
      </div>

      {/* Repo List Header */}
      <div className="flex items-center gap-1 px-2 mt-1">
        <div className="flex-1 flex items-center gap-2 px-2 py-1 text-xs font-semibold text-muted-foreground">
          <FolderGit2 className="w-3 h-3" />
          레포 리스트
        </div>
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
                <button
                  onClick={() => { navigate(`/repos/${repo.id}`); onNavigate?.() }}
                  className={`flex-1 flex items-center gap-2 px-1 py-1 rounded text-sm truncate hover:bg-accent text-left ${isActive ? 'bg-accent text-accent-foreground' : 'text-foreground'}`}
                >
                  <FolderGit2 className="w-3 h-3 shrink-0" />
                  <span className="truncate text-xs">{repoName}</span>
                  {working > 0 && <span className="ml-auto flex items-center gap-0.5 text-[10px] text-blue-500"><Loader2 className="w-3 h-3 animate-spin" />{working}</span>}
                  {pending > 0 && !working && <span className="ml-auto flex items-center gap-0.5 text-[10px] text-amber-500"><ShieldAlert className="w-3 h-3" />{pending}</span>}
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  onClick={() => navigate(`/repos/${repo.id}`)}
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
          <div className="px-4 py-2 text-xs text-muted-foreground">레포가 없습니다</div>
        )}
      </div>
    </div>
  )
}

function RepoSessions({ repoId, directory, onNavigate }: { repoId: number; directory?: string; onNavigate?: () => void }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { data: sessions } = useSessions(OPENCODE_API_ENDPOINT, directory)
  const { data: dbStatuses } = useSessionStatusMap()

  if (!sessions || sessions.length === 0) {
    return <div className="ml-8 px-2 py-1 text-xs text-muted-foreground">세션 없음</div>
  }

  return (
    <div className="ml-6 border-l border-border pl-2 flex flex-col gap-0.5 mt-0.5">
      {sessions.slice(0, 10).map(s => {
        const isActive = location.pathname.includes(s.id)
        const isBusy = dbStatuses?.some(e => e.sessionId === s.id && e.status === 'busy')
        const pending = dbStatuses?.find(e => e.sessionId === s.id)?.pendingPermissions ?? 0
        return (
          <button
            key={s.id}
            onClick={() => { navigate(`/repos/${repoId}/sessions/${s.id}`); onNavigate?.() }}
            className={`flex items-center gap-2 px-2 py-1 rounded text-xs truncate hover:bg-accent text-left ${isActive ? 'bg-accent' : ''}`}
          >
            <MessageSquare className="w-3 h-3 shrink-0" />
            <span className="truncate flex-1">{s.title || 'Untitled'}</span>
            {isBusy && <Loader2 className="w-3 h-3 animate-spin text-blue-500 shrink-0" />}
            {pending > 0 && !isBusy && <ShieldAlert className="w-3 h-3 text-amber-500 shrink-0" />}
          </button>
        )
      })}
      {sessions.length > 10 && <div className="px-2 py-1 text-xs text-muted-foreground">+{sessions.length - 10} more</div>}
    </div>
  )
}
