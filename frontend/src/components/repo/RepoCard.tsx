import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Trash2, GitBranch, ExternalLink, CalendarClock } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AddBranchWorkspaceDialog } from "./AddBranchWorkspaceDialog";
import { ScheduleSettingsDialog } from "@/components/schedule/ScheduleSettingsDialog";
import { OPENCODE_API_ENDPOINT } from "@/config";

interface RepoCardProps {
  repo: {
    id: number;
    repoUrl?: string | null;
    localPath?: string;
    fullPath?: string;
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
}

export function RepoCard({
  repo,
  onDelete,
  isDeleting,
  isSelected = false,
  onSelect,
  scheduleCount = 0,
  workingCount = 0,
}: RepoCardProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [addBranchOpen, setAddBranchOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
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
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          window.open(`${window.location.origin}/repos/${repo.id}`, '_blank');
          return;
        }
        if (isReady && !e.defaultPrevented) {
          navigate(`/repos/${repo.id}`);
        }
      }}
      className={`group relative bg-gradient-to-br from-card to-card-hover border rounded-xl overflow-hidden transition-all duration-200 hover:shadow-lg w-full cursor-pointer ${
        isSelected
          ? "border-blue-500 shadow-lg shadow-blue-900/30"
          : "border-border hover:border-border hover:shadow-blue-900/20"
      }`}
    >
      <div className="p-2 sm:p-6">
         <div className="mb-4">
           <div className="flex items-center gap-2 mb-2">
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
                 {repoName}
               </h3>
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
          </div>
          <p className="text-sm text-muted-foreground truncate flex items-center gap-1">
              <GitBranch className="w-3 h-3" />
              {branchToDisplay}
            </p>
        </div>

        

        <div className="flex flex-col gap-2">
          {repo.cloneStatus === "cloning" && (
            <div className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin text-blue-400" />
              <span>Cloning repository...</span>
            </div>
          )}
          <div className="flex gap-2 flex-wrap">
              <Button
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                if (e.ctrlKey || e.metaKey) {
                  window.open(`${window.location.origin}/repos/${repo.id}`, '_blank');
                  return;
                }
                navigate(`/repos/${repo.id}`);
              }}
              disabled={!isReady}
              className="cursor-pointer flex-1 h-10 sm:h-9 px-3"
            >
              <ExternalLink className="w-4 h-4 mr-2" />
              Open
            </Button>
	    

              <Button
                size="sm"
									
                variant="outline"
                onClick={(e) => {
                  e.stopPropagation();
                  setAddBranchOpen(true);
                }}
                disabled={!isReady || !repo.repoUrl}
                className="h-10 sm:h-9 w-10 p-0"
              >
                <GitBranch className="w-4 h-4" />
              </Button>

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

            {workingCount > 0 && (
              <div
                className="inline-flex items-center gap-1 h-10 sm:h-9 px-2 rounded-md border border-blue-500/30 bg-blue-500/10"
                title={`${workingCount} session(s) working`}
              >
                <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                <span className="text-xs font-medium text-blue-500 tabular-nums">{workingCount}</span>
              </div>
            )}

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

      {repo.repoUrl && (
        <AddBranchWorkspaceDialog
          open={addBranchOpen}
          onOpenChange={setAddBranchOpen}
          repoUrl={repo.repoUrl}
        />
      )}

      <ScheduleSettingsDialog
        open={scheduleOpen}
        onOpenChange={handleScheduleOpenChange}
        repoId={repo.id}
        opcodeUrl={OPENCODE_API_ENDPOINT}
        directory={repo.fullPath}
      />
    </div>
  );
}
