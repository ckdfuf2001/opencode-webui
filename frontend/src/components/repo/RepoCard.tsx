import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Loader2, Trash2, GitBranch, ExternalLink, CalendarClock, ShieldAlert, Copy, Download, Ellipsis, Star } from "lucide-react";
import { Link } from "react-router-dom";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScheduleSettingsDialog } from "@/components/schedule/ScheduleSettingsDialog";
import { BranchSwitcher } from "./BranchSwitcher";
import { OPENCODE_API_ENDPOINT } from "@/config";
import { cloneRepo, exportRepo } from "@/api/repos";
import { cloneRepoNotifyData } from "@/lib/notifications";
import { showToast } from "@/lib/toast";
import { listFavorites, addFavorite, removeFavorite } from "@/api/favorites";

interface RepoCardProps {
  repo: {
    id: number;
    repoUrl?: string | null;
    localPath?: string;
    fullPath?: string;
    workspaceRel: string;
    branch?: string;
    currentBranch?: string;
    cloneStatus: string;
    isWorktree?: boolean;
    isLocal?: boolean;
  };
  onDelete: (id: number) => void;
  isDeleting: boolean;
  isSelected?: boolean;
  onSelect?: (id: number, selected: boolean) => void;
  scheduleCount?: number;
  workingCount?: number;
  pendingCount?: number;
}

export function RepoCard({
  repo,
  onDelete,
  isDeleting,
  isSelected = false,
  onSelect,
  scheduleCount = 0,
  workingCount = 0,
  pendingCount = 0,
}: RepoCardProps) {
  const queryClient = useQueryClient();
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const { data: favs } = useQuery({ queryKey: ['favorites'], queryFn: listFavorites });
  const favId = `repo-${repo.id}`;
  const isFav = favs?.some(f => f.sessionId === favId);
  const cloneMut = useMutation({
    mutationFn: async () => {
      const newName = window.prompt(`복제할 새 레포 이름 (디렉토리명):`, `${repo.localPath}-copy`)
      if (!newName) throw new Error('cancelled')
      const withIndex = window.confirm('리콜 인덱스(커밋/대화 검색 기록)도 복사할까요?\n[확인]=복사, [취소]=파일·설정만')
      const withSchedules = window.confirm('스케줄(예약 실행)도 복사할까요?\n[확인]=복사, [취소]=제외')
      const created = await cloneRepo(repo.id, newName.trim(), { withIndex, withSchedules })
      try { cloneRepoNotifyData(repo.id, created.id) } catch {}
      return created
    },
    onSuccess: (data: any) => {
      const stats = data?._cloneStats
      queryClient.invalidateQueries({ queryKey: ["repos"] })
      queryClient.invalidateQueries({ queryKey: ["schedules"] })
      showToast.success(stats ? `레포 복제 완료 (파일:${stats.copiedFiles} 규칙:${stats.copiedRules} 스케줄:${stats.copiedSchedules} 인덱스:${stats.copiedCommits + stats.copiedMessages})` : '레포 복제 완료 (skill/커맨드/스케줄/인덱스 포함)')
    },
    onError: (e: any) => { if (e.message !== 'cancelled') showToast.error(e.message) },
  })
  const exportMut = useMutation({
    mutationFn: async () => {
      const withIndex = window.confirm('Export에 리콜 인덱스(커밋/대화 검색 기록)도 포함할까요?\n[확인]=포함, [취소]=파일·설정만')
      return exportRepo(repo.id, { withIndex })
    },
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${repo.localPath}-export-${Date.now()}.json`
      a.click()
      URL.revokeObjectURL(url)
      const stats = (data as any)?.stats
      showToast.success(stats ? `Export 완료 (파일:${stats.files} 스케줄:${stats.schedules} 인덱스:${stats.commits + stats.messages})` : 'Export 다운로드 완료')
    },
    onError: (e: any) => showToast.error(e.message),
  })
  const repoName = repo.repoUrl 
    ? repo.repoUrl.split("/").slice(-1)[0].replace(".git", "")
    : repo.localPath || "Local Repo";
  const branchToDisplay = repo.currentBranch || repo.branch;
  const isReady = repo.cloneStatus === "ready";

  const handleScheduleOpenChange = (next: boolean) => {
    setScheduleOpen(next);
    if (!next) {
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
    }
  };

  return (
    <div
      className={`group relative bg-gradient-to-br from-card to-card-hover border rounded-xl overflow-hidden transition-all duration-200 hover:shadow-lg w-full ${
        isSelected
          ? "border-blue-500 shadow-lg shadow-blue-900/30"
          : "border-border hover:border-border hover:shadow-blue-900/20"
      }`}
    >
       <div className="p-2 sm:p-6">
         <div className="mb-4">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2 min-w-0">
 {onSelect && (
                <Checkbox
                  id="select-repo"
                  checked={isSelected}
                  onCheckedChange={(checked) => {
                    onSelect(repo.id, checked === true);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                  className="w-5 h-5"
                />
              )}
 <h3
                 onClick={(e) => {
                   e.stopPropagation();
                   if (onSelect) {
                     onSelect(repo.id, !isSelected);
                   }
                 }}
                 className={`font-semibold text-lg text-foreground truncate group-hover:text-blue-400 transition-colors ${
                   onSelect ? "cursor-pointer" : "cursor-not-allowed opacity-60"
                 }`}
               >
                  #{repo.id}. {repoName}
                </h3>
              {branchToDisplay && (repo.isWorktree ? (
                <span
                  className="inline-flex items-center gap-1 mt-0.5 text-[10px] font-medium text-muted-foreground bg-muted/60 border border-border rounded-full px-2 py-0.5 flex-shrink-0"
                  title={`Current branch: ${branchToDisplay}`}
                >
                  <GitBranch className="w-3 h-3" />
                  <span className="max-w-[140px] truncate">{branchToDisplay}</span>
                </span>
              ) : (
                <span onClick={(e) => e.stopPropagation()} className="flex-shrink-0 mt-0.5" title={`Current branch: ${branchToDisplay}`}>
                  <BranchSwitcher
                    repoId={repo.id}
                    currentBranch={branchToDisplay}
                    isWorktree={repo.isWorktree}
                    repoUrl={repo.repoUrl}
                    repoLocalPath={repo.localPath}
                  />
                </span>
              ))}
             {repo.isWorktree && (
              <Badge
                className="text-xs px-2.5 py-0.5 bg-purple-600/20 text-purple-400 border-purple-600/40"
              >
                worktree
              </Badge>
            )}
            {repo.cloneStatus === "cloning" && (
              <Badge
                className="text-xs px-2.5 py-0.5 bg-blue-600/20 text-blue-400 border-blue-600/40"
              >
                cloning
              </Badge>
            )}
            {workingCount > 0 && (
              <div
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-blue-500/30 bg-blue-500/10"
                title={`${workingCount} session(s) working`}
              >
                <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500" />
                <span className="text-xs font-medium text-blue-500 tabular-nums">{workingCount}</span>
              </div>
            )}
            {pendingCount > 0 && (
              <div
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-amber-500/30 bg-amber-500/10"
                title={`${pendingCount} permission request(s) awaiting approval`}
              >
                <ShieldAlert className="w-3.5 h-3.5 text-amber-500" />
                <span className="text-xs font-medium text-amber-500 tabular-nums">{pendingCount}</span>
              </div>
            )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button variant="ghost" size="icon" className={`h-7 w-7 ${isFav ? 'text-amber-500' : ''}`} onClick={async (e) => { e.stopPropagation(); try { if (isFav) await removeFavorite(favId); else await addFavorite({ sessionId: favId, repoId: repo.id, directory: repo.workspaceRel || '', title: repo.localPath || `repo-${repo.id}` }); showToast.success(isFav ? '즐겨찾기 해제' : '즐겨찾기 등록'); queryClient.invalidateQueries({ queryKey: ['favorites'] }) } catch (err:any){ showToast.error(err.message) } }} title={isFav ? '즐겨찾기 해제' : '즐겨찾기 등록'}>
                  <Star className={`w-4 h-4 ${isFav ? 'fill-amber-500' : ''}`} />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={(e) => e.stopPropagation()}>
                      <Ellipsis className="w-4 h-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenuItem onClick={() => cloneMut.mutate()} disabled={!isReady || cloneMut.isPending}>
                      <Copy className="w-4 h-4 mr-2" /> Clone (skill/커맨드/설정/인덱스)
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => exportMut.mutate()} disabled={!isReady || exportMut.isPending}>
                      <Download className="w-4 h-4 mr-2" /> Export 설정+인덱스
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
          </div>
        </div>

        

        <div className="flex flex-col gap-2">
          {repo.cloneStatus === "cloning" && (
            <div className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin text-blue-400" />
              <span>Cloning repository...</span>
            </div>
          )}
          <div className="flex gap-2 flex-wrap">
            {isReady ? (
              <Button
                size="sm"
                asChild
                className="cursor-pointer flex-1 h-10 sm:h-9 px-3"
              >
                <Link
                  to={`/repos/${repo.id}`}
                  onClick={(e) => {
                    // 카드 onClick보다 우선 (뒤 클릭과 중복 네비게이션 방지).
                    // 수식키·중클릭은 네이티브 새 탭 처리.
                    e.stopPropagation();
                  }}
                >
                  <ExternalLink className="w-4 h-4 mr-2" />
                  Open
                </Link>
              </Button>
            ) : (
              <Button
                size="sm"
                disabled
                className="cursor-pointer flex-1 h-10 sm:h-9 px-3"
              >
                <ExternalLink className="w-4 h-4 mr-2" />
                Open
              </Button>
            )}
	    

            <Button
              size="sm"
              variant="outline"
              onClick={(e) => {
                e.stopPropagation();
                setScheduleOpen(true);
              }}
              disabled={!isReady}
              className="h-10 sm:h-9 px-2 gap-1"
              title="Schedules"
            >
              <CalendarClock className="w-4 h-4" />
              <span className="text-xs tabular-nums">{scheduleCount}</span>
            </Button>

            <Button
              size="sm"
              variant="destructive"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(repo.id);
              }}
              disabled={isDeleting}
              className="h-10 sm:h-9 w-10 p-0"
            >
              {isDeleting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
            </Button>          </div>
        </div>
      </div>

      <ScheduleSettingsDialog
        open={scheduleOpen}
        onOpenChange={handleScheduleOpenChange}
        repoId={repo.id}
        opcodeUrl={OPENCODE_API_ENDPOINT}
        directory={repo.workspaceRel}
      />
    </div>
  );
}
