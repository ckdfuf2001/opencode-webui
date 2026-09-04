import { BackButton } from "@/components/ui/back-button";
import { ContextUsageIndicator } from "@/components/session/ContextUsageIndicator";
import { BranchSwitcher } from "@/components/repo/BranchSwitcher";
import { Button } from "@/components/ui/button";
import { Loader2, Settings, FolderOpen, Briefcase, ShieldCheck, ShieldAlert, Volume2, VolumeX, Bell, BellOff } from "lucide-react";
import { useState, useEffect } from "react";
import { getSessionOverride, setSessionOverride, isPushSupported } from "@/lib/notifications";
import { useSettings } from "@/hooks/useSettings";

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
  onNavOpen?: () => void;
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
  onNavOpen,
}: SessionDetailHeaderProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(sessionTitle);
  const isWorking = isStreaming;
  const { preferences } = useSettings();
  const [sessionSoundOverride, setSessionSoundOverride] = useState<boolean | undefined>(undefined);
  const [sessionPushOverride, setSessionPushOverride] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    const ov = getSessionOverride(sessionId);
    setSessionSoundOverride(ov.soundEnabled);
    setSessionPushOverride(ov.pushEnabled);
    const handler = () => {
      const o = getSessionOverride(sessionId);
      setSessionSoundOverride(o.soundEnabled);
      setSessionPushOverride(o.pushEnabled);
    };
    window.addEventListener('opencode:session-notify-changed', handler);
    return () => window.removeEventListener('opencode:session-notify-changed', handler);
  }, [sessionId]);
  const globalSoundOn = preferences?.completionSoundEnabled !== false;
  const globalPushOn = preferences?.pushNotificationEnabled === true;
  const effectiveSoundOn = sessionSoundOverride === false ? false : sessionSoundOverride === true ? true : globalSoundOn;
  const effectivePushOn = sessionPushOverride === false ? false : sessionPushOverride === true ? true : globalPushOn;

  useEffect(() => {
    if (sessionStorage.getItem(`newSessionFocus:${sessionId}`)) {
      sessionStorage.removeItem(`newSessionFocus:${sessionId}`)
      setIsEditing(true)
      setEditTitle(sessionTitle)
    }
  }, [sessionId])

  if (repo.cloneStatus !== 'ready') {
    return (
      <div className="sticky top-0 z-30 border-b border-border bg-gradient-to-b from-background via-background to-background backdrop-blur-sm px-2 sm:px-4 py-1.5 sm:py-2">
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
    <div className="sticky top-0 z-30 border-b border-border bg-gradient-to-b from-background via-background to-background backdrop-blur-sm px-2 sm:px-4 py-1.5 sm:py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 sm:gap-3 min-w-0 flex-1">
          <BackButton to={`/repos/${repoId}`} onClick={onNavOpen} className="text-xs sm:text-sm" />
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
          <div className="inline-flex items-center rounded-md border border-border overflow-hidden">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setSessionOverride(sessionId, { soundEnabled: effectiveSoundOn ? false : true });
              }}
              className={`hover:bg-accent transition-all duration-200 h-8 w-8 rounded-none border-r border-border ${effectiveSoundOn ? 'text-foreground' : 'text-muted-foreground opacity-60'}`}
              title={effectiveSoundOn ? '세션 소리 끄기 (글로벌: ' + (globalSoundOn ? 'ON' : 'OFF') + ')' : '세션 소리 켜기 (글로벌: ' + (globalSoundOn ? 'ON' : 'OFF') + ')'}
            >
              {effectiveSoundOn ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                if (!isPushSupported()) return;
                setSessionOverride(sessionId, { pushEnabled: effectivePushOn ? false : true });
              }}
              className={`hover:bg-accent transition-all duration-200 h-8 w-8 rounded-none border-r border-border ${effectivePushOn ? 'text-foreground' : 'text-muted-foreground opacity-60'}`}
              title={effectivePushOn ? '세션 푸시 끄기 (글로벌: ' + (globalPushOn ? 'ON' : 'OFF') + ')' : '세션 푸시 켜기 (글로벌: ' + (globalPushOn ? 'ON' : 'OFF') + ')'}
              disabled={!isPushSupported()}
            >
              {effectivePushOn ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onFileBrowserOpen}
              className="text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 h-8 w-8 rounded-none border-r border-border"
              title="Files"
            >
              <FolderOpen className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onCommandsOpen}
              className="text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 h-8 w-8 rounded-none border-r border-border"
              title="Commands"
            >
              <Briefcase className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onPermissionRulesOpen}
              className="text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 h-8 w-8 rounded-none border-r border-border"
              title="Auto-Approved Permissions"
            >
              <ShieldCheck className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onSettingsOpen}
              className="text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 h-8 w-8 rounded-none"
              title="Settings"
            >
              <Settings className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
