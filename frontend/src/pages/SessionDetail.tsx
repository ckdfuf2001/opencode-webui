import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getRepo } from "@/api/repos";
import { MessageThread } from "@/components/message/MessageThread";
import { PromptInput } from "@/components/message/PromptInput";
import { ModelSelectDialog } from "@/components/model/ModelSelectDialog";
import { SessionDetailHeader } from "@/components/session/SessionDetailHeader";
import { SessionList } from "@/components/session/SessionList";
import { PermissionRequestDialog } from "@/components/session/PermissionRequestDialog";
import { SessionFilePanel } from "@/components/file-browser/SessionFilePanel";
import { CommandsPanel } from "@/components/command/CommandsPanel";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useSession, useAbortSession, useUpdateSession, useOpenCodeClient, useMessages } from "@/hooks/useOpenCode";
import { OPENCODE_API_ENDPOINT, API_BASE_URL } from "@/config";
import { useSSE } from "@/hooks/useSSE";
import { useSettings } from "@/hooks/useSettings";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useSettingsDialog } from "@/hooks/useSettingsDialog";
import { usePermissionRequests } from "@/hooks/usePermissionRequests";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useEffect, useRef, useCallback } from "react";
import { Loader2 } from "lucide-react";
import type { PermissionResponse } from "@/api/types";
import type { CommandWithScope } from "@/hooks/useCommands";
import { showToast } from "@/lib/toast";

interface InjectedFile {
  token: number;
  files: { name: string; path: string }[];
}

export function SessionDetail() {
  const { id, sessionId } = useParams<{ id: string; sessionId: string }>();
  const navigate = useNavigate();
  const repoId = parseInt(id || "0");
  const { preferences, updateSettings } = useSettings();
  const messageContainerRef = useRef<HTMLDivElement>(null);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [sessionsDialogOpen, setSessionsDialogOpen] = useState(false);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [injectedCommand, setInjectedCommand] = useState<{ token: number; text: string; run?: boolean } | null>(null);
  const [injectedFile, setInjectedFile] = useState<InjectedFile | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | undefined>();
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [filePanelWidth, setFilePanelWidth] = useState(380);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  const { data: repo, isLoading: repoLoading } = useQuery({
    queryKey: ["repo", repoId],
    queryFn: () => getRepo(repoId),
    enabled: !!repoId,
  });

  const { currentPermission, pendingCount, dismissPermission } = usePermissionRequests();
  
  const opcodeUrl = OPENCODE_API_ENDPOINT;
  const openCodeClient = useOpenCodeClient(opcodeUrl, repo?.fullPath);
  
  const repoDirectory = repo?.fullPath;

  const { data: messages } = useMessages(opcodeUrl, sessionId, repoDirectory);

  const { scrollToBottom } = useAutoScroll({
    containerRef: messageContainerRef,
    messages,
    sessionId,
    onScrollStateChange: setShowScrollButton
  });

  const { data: session, isLoading: sessionLoading } = useSession(
    opcodeUrl,
    sessionId,
    repoDirectory,
  );
  const { isConnected, isReconnecting } = useSSE(opcodeUrl, repoDirectory);
  const abortSession = useAbortSession(opcodeUrl, repoDirectory);
  const updateSession = useUpdateSession(opcodeUrl, repoDirectory);
  const { open: openSettings } = useSettingsDialog();

  useKeyboardShortcuts({
    openModelDialog: () => setModelDialogOpen(true),
    submitPrompt: () => {
      const submitButton = document.querySelector(
        "[data-submit-prompt]",
      ) as HTMLButtonElement;
      submitButton?.click();
    },
    abortSession: () => {
      if (sessionId) {
        abortSession.mutate(sessionId);
      }
    },
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const newMode = preferences?.mode === "plan" ? "build" : "plan";
        updateSettings({ mode: newMode });
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [preferences?.mode, updateSettings]);

  

  const handleFileClick = useCallback((filePath: string) => {
    let pathToOpen = filePath
    
    if (filePath.startsWith('/') && repo?.fullPath) {
      const workspaceReposPath = repo.fullPath.substring(0, repo.fullPath.lastIndexOf('/'))
      
      if (filePath.startsWith(workspaceReposPath + '/')) {
        pathToOpen = filePath.substring(workspaceReposPath.length + 1)
      }
    }
    
    setSelectedFilePath(pathToOpen)
    setFileBrowserOpen(true)
  }, [repo?.fullPath]);

  const handleSessionTitleUpdate = useCallback((newTitle: string) => {
    if (sessionId) {
      updateSession.mutate({ sessionID: sessionId, title: newTitle });
    }
  }, [sessionId, updateSession]);

  const handleFileBrowserClose = useCallback(() => {
    setFileBrowserOpen(false)
    setSelectedFilePath(undefined)
  }, []);

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
  }, []);

  const handlePermissionResponse = useCallback(async (
    permissionID: string, 
    permissionSessionID: string, 
    response: PermissionResponse
  ) => {
    if (!openCodeClient) return
    await openCodeClient.respondToPermission(permissionSessionID, permissionID, response)
  }, [openCodeClient]);

  const handleExecuteCommand = useCallback(async (command: CommandWithScope, run: boolean, args: string) => {
    if (!sessionId) return
    const text = args ? `/${command.name} ${args}` : `/${command.name}`
    setInjectedCommand((prev) => ({
      token: (prev?.token ?? 0) + 1,
      text,
      run,
    }))
  }, [sessionId]);

  const handleInjectedConsumed = useCallback(() => {
    setInjectedCommand(null)
  }, []);

  const handleInjectedFileConsumed = useCallback(() => {
    setInjectedFile(null)
  }, []);

  const handleGlobalDrop = useCallback(async (e: DragEvent) => {
    const files = e.dataTransfer?.files
    if (!files || files.length === 0 || !repo?.localPath) return

    e.preventDefault()
    const dir = repo.localPath
    const results: { name: string; path: string }[] = []
    let lastError: string | null = null

    for (const file of Array.from(files)) {
      const formData = new FormData()
      formData.append('file', file)
      try {
        const res = await fetch(`${API_BASE_URL}/api/files/${dir}`, {
          method: 'POST',
          body: formData,
        })
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          if (!lastError) lastError = body?.error || `Upload failed: ${res.statusText}`
          continue
        }
        const data = await res.json().catch(() => null)
        const uploadedPath: string = data?.path || `${dir}/${file.name}`
        const repoPath = uploadedPath.split(/[/\\]/).slice(1).join('/')
        results.push({ name: data?.name || file.name, path: repoPath || file.name })
      } catch {
        if (!lastError) lastError = 'Upload failed'
        continue
      }
    }

    if (results.length > 0) {
      setInjectedFile((prev) => ({
        token: (prev?.token ?? 0) + 1,
        files: results,
      }))
      showToast.success(`Uploaded ${results.length} file(s) to project`)
    } else {
      showToast.error(lastError || 'Upload failed')
    }
  }, [repo?.localPath]);

  useEffect(() => {
    const onDragOver = (e: DragEvent) => e.preventDefault()
    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.files?.length) {
        handleGlobalDrop(e)
      }
    }

    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [handleGlobalDrop]);

  if (repoLoading || sessionLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-background via-background to-background">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!repo || !sessionId) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-background via-background to-background text-muted-foreground">
        Session not found
      </div>
    );
  }
  
  if (!session) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-background via-background to-background text-muted-foreground">
        Session not found
      </div>
    );
  }
  
  
  return (
    <div className="h-dvh max-h-dvh overflow-hidden bg-gradient-to-br from-background via-background to-background flex flex-col">
      <SessionDetailHeader
        repo={repo}
        sessionId={sessionId}
        sessionTitle={session.title || "Untitled Session"}
        repoId={repoId}
        isConnected={isConnected}
        isReconnecting={isReconnecting}
        opcodeUrl={opcodeUrl}
        repoDirectory={repoDirectory}
        onFileBrowserOpen={() => setFileBrowserOpen(true)}
        onSettingsOpen={openSettings}
        onCommandsOpen={() => setCommandsOpen(true)}
        onSessionTitleUpdate={handleSessionTitleUpdate}
      />

      <div ref={splitContainerRef} className="flex-1 overflow-hidden flex relative">
        <div className="flex-1 overflow-hidden flex flex-col relative min-w-0">
          <div key={sessionId} ref={messageContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden pb-28 overscroll-contain">
            {opcodeUrl && repoDirectory && (
              <MessageThread 
                opcodeUrl={opcodeUrl} 
                sessionID={sessionId} 
                directory={repoDirectory}
                messages={messages}
                onFileClick={handleFileClick}
              />
            )}
          </div>
          {opcodeUrl && repoDirectory && (
            <div className="absolute bottom-0 left-0 right-0 flex justify-center">
              <PromptInput
                opcodeUrl={opcodeUrl}
                directory={repoDirectory}
                sessionID={sessionId}
                disabled={!isConnected}
                showScrollButton={showScrollButton}
                onScrollToBottom={scrollToBottom}
                onShowModelsDialog={() => setModelDialogOpen(true)}
                onShowSessionsDialog={() => setSessionsDialogOpen(true)}
                onShowHelpDialog={() => {
                  openSettings()
                }}
                injectedCommand={injectedCommand}
                onInjectedConsumed={handleInjectedConsumed}
                injectedFile={injectedFile}
                onInjectedFileConsumed={handleInjectedFileConsumed}
              />
            </div>
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
            repoName={repo.repoUrl?.split("/").pop()?.replace(".git", "") || repo.localPath || "Repository"}
            initialSelectedFile={selectedFilePath}
            width={filePanelWidth}
            onClose={handleFileBrowserClose}
          />
        )}
      </div>

      <ModelSelectDialog
        open={modelDialogOpen}
        onOpenChange={setModelDialogOpen}
        opcodeUrl={opcodeUrl}
      />

      {/* Sessions Dialog */}
      <Dialog open={sessionsDialogOpen} onOpenChange={setSessionsDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[80vh]">
          <DialogTitle>Sessions</DialogTitle>
          <div className="overflow-y-auto max-h-[60vh] mt-4">
            {opcodeUrl && (
              <SessionList
                opcodeUrl={opcodeUrl}
                directory={repoDirectory}
                activeSessionID={sessionId || undefined}
                onSelectSession={(sessionID) => {
                  // Navigate to the correct repo session URL pattern
                  const currentPath = window.location.pathname
                  const repoMatch = currentPath.match(/\/repos\/(\d+)\/sessions\//)
                  if (repoMatch) {
                    const repoId = repoMatch[1]
                    navigate(`/repos/${repoId}/sessions/${sessionID}`)
                  } else {
                    // Fallback for direct session access
                    navigate(`/session/${sessionID}`)
                  }
                  setSessionsDialogOpen(false)
                }}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      <PermissionRequestDialog
        permission={currentPermission}
        pendingCount={pendingCount}
        onRespond={handlePermissionResponse}
        onDismiss={dismissPermission}
      />

      <CommandsPanel
        open={commandsOpen}
        onClose={() => setCommandsOpen(false)}
        opcodeUrl={opcodeUrl}
        sessionID={sessionId}
        directory={repoDirectory}
        onExecuteCommand={handleExecuteCommand}
      />
    </div>
  );
}
