import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listRepos, deleteRepo } from "@/api/repos";
import { listSchedules } from "@/api/schedules";
import { useSessionStatusMap } from "@/hooks/useOpenCode";
import { useOpencodeHealth } from "@/hooks/useOpencodeHealth";
import { DeleteDialog } from "@/components/ui/delete-dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Loader2, GitBranch, Search, Trash2, MoreHorizontal } from "lucide-react";
import { RepoCard } from "./RepoCard";

export function RepoList() {
  const queryClient = useQueryClient();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [repoToDelete, setRepoToDelete] = useState<number | null>(null);
  const [selectedRepos, setSelectedRepos] = useState<Set<number>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");

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

  const { data: dbStatuses, isError: statusError, isFetching: statusFetching } = useSessionStatusMap();
  const { data: opencodeHealthy, isError: healthError, isFetching: healthFetching } = useOpencodeHealth();
  const isConnected = !healthError && !!opencodeHealthy && !statusError && !!dbStatuses;
  const isReconnecting = (healthError && healthFetching) || (statusError && statusFetching) || (!opencodeHealthy && !healthError);
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repos"] });
      setDeleteDialogOpen(false);
      setRepoToDelete(null);
    },
  });

  const batchDeleteMutation = useMutation({
    mutationFn: async ({ ids, withIndex }: { ids: number[]; withIndex: boolean }) => {
      await Promise.all(ids.map((id) => deleteRepo(id, { withIndex })));
    },
    onSuccess: () => {
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

  if (!repos || repos.length === 0) {
    return (
      <div className="text-center p-12">
        <GitBranch className="w-12 h-12 mx-auto mb-4 text-zinc-600" />
        <p className="text-zinc-500">
          No repositories yet. Add one to get started.
        </p>
      </div>
    );
  }

  const dedupedRepos = repos.reduce((acc, repo) => {
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
  }, [] as typeof repos);

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
    if (selected) {
      newSelected.add(id);
    } else {
      newSelected.delete(id);
    }
    setSelectedRepos(newSelected);
  };

  const handleSelectAll = () => {
    const allFilteredSelected = filteredRepos.every((repo) =>
      selectedRepos.has(repo.id),
    );

    if (allFilteredSelected) {
      setSelectedRepos(new Set());
    } else {
      const filteredIds = filteredRepos.map((repo) => repo.id);
      setSelectedRepos(new Set([...selectedRepos, ...filteredIds]));
    }
  };

  const handleBatchDelete = () => {
    if (selectedRepos.size > 0) {
      setDeleteDialogOpen(true);
    }
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
          <div className="flex items-center gap-1.5 shrink-0">
            <div className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${isConnected ? "bg-green-500" : isReconnecting ? "bg-yellow-500 animate-pulse" : "bg-red-500"}`} />
            <span className="text-xs text-muted-foreground hidden sm:inline">{isConnected ? "Connected" : isReconnecting ? "Reconnecting..." : "Disconnected"}</span>
          </div>
          {filteredRepos.length > 0 && (
            <Button
              onClick={handleSelectAll}
              variant={selectedRepos.size > 0 ? "default" : "outline"}
              className="whitespace-nowrap hidden md:flex"
            >
              {filteredRepos.every((repo) => selectedRepos.has(repo.id))
                ? "Deselect All"
                : "Select All"}
            </Button>
          )}
          <Button
            onClick={handleBatchDelete}
            variant="destructive"
            disabled={selectedRepos.size === 0}
            className="hidden md:flex whitespace-nowrap"
          >
            <Trash2 className="w-4 h-4 mr-2" />
            Delete ({selectedRepos.size})
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="md:hidden"
                disabled={filteredRepos.length === 0}
              >
                <MoreHorizontal className="w-4 h-4" />
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
        </div>

        <div className="h-[calc(100vh-200px)] overflow-y-auto">
          {filteredRepos.length === 0 ? (
            <div className="text-center p-12">
              <Search className="w-12 h-12 mx-auto mb-4 text-zinc-600" />
              <p className="text-zinc-500">
                No repositories found matching "{searchQuery}"
              </p>
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
          } else if (selectedRepos.size > 0) {
            batchDeleteMutation.mutate({ ids: Array.from(selectedRepos), withIndex: wi });
          }
        }}
        onCancel={() => {
          setDeleteDialogOpen(false);
          setRepoToDelete(null);
        }}
        title={
          selectedRepos.size > 0
            ? "Delete Multiple Repositories"
            : "Delete Repository"
        }
        description={
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
