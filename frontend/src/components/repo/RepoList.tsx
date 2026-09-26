import { useState, useMemo, useEffect, type DragEvent as ReactDragEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listRepos, deleteRepo } from "@/api/repos";
import { listSchedules } from "@/api/schedules";
import { useSessionStatusMap, useSessions } from "@/hooks/useOpenCode";
import { DeleteDialog } from "@/components/ui/delete-dialog";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Loader2, GitBranch, Search, Trash2, Ellipsis, Plus, Pencil, MessageSquare, Check, X } from "lucide-react";
import { RepoCard } from "./RepoCard";
import { clearRepoNotifyData } from "@/lib/notifications";
import { REPO_ORDER_KEY, applySavedOrder, saveRepoOrder } from "@/lib/repoOrder";
import { OPENCODE_API_ENDPOINT } from "@/config";
import { renameSessionRepo } from "@/api/repos";
import { showToast } from "@/lib/toast";

export function RepoList({ onAddRepo }: { onAddRepo?: () => void }) {
  const queryClient = useQueryClient();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [repoToDelete, setRepoToDelete] = useState<number | null>(null);
  const [selectedRepos, setSelectedRepos] = useState<Set<number>>(new Set());
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [isEditMode, setIsEditMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingBulk, setPendingBulk] = useState<{ repos: number[]; sessions: string[] } | null>(null);
  // 카드 순서 (개인별, localStorage — 서버에 저장 안 함)
  const [repoOrder, setRepoOrder] = useState<number[]>(() => {
    try {
      const raw = localStorage.getItem(REPO_ORDER_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((n) => typeof n === 'number') : [];
    } catch {
      return [];
    }
  });
  const [dropTarget, setDropTarget] = useState<{ id: number; after: boolean } | null>(null);

  const {
    data: repos,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["repos"],
    queryFn: listRepos,
  });

  const { data: schedules } = useQuery({
    queryKey: ["schedules"],
    queryFn: () => listSchedules(),
  });

  const scheduleCounts = (schedules ?? []).reduce<Record<number, number>>((acc, schedule) => {
    acc[schedule.repoId] = (acc[schedule.repoId] ?? 0) + 1;
    return acc;
  }, {});

  const { data: dbStatuses } = useSessionStatusMap();
  // 세션 리스트 배지와 동일한 기준(status==='busy')으로 카운트한다.
  // 폴러가 repoId 를 못 채운 경우 directory 로 레포를 역매칭해 누락을 막는다.
  const resolveRepoIdOf = (entry: { repoId?: number | null; directory?: string | null }): number | null => {
    if (entry.repoId != null) return entry.repoId;
    if (!entry.directory) return null;
    const norm = entry.directory.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const repo = (repos ?? []).find(
      (r) => (r.fullPath ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === norm,
    );
    return repo?.id ?? null;
  };
  const workingCounts = (dbStatuses ?? []).reduce<Record<number, number>>((acc, entry) => {
    if (entry.status !== "busy") return acc;
    const repoId = resolveRepoIdOf(entry);
    if (repoId == null) return acc;
    acc[repoId] = (acc[repoId] ?? 0) + 1;
    return acc;
  }, {});
  const pendingCounts = (dbStatuses ?? []).reduce<Record<number, number>>((acc, entry) => {
    if (!entry.pendingPermissions) return acc;
    const repoId = resolveRepoIdOf(entry);
    if (repoId == null) return acc;
    acc[repoId] = (acc[repoId] ?? 0) + (entry.pendingPermissions ?? 0);
    return acc;
  }, {});

  const deleteMutation = useMutation({
    mutationFn: ({ id, withIndex }: { id: number; withIndex: boolean }) => deleteRepo(id, { withIndex }),
    onSuccess: (_data, vars) => {
      try { clearRepoNotifyData(vars.id) } catch {}
      queryClient.invalidateQueries({ queryKey: ["repos"] });
      setDeleteDialogOpen(false);
      setRepoToDelete(null);
    },
  });

  const batchDeleteMutation = useMutation({
    mutationFn: async ({ ids, withIndex }: { ids: number[]; withIndex: boolean }) => {
      await Promise.all(ids.map((id) => deleteRepo(id, { withIndex })));
    },
    onSuccess: (_data, vars) => {
      try { for (const id of (vars as { ids: number[] }).ids) clearRepoNotifyData(id) } catch {}
      queryClient.invalidateQueries({ queryKey: ["repos"] });
      setDeleteDialogOpen(false);
      setSelectedRepos(new Set());
    },
  });

  if (isLoading && !repos) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center p-8 text-destructive">
        Failed to load repositories:{" "}
        {error instanceof Error ? error.message : "Unknown error"}
      </div>
    );
  }

  const dedupedRepos = (repos ?? []).reduce((acc, repo) => {
    if (repo.isWorktree) {
      acc.push(repo);
    } else {
      const key = repo.repoUrl || repo.localPath;
      const existing = acc.find(r => (r.repoUrl || r.localPath) === key && !r.isWorktree);
      
      if (!existing) {
        acc.push(repo);
      }
    }
    
    return acc;
  }, [] as NonNullable<typeof repos>);

  // early return 뒤에 hook을 두면 순서가 바뀌어 에러가 나므로 메모 없이 계산
  const orderedRepos = applySavedOrder(dedupedRepos, repoOrder);

  const filteredRepos = orderedRepos.filter((repo) => {
    const repoName = repo.repoUrl
      ? repo.repoUrl.split("/").slice(-1)[0].replace(".git", "")
      : repo.localPath;
    const searchTarget = repo.repoUrl || repo.localPath || "";
    return (
      repoName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      searchTarget.toLowerCase().includes(searchQuery.toLowerCase())
    );
  });

  const persistOrder = (ids: number[]) => {
    setRepoOrder(ids);
    saveRepoOrder(ids);
  };

  const handleDropOnRepo = (e: ReactDragEvent, targetId: number, after: boolean) => {
    e.preventDefault();
    setDropTarget(null);
    const raw = e.dataTransfer.getData('text/repo-id');
    const draggedId = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isInteger(draggedId) || draggedId === targetId) return;
    const ids = orderedRepos.map((r) => r.id).filter((id) => id !== draggedId);
    const at = ids.indexOf(targetId);
    if (at < 0) return;
    ids.splice(after ? at + 1 : at, 0, draggedId);
    persistOrder(ids);
  };

  const handleDragOverRepo = (e: ReactDragEvent, targetId: number) => {
    if (!e.dataTransfer.types.includes('text/repo-id')) return;
    e.preventDefault();
    // 카드 상반신에 놓으면 앞, 하반신에 놓으면 뒤 (아래로 끌 때 필수)
    const rect = e.currentTarget.getBoundingClientRect();
    const after = e.clientY - rect.top > rect.height / 2;
    setDropTarget((cur) => (cur && cur.id === targetId && cur.after === after ? cur : { id: targetId, after }));
  };

  const handleSelectRepo = (id: number, selected: boolean) => {
    const newSelected = new Set(selectedRepos);
    if (selected) newSelected.add(id); else newSelected.delete(id);
    setSelectedRepos(newSelected);
  };

  const handleSelectAll = () => {
    const allFilteredSelected = filteredRepos.every((repo) => selectedRepos.has(repo.id));
    if (isEditMode) {
      if (allFilteredSelected) { setSelectedRepos(new Set()); setSelectedSessions(new Set()); }
      else { setSelectedRepos(new Set(filteredRepos.map((r) => r.id))); /* sessions는 각 row에서 repo 선택으로 간주 */ }
      return
    }
    if (allFilteredSelected) setSelectedRepos(new Set()); else setSelectedRepos(new Set(filteredRepos.map((r) => r.id)));
  };

  const handleBatchDelete = () => {
    if (selectedRepos.size > 0 || selectedSessions.size > 0) {
      setPendingBulk({ repos: Array.from(selectedRepos), sessions: Array.from(selectedSessions) });
      setDeleteDialogOpen(true);
    }
  };

  // repo 체크 시 세션 전체 선택/해제 — 자식 세션 목록은 각 RepoCard 세션 패널에서 동기화
  const handleRepoCheckedWithSessions = (repoId: number, checked: boolean, sessionIds: string[]) => {
    const nr = new Set(selectedRepos);
    const ns = new Set(selectedSessions);
    if (checked) { nr.add(repoId); sessionIds.forEach(id => ns.add(id)); } else { nr.delete(repoId); sessionIds.forEach(id => ns.delete(id)); }
    setSelectedRepos(nr); setSelectedSessions(ns);
  };


  return (
    <>
      <div className="p-2 md:p-4">
        <div className="flex items-center gap-3 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
            <Input
              placeholder="Search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
          {/* 편집 모드 토글 - 아이콘만 */}
          <Button variant={isEditMode ? "default" : "outline"} size="icon" className="hidden md:flex h-8 w-8" onClick={() => { setIsEditMode(v => !v); if (isEditMode) { setSelectedRepos(new Set()); setSelectedSessions(new Set()) } }} title={isEditMode ? "완료" : "편집"}>
            <Pencil className="w-4 h-4" />
          </Button>
          {/* 편집 모드: 최상단 Repository 체크 + 삭제 */}
          {isEditMode ? (
            <>
              {filteredRepos.length > 0 && (
                <label className="hidden md:flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox checked={filteredRepos.length > 0 && filteredRepos.every(r => selectedRepos.has(r.id))} onCheckedChange={() => handleSelectAll()} />
                  <span>All</span>
                </label>
              )}
              <Button onClick={handleBatchDelete} variant="destructive" size="icon" disabled={selectedRepos.size === 0 && selectedSessions.size === 0} className="hidden md:flex h-8 w-8" title="삭제">
                <Trash2 className="w-4 h-4" />
              </Button>
            </>
          ) : (
            <>
              {filteredRepos.length > 0 && (
                <Button onClick={handleSelectAll} variant={selectedRepos.size > 0 ? "default" : "outline"} size="sm" className="whitespace-nowrap hidden md:flex h-8">
                  {filteredRepos.every((repo) => selectedRepos.has(repo.id)) ? "Deselect All" : "Select All"}
                </Button>
              )}
              <Button onClick={handleBatchDelete} variant="destructive" size="icon" disabled={selectedRepos.size === 0} className="hidden md:flex h-8 w-8" title="삭제">
                <Trash2 className="w-4 h-4" />
              </Button>
            </>
          )}
          <Button
            onClick={() => onAddRepo?.()}
            size="sm"
            className="bg-[#185A8C] hover:bg-[#0F4A7E] text-white hidden md:flex whitespace-nowrap h-8"
          >
            <Plus className="w-4 h-4 mr-1" />
            Repository
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="md:hidden"
              >
                <Ellipsis className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {filteredRepos.length > 0 && (
                <DropdownMenuItem onClick={handleSelectAll}>
                  {filteredRepos.every((repo) => selectedRepos.has(repo.id))
                    ? "Deselect All"
                    : "Select All"}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem 
                onClick={handleBatchDelete}
                disabled={selectedRepos.size === 0}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Delete ({selectedRepos.size})
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            onClick={() => onAddRepo?.()}
            size="icon"
            className="bg-[#185A8C] hover:bg-[#0F4A7E] text-white md:hidden h-8 w-8"
            title="Repository"
          >
            <Plus className="w-4 h-4" />
          </Button>
        </div>

        <div className="min-h-[300px] max-h-[calc(100vh-120px)] overflow-y-auto pr-1 pb-4">
          {dedupedRepos.length === 0 ? (
            <div className="text-center p-12">
              <GitBranch className="w-12 h-12 mx-auto mb-4 text-zinc-600" />
              <p className="text-zinc-500">No repositories yet. Add one to get started.</p>
            </div>
          ) : filteredRepos.length === 0 ? (
            <div className="text-center p-12">
              <Search className="w-12 h-12 mx-auto mb-4 text-zinc-600" />
              <p className="text-zinc-500">
                No repositories found matching "{searchQuery}"
              </p>
            </div>
          ) : isEditMode ? (
            <div className="space-y-2">
              {filteredRepos.map((repo) => (
                <EditRepoRow
                  key={repo.id}
                  repo={repo}
                  isSelected={selectedRepos.has(repo.id)}
                  selectedSessions={selectedSessions}
                  onRepoChecked={(checked, ids) => handleRepoCheckedWithSessions(repo.id, checked, ids)}
                  onSessionChecked={(sid, checked) => {
                    const isRepoSelected = selectedRepos.has(repo.id)
                    if (!checked && isRepoSelected) {
                      const cachedSessions = queryClient.getQueryData<any[]>(['opencode', 'sessions', OPENCODE_API_ENDPOINT, repo.workspaceRel])
                      const ids: string[] = (cachedSessions ?? []).map((s: any) => s.id as string)
                      if (ids.length === 0) {
                        const n = new Set(selectedSessions); n.delete(sid); setSelectedSessions(n)
                      } else {
                        const ns = new Set(ids.filter(id => id !== sid))
                        setSelectedSessions(ns)
                      }
                      setSelectedRepos(prev => { const n = new Set(prev); n.delete(repo.id); return n })
                      return
                    }
                    const ns = new Set(selectedSessions);
                    if (checked) ns.add(sid); else ns.delete(sid);
                    // 전부 체크되면 레포도 체크
                    const cached = queryClient.getQueryData<any[]>(['opencode', 'sessions', OPENCODE_API_ENDPOINT, repo.workspaceRel])
                    const ids: string[] = (cached ?? []).map((s: any) => s.id as string)
                    if (ids.length > 0 && ids.every(id => ns.has(id))) {
                      setSelectedRepos(prev => new Set([...prev, repo.id]))
                    } else if (!checked) {
                      setSelectedRepos(prev => { const n = new Set(prev); n.delete(repo.id); return n })
                    }
                    setSelectedSessions(ns);
                  }}
                  onDeleteRepo={(id) => { setRepoToDelete(id); setDeleteDialogOpen(true) }}
                  isDeleting={deleteMutation.isPending && repoToDelete === repo.id}
                />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-2 gap-4 w-full">
              {filteredRepos.map((repo) => (
                <div
                  key={repo.id}
                  onDragOver={(e) => handleDragOverRepo(e, repo.id)}
                  onDragLeave={() => setDropTarget((cur) => (cur && cur.id === repo.id ? null : cur))}
                  onDrop={(e) => handleDropOnRepo(e, repo.id, dropTarget?.id === repo.id ? dropTarget.after : false)}
                  className={`rounded-xl transition-shadow ${dropTarget?.id === repo.id ? 'ring-2 ring-blue-500 shadow-lg' : ''}`}
                >
                  <RepoCard
                    repo={repo}
                    onDelete={(id) => {
                      setRepoToDelete(id);
                      setDeleteDialogOpen(true);
                    }}
                    isDeleting={
                      deleteMutation.isPending && repoToDelete === repo.id
                    }
                    isSelected={selectedRepos.has(repo.id)}
                    onSelect={handleSelectRepo}
                    dragHandle={
                      <span
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/repo-id', String(repo.id));
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragEnd={() => setDropTarget(null)}
                        onClick={(e) => e.stopPropagation()}
                        title="드래그해서 순서 변경 (이 PC에만 저장)"
                        className="absolute left-0 top-0 z-10 h-5 w-5 cursor-grab active:cursor-grabbing bg-[#185A8C]/70 hover:bg-[#185A8C]"
                        style={{
                          clipPath: 'polygon(0 0, 100% 0, 0 100%)',
                        }}
                      />
                    }
                    scheduleCount={scheduleCounts[repo.id] ?? 0}
                    workingCount={workingCounts[repo.id] ?? 0}
                    pendingCount={pendingCounts[repo.id] ?? 0}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <DeleteDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={(withIndex) => {
          const wi = withIndex ?? true
          if (repoToDelete) {
            deleteMutation.mutate({ id: repoToDelete, withIndex: wi });
          } else if (pendingBulk) {
            // 워크스페이스 편집 모드: 레포 + 세션 일괄 삭제
            if (pendingBulk.repos.length > 0) batchDeleteMutation.mutate({ ids: pendingBulk.repos, withIndex: wi });
            if (pendingBulk.sessions.length > 0) {
              // 세션 삭제는 repo별 directory가 필요 — 첫 세션의 repo로 일괄 시도
              // 간단히 각 세션을 개별 삭제 (withIndex 무시)
              const firstRepo = filteredRepos.find(r => pendingBulk.repos.includes(r.id)) || filteredRepos[0];
              const dir = firstRepo?.fullPath;
              // useDeleteSession은 훅이므로 직접 fetch로 삭제
              pendingBulk.sessions.forEach(sid => {
                fetch(`${OPENCODE_API_ENDPOINT}/session/${sid}?directory=${encodeURIComponent(dir || '')}`, { method: 'DELETE' }).catch(()=>{})
              })
              setSelectedSessions(new Set());
            }
            setPendingBulk(null);
            if (pendingBulk.repos.length === 0) { setDeleteDialogOpen(false) }
          } else if (selectedRepos.size > 0) {
            batchDeleteMutation.mutate({ ids: Array.from(selectedRepos), withIndex: wi });
          }
        }}
        onCancel={() => {
          setDeleteDialogOpen(false);
          setRepoToDelete(null);
          setPendingBulk(null);
        }}
        title={
          pendingBulk ? `삭제 확인 (${pendingBulk.repos.length} 레포, ${pendingBulk.sessions.length} 세션)` :
          selectedRepos.size > 0
            ? "Delete Multiple Repositories"
            : "Delete Repository"
        }
        description={
          pendingBulk ? `선택한 항목을 삭제합니다. 이 작업은 되돌릴 수 없습니다.` :
          selectedRepos.size > 0
            ? `Are you sure you want to delete ${selectedRepos.size} repositor${selectedRepos.size === 1 ? "y" : "ies"}? This will remove all local files. This action cannot be undone.`
            : "Are you sure you want to delete this repository? This will remove all local files. This action cannot be undone."
        }
        isDeleting={deleteMutation.isPending || batchDeleteMutation.isPending}
        withIndexOption
      />
    </>
  );
}

function EditRepoRow({ repo, isSelected, selectedSessions, onRepoChecked, onSessionChecked, onDeleteRepo, isDeleting }: {
  repo: { id: number; localPath?: string; fullPath?: string; workspaceRel: string };
  isSelected: boolean;
  selectedSessions: Set<string>;
  onRepoChecked: (checked: boolean, ids: string[]) => void;
  onSessionChecked: (sid: string, checked: boolean) => void;
  onDeleteRepo: (id: number) => void;
  isDeleting: boolean;
}) {
  const queryClient = useQueryClient();
  const { data: sessions } = useSessions(OPENCODE_API_ENDPOINT, repo.workspaceRel, { repoId: repo.id });
  const sessionIds = useMemo(() => (sessions ?? []).map((s: any) => s.id as string), [sessions]);
  // 행이 사라지면 세션 목록 캐시를 즉시 비운다 (다음 열 때 새로 로드)
  useEffect(() => {
    return () => { queryClient.removeQueries({ queryKey: ['opencode', 'sessions', OPENCODE_API_ENDPOINT, repo.workspaceRel] }) }
  }, [queryClient, repo.workspaceRel]);
  const [editingSid, setEditingSid] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  const handleSessionRename = async (sid: string) => {
    const title = editingTitle.trim();
    if (!title) { showToast.error('제목을 입력하세요'); return }
    try {
      try { await renameSessionRepo(repo.id, sid, title) } catch {
        const { createOpenCodeClient } = await import('@/api/opencode')
        const client = createOpenCodeClient(OPENCODE_API_ENDPOINT, repo.workspaceRel)
        await client.updateSession(sid, { title } as any)
      }
      showToast.success('세션 이름 변경됨'); queryClient.invalidateQueries({ queryKey: ['opencode', 'sessions', OPENCODE_API_ENDPOINT, repo.workspaceRel] }); setEditingSid(null)
    } catch (e:any){ showToast.error(e.message || '이름 변경 실패') }
  }

  return (
    <div className="border rounded-lg bg-card p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Checkbox checked={isSelected} onCheckedChange={(v) => onRepoChecked(v === true, sessionIds)} />
        <GitBranch className="w-4 h-4 text-muted-foreground shrink-0" />
        <span className="font-medium text-sm flex-1 truncate" title={repo.localPath}>{repo.localPath}</span>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onDeleteRepo(repo.id)} disabled={isDeleting} title="레포 삭제"><Trash2 className="w-4 h-4" /></Button>
      </div>
      {sessions && sessions.length > 0 ? (
        <div className="ml-6 space-y-1 border-l pl-3 max-h-[32vh] overflow-y-auto pr-1">
          {sessions.map((s: any) => {
            const sid = s.id as string;
            const title = (s.title as string) || 'Untitled';
            const checked = selectedSessions.has(sid) || isSelected;
            const isEditing = editingSid === sid;
            return (
              <div key={sid} className="flex items-center gap-2 text-xs py-1 hover:bg-accent rounded px-1">
                <Checkbox checked={checked} onCheckedChange={(v) => onSessionChecked(sid, v === true)} />
                <MessageSquare className="w-3 h-3 text-muted-foreground shrink-0" />
                {isEditing ? (
                  <div className="flex-1 flex items-center gap-1 min-w-0">
                    <Input value={editingTitle} onChange={e => setEditingTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleSessionRename(sid); if (e.key === 'Escape') setEditingSid(null) }} className="h-6 text-xs flex-1" autoFocus />
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleSessionRename(sid)} title="저장"><Check className="w-3 h-3" /></Button>
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setEditingSid(null)} title="취소"><X className="w-3 h-3" /></Button>
                  </div>
                ) : (
                  <>
                    <span className="flex-1 truncate">{title}</span>
                    <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => { setEditingSid(sid); setEditingTitle(title) }} title="이름 변경"><span className="text-[10px] font-bold text-muted-foreground">Aa</span></Button>
                    <button
                      className="p-1 rounded hover:bg-background shrink-0"
                      onClick={(e) => {
                        e.preventDefault();
                        fetch(`${OPENCODE_API_ENDPOINT}/session/${sid}?directory=${encodeURIComponent(repo.workspaceRel || '')}`, { method: 'DELETE' })
                          .then(() => window.location.reload())
                          .catch(() => {})
                      }}
                      title="세션 개별 삭제"
                    >
                      <Trash2 className="w-3 h-3 text-muted-foreground" />
                    </button>
                  </>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="ml-6 text-xs text-muted-foreground">세션 없음</div>
      )}
    </div>
  )
}
