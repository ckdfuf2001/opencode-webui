import { useState, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRepo } from "@/api/repos";
import { SessionList } from "@/components/session/SessionList";
import { SessionFilePanel } from "@/components/file-browser/SessionFilePanel";
import { FileBrowserSheet } from "@/components/file-browser/FileBrowserSheet";
import { CommandsPanel } from "@/components/command/CommandsPanel";
import { BranchSwitcher } from "@/components/repo/BranchSwitcher";
import { SwitchConfigDialog } from "@/components/repo/SwitchConfigDialog";
import { BackButton } from "@/components/ui/back-button";
import { useCreateSession, useOpenCodeClient } from "@/hooks/useOpenCode";
import { useLoadPendingPermissions } from "@/hooks/usePermissionRequests";
import { useLoadPendingQuestions } from "@/hooks/useQuestionRequests";
import { useSettingsDialog } from "@/hooks/useSettingsDialog";
import { OPENCODE_API_ENDPOINT } from "@/config";
import { ScheduleSettingsDialog } from "@/components/schedule/ScheduleSettingsDialog";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, FolderOpen, GitBranch, Terminal, CalendarPlus, Settings } from "lucide-react";

export function RepoDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const repoId = parseInt(id || "0");
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [fileBrowserFullscreenOpen, setFileBrowserFullscreenOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [switchConfigOpen, setSwitchConfigOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [filePanelWidth, setFilePanelWidth] = useState(380);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const { open: openSettings } = useSettingsDialog();

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const container = splitContainerRef.current
    if (!container) return

    const onMove = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect()
      const nextWidth = Math.min(Math.max(rect.right - ev.clientX, 260), rect.width * 0.6)
      setFilePanelWidth(nextWidth)
    }

    const onUp = () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const { data: repo, isLoading: repoLoading } = useQuery({
    queryKey: ["repo", repoId],
    queryFn: () => getRepo(repoId),
    enabled: !!repoId,
  });

  

  const opcodeUrl = OPENCODE_API_ENDPOINT;
  
  const repoDirectory = repo?.fullPath;
  const openCodeClient = useOpenCodeClient(opcodeUrl, repoDirectory);
  useLoadPendingPermissions(openCodeClient);
  useLoadPendingQuestions(openCodeClient);

  const createSessionMutation = useCreateSession(opcodeUrl, repoDirectory);

  const handleCreateSession = async (options?: {
    agentSlug?: string;
    promptSlug?: string;
  }) => {
    const session = await createSessionMutation.mutateAsync({
      agent: options?.agentSlug,
    });
    navigate(`/repos/${repoId}/sessions/${session.id}`);
  };

  const handleSelectSession = (sessionId: string) => {
    navigate(`/repos/${repoId}/sessions/${sessionId}`);
  };

  if (repoLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!repo) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <p className="text-muted-foreground">
          Repository not found
        </p>
      </div>
    );
  }
  
  if (repo.cloneStatus !== 'ready') {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">
            {repo.cloneStatus === 'cloning' ? 'Cloning repository...' : 'Repository not ready'}
          </p>
        </div>
      </div>
    );
  }

  const repoName = repo.repoUrl
    ? repo.repoUrl.split("/").pop()?.replace(".git", "") || "Repository"
    : repo.localPath || "Local Repository";
  const branchToDisplay = repo.currentBranch || repo.branch;
  const isNotMainBranch = branchToDisplay && branchToDisplay !== repo.defaultBranch;
  const currentBranch = repo.currentBranch || "main";

  return (
    <div className="h-screen bg-gradient-to-br from-background via-background to-background flex flex-col">
      <div className="sticky top-0 z-10 border-b border-border bg-gradient-to-b from-background via-background to-background backdrop-blur-sm px-4 py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BackButton />
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent">
                {repoName}
              </h1>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setScheduleOpen(true)}
                className="text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 h-7 w-7"
                title="Schedules"
              >
                <CalendarPlus className="w-4 h-4" />
              </Button>
              {!repo.isWorktree && branchToDisplay ? (
                <BranchSwitcher
                  repoId={repoId}
                  currentBranch={currentBranch}
                  isWorktree={repo.isWorktree}
                  repoUrl={repo.repoUrl}
                />
              ) : branchToDisplay ? (
                <Badge
                  className={`text-xs px-2.5 py-0.5 ${
                    repo.isWorktree
                      ? "bg-purple-600/20 text-purple-400 border-purple-600/40"
                      : isNotMainBranch
                      ? "bg-blue-600/20 text-blue-400 border-blue-600/40"
                      : "bg-zinc-600/20 text-zinc-400 border-zinc-600/40"
                  }`}
                  title={repo.isWorktree ? "Worktree" : branchToDisplay}
                >
                  {repo.isWorktree && <GitBranch className="h-3 w-3 mr-1" />}
                  {branchToDisplay}
                </Badge>
              ) : null}
            </div>
          </div>
           <div className="flex items-center gap-2">
             <Button
               variant="ghost"
               size="icon"
               onClick={() => setFileBrowserOpen(true)}
               className="text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 h-8 w-8"
               title="Files"
             >
               <FolderOpen className="w-4 h-4" />
             </Button>
             <Button
               variant="ghost"
               size="icon"
               onClick={() => setCommandsOpen(true)}
               className="text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 h-8 w-8"
               title="Commands"
             >
               <Terminal className="w-4 h-4" />
             </Button>
              <Button
                onClick={() => handleCreateSession()}
                disabled={!opcodeUrl || createSessionMutation.isPending}
                size="sm"
                className="bg-blue-600 hover:bg-blue-700 text-white transition-all duration-200 hover:scale-105"
              >
                <Plus className="w-4 h-4 sm:mr-2" />
                <span className="hidden sm:inline">New Session</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={openSettings}
                className="text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 h-8 w-8"
                title="Settings"
              >
                <Settings className="w-4 h-4" />
              </Button>
           </div>
        </div>
      </div>

      <div ref={splitContainerRef} className="flex-1 overflow-hidden flex relative">
        <div className="flex-1 overflow-hidden min-w-0">
          {opcodeUrl && repoDirectory && (
            <SessionList
              opcodeUrl={opcodeUrl}
              directory={repoDirectory}
              sessionHrefBase={`/repos/${repoId}/sessions`}
              onSelectSession={handleSelectSession}
            />
          )}
        </div>

        {fileBrowserOpen && (
          <div
            className="w-1.5 shrink-0 cursor-col-resize hover:bg-blue-500/50 active:bg-blue-500 transition-colors"
            onMouseDown={handleResizeStart}
            title="Drag to resize"
          />
        )}

        {fileBrowserOpen && (
          <SessionFilePanel
            basePath={repo.localPath}
            repoName={repoName}
            width={filePanelWidth}
            onClose={() => setFileBrowserOpen(false)}
            onOpenFullscreen={() => setFileBrowserFullscreenOpen(true)}
          />
        )}
      </div>

      <CommandsPanel
        open={commandsOpen}
        onClose={() => setCommandsOpen(false)}
        opcodeUrl={opcodeUrl}
        sessionID=""
        directory={repoDirectory}
        repoId={repoId}
      />

        {repo && (
          <SwitchConfigDialog
            open={switchConfigOpen}
            onOpenChange={setSwitchConfigOpen}
            repoId={repoId}
            currentConfigName={repo.openCodeConfigName}
            onConfigSwitched={(configName) => {
              queryClient.setQueryData(["repo", repoId], {
                ...repo,
                openCodeConfigName: configName,
              });
            }}
          />
        )}

        {repo && (
          <ScheduleSettingsDialog
            open={scheduleOpen}
            onOpenChange={setScheduleOpen}
            repoId={repoId}
            opcodeUrl={opcodeUrl}
            directory={repoDirectory}
          />
        )}

        <FileBrowserSheet
          isOpen={fileBrowserFullscreenOpen}
          onClose={() => setFileBrowserFullscreenOpen(false)}
          basePath={repo.localPath}
          repoName={repoName}
        />
    </div>
  );
}
