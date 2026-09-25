import { useState, useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listRepos } from '@/api/repos'
import { useSessions, useSessionStatusMap } from '@/hooks/useOpenCode'
import { OPENCODE_API_ENDPOINT } from '@/config'
import { FolderGit2, MessageSquare, Plus, ChevronDown, ChevronRight, Loader2, ShieldAlert, Star, Trash2, Pencil, Check, X } from 'lucide-react'
import { CancelledBadge } from '../session/CancelledBadge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { listFavorites, addFavorite, removeFavorite } from '@/api/favorites'
import { loadRepoOrder, applySavedOrder } from '@/lib/repoOrder'
import { showToast } from '@/lib/toast'
import { DeleteDialog } from '@/components/ui/delete-dialog'
import { deleteRepo } from '@/api/repos'

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
  const [editMode, setEditMode] = useState(false)
  const [selectedRepos, setSelectedRepos] = useState<Set<number>>(new Set())
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set())
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [pendingBulk, setPendingBulk] = useState<{ repos: number[]; sessions: string[] } | null>(null)
  const [repoToDelete, setRepoToDelete] = useState<number | null>(null)

  const { data: repos, isLoading: reposLoading } = useQuery({ queryKey: ['repos'], queryFn: listRepos })
  const { data: dbStatuses } = useSessionStatusMap()
  const { data: favsTop } = useQuery({ queryKey: ['favorites'], queryFn: listFavorites })
  const isRepoFavTop = (rid: number) => favsTop?.some(f => f.sessionId === `repo-${rid}`)
  const toggleRepoFavTop = async (repo: { id: number; localPath?: string; fullPath?: string; workspaceRel?: string }) => {
    const favId = `repo-${repo.id}`
    try {
      if (isRepoFavTop(repo.id)) { await removeFavorite(favId); showToast.success('즐겨찾기 해제') }
      else { await addFavorite({ sessionId: favId, repoId: repo.id, directory: repo.workspaceRel || '', title: repo.localPath || favId }); showToast.success('즐겨찾기 등록') }
      queryClient.invalidateQueries({ queryKey: ['favorites'] })
    } catch (e:any){ showToast.error(e.message) }
  }

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
    return dbStatuses.filter(s => s.status === 'busy' && (s.repoId === repoId || s.directory === repo.workspaceRel)).length
  }

  const getPendingCount = (repoId: number) => {
    if (!dbStatuses || !repos) return 0
    const repo = repos.find(r => r.id === repoId)
    if (!repo) return 0
    return dbStatuses.filter(s => s.repoId === repoId || s.directory === repo.workspaceRel).reduce((acc, s) => acc + (s.pendingPermissions ?? 0), 0)
  }

  const getCancelledCount = (repoId: number) => {
    if (!dbStatuses || !repos) return 0
    const repo = repos.find(r => r.id === repoId)
    if (!repo) return 0
    return dbStatuses.filter(s => (s as unknown as { isCancelled?: boolean }).isCancelled && (s.repoId === repoId || s.directory === repo.workspaceRel) && s.status !== 'busy').length
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

  const handleSelectAll = () => {
    const allSelected = repos && repos.length > 0 && repos.every(r => selectedRepos.has(r.id))
    if (allSelected) { setSelectedRepos(new Set()); setSelectedSessions(new Set()) }
    else { setSelectedRepos(new Set(repos?.map(r => r.id) ?? [])) }
  }
  const handleRepoChecked = (repoId: number, checked: boolean, sessionIds: string[]) => {
    const nr = new Set(selectedRepos); const ns = new Set(selectedSessions)
    if (checked) { nr.add(repoId); sessionIds.forEach(id => ns.add(id)) } else { nr.delete(repoId); sessionIds.forEach(id => ns.delete(id)) }
    setSelectedRepos(nr); setSelectedSessions(ns)
  }
  const handleBatchDelete = () => {
    if (selectedRepos.size === 0 && selectedSessions.size === 0) return
    setPendingBulk({ repos: Array.from(selectedRepos), sessions: Array.from(selectedSessions) })
    setDeleteDialogOpen(true)
  }

  useEffect(() => {
    if (!editMode) { setSelectedRepos(new Set()); setSelectedSessions(new Set()) }
  }, [editMode])

  return (
    <div className="flex flex-col gap-1 py-2">
      {/* Repo List Header - sticky, 바깥 고정 */}
      <div className="flex items-center gap-1 px-2 sticky top-0 z-10 bg-background py-2 -mt-2 border-b border-border">
        {editMode && repos && repos.length > 0 && (
          <Checkbox checked={repos.length > 0 && repos.every(r => selectedRepos.has(r.id))} onCheckedChange={() => handleSelectAll()} title="All" className="shrink-0" />
        )}
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
        <Button
          variant={editMode ? 'default' : 'ghost'}
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={() => { const next = !editMode; setEditMode(next); if (!next) { setSelectedRepos(new Set()); setSelectedSessions(new Set()) } }}
          title={editMode ? '편집 완료' : '편집'}
        >
          <Pencil className="w-3 h-3" />
        </Button>
        {editMode ? (
          <Button variant="destructive" size="icon" className="h-6 w-6 shrink-0" disabled={selectedRepos.size === 0 && selectedSessions.size === 0} onClick={handleBatchDelete} title="삭제">
            <Trash2 className="w-3 h-3" />
          </Button>
        ) : (
          <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => onNewRepo?.()} title="새 레포">
            <Plus className="w-3 h-3" />
          </Button>
        )}
      </div>

      {/* Repos — 카드 목록과 같은 로컬 순서 (드래그 정렬 반영) */}
      <div className="flex flex-col gap-0.5">
        {applySavedOrder(repos ?? [], loadRepoOrder()).map(repo => {
          const repoName = repo.repoUrl ? repo.repoUrl.split('/').pop()?.replace('.git','') || repo.localPath : repo.localPath
          const isActive = isRepoActive(repo.id)
          const isExpanded = expandedRepos.has(repo.id)
          const working = getWorkingCount(repo.id)
          const pending = getPendingCount(repo.id)
          const cancelled = getCancelledCount(repo.id)
          const isRepoSelected = selectedRepos.has(repo.id)
          return (
            <div key={repo.id} className="flex flex-col">
              <div className={`flex items-center gap-1 px-2 rounded ${editMode && isRepoSelected ? 'bg-blue-50 dark:bg-blue-950/20' : ''}`}>
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleRepo(repo.id) }}
                  className="h-6 w-6 flex items-center justify-center hover:bg-accent rounded shrink-0"
                >
                  {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                </button>
                {!editMode && (
                  <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleRepoFavTop(repo) }} className={`p-1 rounded hover:bg-background shrink-0 ${isRepoFavTop(repo.id) ? 'text-amber-500' : 'text-muted-foreground'}`} title={isRepoFavTop(repo.id) ? '즐겨찾기 해제' : '즐겨찾기 등록'}>
                    <Star className={`w-3.5 h-3.5 ${isRepoFavTop(repo.id) ? 'fill-amber-500' : ''}`} />
                  </button>
                )}
                {editMode && (
                  <span onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={isRepoSelected}
                      onCheckedChange={(v) => {
                        const checked = v === true
const cached = queryClient.getQueryData<any[]>(['opencode', 'sessions', OPENCODE_API_ENDPOINT, repo.workspaceRel])
                        const ids: string[] = (cached ?? []).map((s: any) => s.id as string)
                        handleRepoChecked(repo.id, checked, ids)
                      }}
                    />
                  </span>
                )}
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
                  <span className="truncate text-xs">#{repo.id}. {repoName}</span>
                  {working > 0 && <span className="ml-auto flex items-center gap-0.5 text-[10px] text-blue-500"><Loader2 className="w-3 h-3 animate-spin" />{working}</span>}
                  {pending > 0 && !working && <span className="ml-auto flex items-center gap-0.5 text-[10px] text-amber-500"><ShieldAlert className="w-3 h-3" />{pending}</span>}
                  {cancelled > 0 && !working && !pending && <span className="ml-auto flex items-center gap-0.5 text-[10px] text-gray-500"><CancelledBadge size="sm" />{cancelled}</span>}
                </a>
                {editMode ? (
                  <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={(e) => { (e as any).stopPropagation(); setRepoToDelete(repo.id); setDeleteDialogOpen(true) }} title="레포 삭제"><Trash2 className="w-3 h-3" /></Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    onClick={(e) => { (e as any).stopPropagation(); handleNewSession(repo.id, repo.workspaceRel) }}
                    title="새 세션"
                  >
                    <Plus className="w-3 h-3" />
                  </Button>
                )}
              </div>
              {isExpanded && (
                <RepoSessions
                  repoId={repo.id}
                  directory={repo.workspaceRel}
                  onNavigate={onNavigate}
                  editMode={editMode}
                  selectedSessions={selectedSessions}
                  selectedRepos={selectedRepos}
                  onSessionChecked={(sid, checked) => {
                    const isRepoSelected = selectedRepos.has(repo.id)
                    if (!checked && isRepoSelected) {
const cached = queryClient.getQueryData<any[]>(['opencode', 'sessions', OPENCODE_API_ENDPOINT, repo.workspaceRel])
                      const ids: string[] = (cached ?? []).map((s: any) => s.id as string)
                      const ns = new Set(ids.filter(id => id !== sid))
                      setSelectedRepos(prev => { const n = new Set(prev); n.delete(repo.id); return n })
                      setSelectedSessions(ns)
                      return
                    }
                    const ns = new Set(selectedSessions)
                    if (checked) ns.add(sid); else ns.delete(sid)
                    const cached = queryClient.getQueryData<any[]>(['opencode', 'sessions', OPENCODE_API_ENDPOINT, repo.fullPath])
                    const ids: string[] = (cached ?? []).map((s: any) => s.id as string)
                    if (ids.length > 0 && ids.every(id => ns.has(id))) {
                      setSelectedRepos(prev => new Set([...prev, repo.id]))
                    } else if (checked === false) {
                      setSelectedRepos(prev => { const n = new Set(prev); n.delete(repo.id); return n })
                    }
                    setSelectedSessions(ns)
                  }}
                />
              )}
            </div>
          )
        })}
        {(!repos || repos.length === 0) && (
          <div className="px-4 py-2 text-xs text-muted-foreground">{reposLoading || !repos ? '로딩 중...' : '레포가 없습니다'}</div>
        )}
      </div>
      <DeleteDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={(withIndex) => {
          const wi = withIndex ?? true
          if (repoToDelete != null) {
            deleteRepo(repoToDelete, { withIndex: wi }).then(() => {
              queryClient.invalidateQueries({ queryKey: ['repos'] })
              setSelectedRepos(prev => { const n=new Set(prev); n.delete(repoToDelete); return n })
            }).catch(e => showToast.error(e instanceof Error ? e.message : '삭제 실패'))
            setRepoToDelete(null)
            setDeleteDialogOpen(false)
          } else if (pendingBulk) {
            if (pendingBulk.repos.length > 0) {
              Promise.all(pendingBulk.repos.map(id => deleteRepo(id, { withIndex: wi })))
                .then(() => queryClient.invalidateQueries({ queryKey: ['repos'] }))
                .catch(e => showToast.error(e instanceof Error ? e.message : '삭제 실패'))
            }
            if (pendingBulk.sessions.length > 0) {
              const dirBySession = new Map<string, string>()
              // 세션 삭제는 repo별 directory 필요 — 현재 expanded repos 기준으로 추정
              pendingBulk.sessions.forEach(sid => {
                const repo = repos?.find(r => selectedRepos.has(r.id)) || repos?.[0]
                const dir = repo?.fullPath ?? ''
                dirBySession.set(sid, dir)
              })
              pendingBulk.sessions.forEach(sid => {
                const dir = dirBySession.get(sid) ?? ''
                fetch(`${OPENCODE_API_ENDPOINT}/session/${sid}?directory=${encodeURIComponent(dir)}`, { method: 'DELETE' }).catch(() => {})
              })
              setSelectedSessions(new Set())
            }
            setSelectedRepos(new Set())
            setPendingBulk(null)
            setDeleteDialogOpen(false)
          }
        }}
        onCancel={() => { setDeleteDialogOpen(false); setRepoToDelete(null); setPendingBulk(null) }}
        title={repoToDelete != null ? '레포지토리 삭제' : pendingBulk ? `삭제 확인 (${pendingBulk.repos.length} 레포, ${pendingBulk.sessions.length} 세션)` : '삭제 확인'}
        description={repoToDelete != null ? '이 레포지토리를 삭제합니다. 되돌릴 수 없습니다.' : '선택한 항목을 삭제합니다. 이 작업은 되돌릴 수 없습니다.'}
        isDeleting={false}
        withIndexOption
      />
    </div>
  )
}

function RepoSessions({ repoId, directory, onNavigate, editMode, selectedSessions, selectedRepos, onSessionChecked }: {
  repoId: number; directory?: string; onNavigate?: () => void;
  editMode?: boolean; selectedSessions?: Set<string>; selectedRepos?: Set<number>;
  onSessionChecked?: (sid: string, checked: boolean) => void;
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const { data: sessions, isLoading: sessionsLoading } = useSessions(OPENCODE_API_ENDPOINT, directory, { repoId })
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

  // 접으면 세션 목록 캐시를 즉시 비운다 (다음 펼칠 때 새로 로드)
  useEffect(() => {
    return () => { queryClient.removeQueries({ queryKey: ['opencode', 'sessions', OPENCODE_API_ENDPOINT, directory] }) }
  }, [queryClient, directory])

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

  // 훅은 early return보다 항상 먼저 호출되어야 한다 (세션 로딩 전후 훅 개수 불일치 크래시 방지)
  const { data: favs } = useQuery({ queryKey: ['favorites'], queryFn: listFavorites })
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingSessionTitle, setEditingSessionTitle] = useState('')
  useEffect(() => { if (!editMode) { setEditingSessionId(null); setEditingSessionTitle('') } }, [editMode])

  if (!sessions) {
    return <div className="ml-8 px-2 py-1 text-xs text-muted-foreground">{sessionsLoading ? '로딩 중...' : '세션 없음'}</div>
  }
  if (sessions.length === 0) {
    return <div className="ml-8 px-2 py-1 text-xs text-muted-foreground">세션 없음</div>
  }

  const isFav = (id: string) => favs?.some(f => f.sessionId === id)
  const toggleFav = async (id: string, title?: string) => {
    try {
      if (isFav(id)) { await removeFavorite(id); showToast.success('즐겨찾기 해제') }
      else { await addFavorite({ sessionId: id, repoId, directory, title: title || id }); showToast.success('즐겨찾기 등록') }
      queryClient.invalidateQueries({ queryKey: ['favorites'] })
    } catch (e:any){ showToast.error(e.message) }
  }

  const handleDeleteSession = (sid: string) => {
    fetch(`${OPENCODE_API_ENDPOINT}/session/${sid}?directory=${encodeURIComponent(directory ?? '')}`, { method: 'DELETE' })
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ['opencode', 'sessions', OPENCODE_API_ENDPOINT, directory] })
        showToast.success('세션 삭제됨')
      })
      .catch(e => showToast.error(e instanceof Error ? e.message : '삭제 실패'))
  }
  const handleSaveSessionRename = async (sid: string) => {
    const title = editingSessionTitle.trim()
    if (!title) { showToast.error('제목을 입력하세요'); return }
    try {
      // 우선 백엔드 경유로 시도, 실패 시 opencode 직접 호출
      const { renameSessionRepo } = await import('@/api/repos')
      try { await renameSessionRepo(repoId, sid, title) } catch {
        const { createOpenCodeClient } = await import('@/api/opencode')
        const client = createOpenCodeClient(OPENCODE_API_ENDPOINT, directory)
        await client.updateSession(sid, { title } as any)
      }
      showToast.success('세션 이름 변경됨')
      queryClient.invalidateQueries({ queryKey: ['opencode', 'sessions', OPENCODE_API_ENDPOINT, directory] })
      setEditingSessionId(null)
    } catch (e:any){ showToast.error(e.message || '이름 변경 실패') }
  }

  const renderRow = (id: string, title?: string) => {
    const isActive = location.pathname.includes(id)
    const isBusy = dbStatuses?.some(e => e.sessionId === id && e.status === 'busy')
    const pending = dbStatuses?.find(e => e.sessionId === id)?.pendingPermissions ?? 0
    const isCancelled = dbStatuses?.some(e => (e as unknown as { isCancelled?: boolean }).isCancelled && e.sessionId === id && e.status !== 'busy') ?? false
    const fav = isFav(id)
    const isChecked = editMode ? (selectedSessions?.has(id) || selectedRepos?.has(repoId) || false) : false
    const isEditing = editMode && editingSessionId === id
    return (
      <div key={id} className={`flex items-center gap-1 pr-1 rounded hover:bg-accent ${isActive ? 'bg-accent' : ''} ${editMode && isChecked ? 'bg-blue-50 dark:bg-blue-950/20' : ''}`}>
        {!editMode && !isEditing && (
          <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFav(id, title) }} className={`p-1 rounded hover:bg-background shrink-0 ${fav ? 'text-amber-500' : 'text-muted-foreground'}`} title={fav ? '즐겨찾기 해제' : '즐겨찾기 등록'}>
            <Star className={`w-3 h-3 ${fav ? 'fill-amber-500' : ''}`} />
          </button>
        )}
        {editMode && !isEditing && (
          <span onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={isChecked}
              onCheckedChange={(v) => {
                const checked = v === true
                if (onSessionChecked) onSessionChecked(id, checked)
              }}
              className="ml-1 shrink-0"
            />
          </span>
        )}
        {isEditing ? (
          <div className="flex-1 flex items-center gap-1 min-w-0">
            <Input value={editingSessionTitle} onChange={e => setEditingSessionTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleSaveSessionRename(id) } if (e.key === 'Escape') setEditingSessionId(null) }} className="h-6 text-xs flex-1" autoFocus />
            <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => handleSaveSessionRename(id)} title="저장"><Check className="w-3 h-3" /></Button>
            <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => setEditingSessionId(null)} title="취소"><X className="w-3 h-3" /></Button>
          </div>
        ) : (
          <a
            href={`/repos/${repoId}/sessions/${id}`}
            onClick={(e) => {
              if (e.ctrlKey || e.metaKey) return
              e.preventDefault()
              navigate(`/repos/${repoId}/sessions/${id}`)
              onNavigate?.()
            }}
            className={`flex items-center gap-2 px-2 py-1 text-xs truncate text-left flex-1 min-w-0`}
          >
            <MessageSquare className="w-3 h-3 shrink-0" />
            <span className="truncate flex-1">{title || 'Untitled'}</span>
            {isBusy && <Loader2 className="w-3 h-3 animate-spin text-blue-500 shrink-0" />}
            {pending > 0 && !isBusy && <ShieldAlert className="w-3 h-3 text-amber-500 shrink-0" />}
            {isCancelled && !isBusy && !pending && <CancelledBadge size="sm" />}
          </a>
        )}
        {editMode ? (
          isEditing ? null : (
            <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => { e.stopPropagation(); setEditingSessionId(id); setEditingSessionTitle(title || '') }} title="이름 변경"><span className="text-[10px] font-bold text-muted-foreground">Aa</span></Button>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => { e.stopPropagation(); handleDeleteSession(id) }} title="세션 삭제"><Trash2 className="w-3 h-3" /></Button>
            </div>
          )
        ) : null}
      </div>
    )
  }

  const renderNavNode = (node: NavSessionNode): ReactNode => {
    const hasChildren = node.children.length > 0
    const isOpen = expanded.has(node.id)
    return (
      <div key={node.id} className="flex flex-col gap-0.5">
        <div className="flex items-center gap-0.5">
          {hasChildren ? (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(node.id) }}
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
      {roots.map((node) => renderNavNode(node))}
    </div>
  )
}
