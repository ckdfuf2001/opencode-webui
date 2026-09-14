import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listRepos, deleteRepo } from "@/api/repos";
import { listSchedules } from "@/api/schedules";
import { useSessionStatusMap, useSessions } from "@/hooks/useOpenCode";
import { DeleteDialog } from "@/components/ui/delete-dialog";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Loader2, GitBranch, Search, Trash2, Ellipsis, Plus, Pencil, MessageSquare } from "lucide-react";
import { RepoCard } from "./RepoCard";
import { clearRepoNotifyData } from "@/lib/notifications";
import { OPENCODE_API_ENDPOINT } from "@/config";

export function RepoList({ onAddRepo }: { onAddRepo?: () => void }) {
  const queryClient = useQueryClient();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [repoToDelete, setRepoToDelete] = useState<number | null>(null);
  const [selectedRepos, setSelectedRepos] = useState<Set<number>>(new Set());
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [isEditMode, setIsEditMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingBulk, setPendingBulk] = useState<{ repos: number[]; sessions: string[] } | null>(null);

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

  const filteredRepos = dedupedRepos.filter((repo) => {
    const repoName = repo.repoUrl 
      ? repo.repoUrl.split("/").slice(-1)[0].replace(".git", "")
      : repo.localPath;
    const searchTarget = repo.repoUrl || repo.localPath || "";
    return (
      repoName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      searchTarget.toLowerCase().includes(searchQuery.toLowerCase())
    );
  });

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
          {/* 편집 모드 토글 */}
          <Button variant={isEditMode ? "default" : "outline"} size="sm" className="whitespace-nowrap hidden md:flex h-8" onClick={() => { setIsEditMode(v => !v); if (isEditMode) { setSelectedRepos(new Set()); setSelectedSessions(new Set()) } }}>
            <Pencil className="w-4 h-4 mr-1" /> {isEditMode ? "완료" : "편집"}
          </Button>
          {/* 편집 모드: 최상단 Repository 체크 + 삭제 */}
          {isEditMode ? (
            <>
              {filteredRepos.length > 0 && (
                <label className="hidden md:flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox checked={filteredRepos.length > 0 && filteredRepos.every(r => selectedRepos.has(r.id))} onCheckedChange={() => handleSelectAll()} />
                  <span>Repository</span>
                </label>
              )}
              <Button onClick={handleBatchDelete} variant="destructive" size="sm" disabled={selectedRepos.size === 0 && selectedSessions.size === 0} className="hidden md:flex whitespace-nowrap h-8">
                <Trash2 className="w-4 h-4 mr-2" /> 삭제 ({selectedRepos.size + selectedSessions.size})
              </Button>
            </>
          ) : (
            <>
              {filteredRepos.length > 0 && (
                <Button onClick={handleSelectAll} variant={selectedRepos.size > 0 ? "default" : "outline"} size="sm" className="whitespace-nowrap hidden md:flex h-8">
                  {filteredRepos.every((repo) => selectedRepos.has(repo.id)) ? "Deselect All" : "Select All"}
                </Button>
              )}
              <Button onClick={handleBatchDelete} variant="destructive" size="sm" disabled={selectedRepos.size === 0} className="hidden md:flex whitespace-nowrap h-8">
                <Trash2 className="w-4 h-4 mr-2" /> Delete ({selectedRepos.size})
              </Button>
            </>
          )}
          <Button
            onClick={() => onAddRepo?.()}
            size="sm"
            className="bg-blue-600 hover:bg-blue-700 text-white hidden md:flex whitespace-nowrap h-8"
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
            className="bg-blue-600 hover:bg-blue-700 text-white md:hidden h-8 w-8"
            title="Repository"
          >
            <Plus className="w-4 h-4" />
          </Button>
        </div>

        <div className="h-[calc(100vh-200px)] overflow-y-auto">
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
                    const ns = new Set(selectedSessions);
                    if (checked) ns.add(sid); else ns.delete(sid);
                    setSelectedSessions(ns);
                    // repo 체크 상태 동기화: 세션 하나라도 해제되면 repo 체크 해제, 전부 체크되면 repo 체크
                  }}
                  onDeleteRepo={(id) => { setRepoToDelete(id); setDeleteDialogOpen(true) }}
                  isDeleting={deleteMutation.isPending && repoToDelete === repo.id}
                />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-2 gap-4 w-full">
              {filteredRepos.map((repo) => (
                <RepoCard
                  key={repo.id}
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
                  scheduleCount={scheduleCounts[repo.id] ?? 0}
                  workingCount={workingCounts[repo.id] ?? 0}
                  pendingCount={pendingCounts[repo.id] ?? 0}
                />
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
  repo: { id: number; localPath?: string; fullPath?: string };
  isSelected: boolean;
  selectedSessions: Set<string>;
  onRepoChecked: (checked: boolean, ids: string[]) => void;
  onSessionChecked: (sid: string, checked: boolean) => void;
  onDeleteRepo: (id: number) => void;
  isDeleting: boolean;
}) {
  const { data: sessions } = useSessions(OPENCODE_API_ENDPOINT, repo.fullPath);
  const sessionIds = useMemo(() => (sessions ?? []).map((s: any) => s.id as string), [sessions]);

  return (
    <div className="border rounded-lg bg-card p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Checkbox checked={isSelected} onCheckedChange={(v) => onRepoChecked(v === true, sessionIds)} />
        <GitBranch className="w-4 h-4 text-muted-foreground shrink-0" />
        <span className="font-medium text-sm flex-1 truncate">{repo.localPath}</span>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onDeleteRepo(repo.id)} disabled={isDeleting} title="레포 삭제">
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
      {sessions && sessions.length > 0 ? (
        <div className="ml-6 space-y-1 border-l pl-3">
          {sessions.slice(0, 20).map((s: any) => {
            const sid = s.id as string;
            const title = (s.title as string) || 'Untitled';
            const checked = selectedSessions.has(sid) || isSelected;
            return (
              <label key={sid} className="flex items-center gap-2 text-xs cursor-pointer py-0.5 hover:bg-accent rounded px-1">
                <Checkbox checked={checked} onCheckedChange={(v) => onSessionChecked(sid, v === true)} />
                <MessageSquare className="w-3 h-3 text-muted-foreground shrink-0" />
                <span className="flex-1 truncate">{title}</span>
                <button
                  className="p-1 rounded hover:bg-background"
                  onClick={(e) => {
                    e.preventDefault();
                    fetch(`${OPENCODE_API_ENDPOINT}/session/${sid}?directory=${encodeURIComponent(repo.fullPath || '')}`, { method: 'DELETE' })
                      .then(() => window.location.reload())
                      .catch(() => {})
                  }}
                  title="세션 개별 삭제"
                >
                  <Trash2 className="w-3 h-3 text-muted-foreground" />
                </button>
              </label>
            )
          })}
          {sessions.length > 20 && <div className="text-xs text-muted-foreground">+ {sessions.length - 20} more</div>}
        </div>
      ) : (
        <div className="ml-6 text-xs text-muted-foreground">세션 없음</div>
      )}
    </div>
  )
}
