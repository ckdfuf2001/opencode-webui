import { BackButton } from "@/components/ui/back-button";
import { ContextUsageIndicator } from "@/components/session/ContextUsageIndicator";
import { BranchSwitcher } from "@/components/repo/BranchSwitcher";
import { Button } from "@/components/ui/button";
import { Loader2, Settings, FolderOpen, Briefcase, ShieldCheck, ShieldAlert } from "lucide-react";
import { useState } from "react";

interface Repo {
  id: number;
  repoUrl?: string | null;
  fullPath: string;
  localPath: string;
  currentBranch?: string;
  isWorktree?: boolean;
  isLocal?: boolean;
  cloneStatus: 'ready' | 'cloning' | 'error';
}

interface SessionDetailHeaderProps {
  repo: Repo;
  sessionId: string;
  sessionTitle: string;
  repoId: number;
  isConnected: boolean;
  isReconnecting?: boolean;
  isStreaming?: boolean;
  /** 이 세션(+하위)의 승인 대기 권한 수. 세션 리스트의 방패 배지와 동일한 데이터. */
  pendingPermissions?: number;
  opcodeUrl: string | null;
  repoDirectory: string | undefined;
  onFileBrowserOpen: () => void;
  onSettingsOpen: () => void;
  onCommandsOpen: () => void;
  onPermissionRulesOpen: () => void;
  onSessionTitleUpdate: (newTitle: string) => void;
}

export function SessionDetailHeader({
  repo,
  sessionId,
  sessionTitle,
  repoId,
  isConnected,
  isReconnecting,
  isStreaming,
  pendingPermissions = 0,
  opcodeUrl,
  repoDirectory,
  onFileBrowserOpen,
  onSettingsOpen,
  onCommandsOpen,
  onPermissionRulesOpen,
  onSessionTitleUpdate,
}: SessionDetailHeaderProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(sessionTitle);
  const isWorking = isStreaming;

  if (repo.cloneStatus !== 'ready') {
    return (
      <div className="sticky top-0 z-10 border-b border-border bg-gradient-to-b from-background via-background to-background backdrop-blur-sm px-2 sm:px-4 py-1.5 sm:py-2">
        <div className="flex items-center justify-center">
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground mr-2" />
          <span className="text-sm text-muted-foreground">
            {repo.cloneStatus === 'cloning' ? 'Cloning repository...' : 'Repository not ready'}
          </span>
        </div>
      </div>
    );
  }

  const repoName = repo.repoUrl?.split("/").pop()?.replace(".git", "") || repo.localPath || "Repository";
  const currentBranch = repo.currentBranch || "main";

  const handleTitleClick = () => {
    setIsEditing(true);
    setEditTitle(sessionTitle);
  };

  const handleTitleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editTitle.trim() && editTitle !== sessionTitle) {
      onSessionTitleUpdate(editTitle.trim());
    }
    setIsEditing(false);
  };

  const handleTitleBlur = () => {
    if (editTitle.trim() && editTitle !== sessionTitle) {
      onSessionTitleUpdate(editTitle.trim());
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setEditTitle(sessionTitle);
      setIsEditing(false);
    } else if (e.key === 'Enter') {
      handleTitleSubmit(e);
    }
  };

  return (
    <div className="sticky top-0 z-10 border-b border-border bg-gradient-to-b from-background via-background to-background backdrop-blur-sm px-2 sm:px-4 py-1.5 sm:py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 sm:gap-3 min-w-0 flex-1">
          <BackButton to={`/repos/${repoId}`} className="text-xs sm:text-sm" />
          <div className="min-w-0 flex-1">
            <p className="text-[10px] sm:text-xs text-muted-foreground truncate">
              {repoName}
            </p>
            {isEditing ? (
              <form onSubmit={handleTitleSubmit} className="min-w-0">
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={handleTitleBlur}
                  onKeyDown={handleKeyDown}
                  className="text-[16px] sm:text-base font-semibold bg-background border border-border rounded px-1 outline-none w-full truncate focus:border-primary sm:max-w-[250px]"
                  autoFocus
                />
              </form>
            ) : (
              <h1
                className="text-xs sm:text-base font-semibold bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent truncate cursor-pointer hover:opacity-80 transition-opacity"
                onClick={handleTitleClick}
              >
                {sessionTitle}
              </h1>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 sm:gap-4 flex-shrink-0">
            <ContextUsageIndicator
              opcodeUrl={opcodeUrl}
              sessionID={sessionId}
              directory={repoDirectory}
            />
          <BranchSwitcher
            repoId={repoId}
            currentBranch={currentBranch}
            isWorktree={repo.isWorktree}
            repoUrl={repo.repoUrl}
            repoLocalPath={repo.localPath}
          />
          <div className="flex items-center gap-1 sm:gap-2">
            <div
              className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${
                isConnected 
                  ? "bg-green-500" 
                  : isReconnecting 
                    ? "bg-yellow-500 animate-pulse" 
                    : "bg-red-500"
              }`}
            />
            <span className="text-xs text-muted-foreground hidden sm:inline">
              {isConnected ? "Connected" : isReconnecting ? "Reconnecting..." : "Disconnected"}
            </span>
          </div>
          {isWorking && (
            <div
              className="flex items-center gap-1 rounded-full bg-blue-500/10 border border-blue-500/30 px-2 py-0.5"
              title="LLM is answering"
            >
              <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500" />
              <span className="text-xs text-blue-500 font-medium hidden sm:inline">Working</span>
            </div>
          )}
          {pendingPermissions > 0 && (
            <div
              className="flex items-center gap-1 rounded-full bg-amber-500/10 border border-amber-500/30 px-2 py-0.5"
              title={`${pendingPermissions} permission request(s) awaiting approval`}
            >
              <ShieldAlert className="w-3.5 h-3.5 text-amber-500" />
              <span className="text-xs text-amber-500 font-medium hidden sm:inline">{pendingPermissions}</span>
            </div>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={onFileBrowserOpen}
            className="text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 h-8 w-8"
          >
            <FolderOpen className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onCommandsOpen}
            className="text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 h-8 w-8"
            title="Desks"
          >
            <Briefcase className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onPermissionRulesOpen}
            className="text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 h-8 w-8"
            title="Auto-Approved Permissions"
          >
            <ShieldCheck className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onSettingsOpen}
            className="text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 h-8 w-8"
          >
            <Settings className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
