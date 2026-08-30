import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getRepo } from "@/api/repos";
import { MessageThread, isMessageStreaming } from "@/components/message/MessageThread";
import { PromptInput } from "@/components/message/PromptInput";
import { ModelSelectDialog } from "@/components/model/ModelSelectDialog";
import { SessionDetailHeader } from "@/components/session/SessionDetailHeader";
import { SessionList } from "@/components/session/SessionList";
import { PermissionRequestCard } from "@/components/session/PermissionRequestCard";
import { QuestionRequestCard } from "@/components/session/QuestionRequestCard";
import { SessionFilePanel } from "@/components/file-browser/SessionFilePanel";
import { CommandsPanel } from "@/components/command/CommandsPanel";
import { PermissionRulesDialog } from "@/components/permission/PermissionRulesDialog";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useSession, useSessions, useAbortSession, useUpdateSession, useOpenCodeClient, useMessages, useTruncateSession, useSummarizeSession, useReconcileOrphanedStreams, useSessionStatusMap } from "@/hooks/useOpenCode";
import { OPENCODE_API_ENDPOINT, API_BASE_URL } from "@/config";
import { playCompletionTick } from "@/lib/sounds";
import { useSettings } from "@/hooks/useSettings";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useSettingsDialog } from "@/hooks/useSettingsDialog";
import { useQuestionRequests, useLoadPendingQuestions } from "@/hooks/useQuestionRequests";
import { usePermissionRequests, useLoadPendingPermissions, collectDescendantIDs } from "@/hooks/usePermissionRequests";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useContextUsage } from "@/hooks/useContextUsage";
import type { CommandWithScope } from "@/hooks/useCommands";
import { Loader2 } from "lucide-react";
import type { PermissionResponse } from "@/api/types";
import { showToast } from "@/lib/toast";
import { UntrackedSuggestionBanner } from "@/components/UntrackedSuggestionBanner";

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
  const queryClient = useQueryClient()
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [sessionsDialogOpen, setSessionsDialogOpen] = useState(false);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [permissionRulesOpen, setPermissionRulesOpen] = useState(false);
  const [injectedCommand, setInjectedCommand] = useState<{ token: number; text: string; run?: boolean } | null>(null);
  const [injectedFile, setInjectedFile] = useState<InjectedFile | null>(null);
  const [injectedPrompt, setInjectedPrompt] = useState<{ token: number; text: string } | null>(null);
  const [hiddenAfterID, setHiddenAfterID] = useState<string | null>(null);
  const [highlightedMessageID, setHighlightedMessageID] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | undefined>();
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [filePanelWidth, setFilePanelWidth] = useState(380);
  const [autoScrollOverride, setAutoScrollOverride] = useState<boolean | null>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  const { data: repo, isLoading: repoLoading } = useQuery({
    queryKey: ["repo", repoId],
    queryFn: () => getRepo(repoId),
    enabled: !!repoId,
  });

  const opcodeUrl = OPENCODE_API_ENDPOINT;
  const openCodeClient = useOpenCodeClient(opcodeUrl, repo?.fullPath);

  const repoDirectory = repo?.fullPath;
  const { data: sessions } = useSessions(opcodeUrl, repoDirectory);

  const descendantIDs = useMemo(
    () => sessionId && sessions ? collectDescendantIDs(sessions, sessionId) : [],
    [sessionId, sessions],
  );

  const sessionTitles = useMemo(() => {
    const map: Record<string, string> = {}
    for (const s of sessions ?? []) map[s.id] = s.title
    return map
  }, [sessions]);

  const { currentPermission, pendingCount, dismissPermission } = usePermissionRequests(sessionId, descendantIDs);
  const { currentQuestion, dismissQuestion } = useQuestionRequests(sessionId);
  
  useLoadPendingPermissions(openCodeClient, sessionId, descendantIDs);
  useLoadPendingQuestions(openCodeClient, sessionId);

  const { data: messages, isLoading: messagesLoading } = useMessages(opcodeUrl, sessionId, repoDirectory);
  const {
    data: dbStatuses,
    isError: statusError,
    isFetching: statusFetching,
  } = useSessionStatusMap();
  const isConnected = !statusError && !!dbStatuses;
  const isReconnecting = statusError && statusFetching;
  const dbBusy = !!sessionId && dbStatuses?.some((s) => s.sessionId === sessionId && s.status === "busy") === true;
  // 세션 리스트 배지와 동일한 기준: 이 세션 또는 하위 세션이 busy 면 Working.
  const descendantBusy = !!sessionId && dbStatuses?.some(
    (s) => s.status === "busy" && descendantIDs.includes(s.sessionId),
  ) === true;
  // 세션 리스트의 방패 배지와 동일한 데이터: 이 세션(+하위)의 승인 대기 권한 합계.
  const headerPendingPermissions = useMemo(() => {
    if (!sessionId) return 0;
    return (dbStatuses ?? [])
      .filter((s) => s.sessionId === sessionId || descendantIDs.includes(s.sessionId))
      .reduce((sum, s) => sum + (s.pendingPermissions ?? 0), 0);
  }, [dbStatuses, sessionId, descendantIDs]);
  const lastMessage = messages?.[messages.length - 1];
  const isStreaming = (!!lastMessage && isMessageStreaming(lastMessage)) || dbBusy || descendantBusy;
  const effectiveAutoScroll = autoScrollOverride ?? (preferences?.autoScroll ?? true);
  const { data: session, isLoading: sessionLoading } = useSession(opcodeUrl, sessionId, repoDirectory);
  useReconcileOrphanedStreams(opcodeUrl, repoDirectory);
  const abortSession = useAbortSession(opcodeUrl, repoDirectory);
  const updateSession = useUpdateSession(opcodeUrl, repoDirectory);
  const truncateSession = useTruncateSession(opcodeUrl, repoDirectory);
  const summarizeSession = useSummarizeSession(opcodeUrl, repoDirectory);
  const ctx = useContextUsage(opcodeUrl, sessionId, repoDirectory);
  const { open: openSettings } = useSettingsDialog();
  const [lengthModal, setLengthModal] = useState<{ open: boolean; messageId: string | null }>({ open: false, messageId: null });
  const [isCompacting, setIsCompacting] = useState(false);
  const lastLengthToastRef = useRef<string | null>(null);

  // 응답 완료 똑소리: 카드 상태 기준으로 전환 1회만 재생한다.
  const prevStreamingRef = useRef(false);
  const lastBillingToastRef = useRef<string | null>(null);
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const isBillingQuotaMessage = useCallback((msg: string) => {
    const m = msg.toLowerCase();
    return (
      m.includes("freeusagelimit") ||
      m.includes("insufficient_quota") ||
      m.includes("insufficient balance") ||
      m.includes("payment required") ||
      m.includes("quota exceeded") ||
      m.includes("billing") ||
      m.includes("purchase") ||
      m.includes("add credits") ||
      m.includes("subscriptionusagelimit") ||
      m.includes("usage_not_included") ||
      m.includes("exceeded your current quota")
    );
  }, []);
  useEffect(() => {
    const was = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;
    if (was && !isStreaming) {
      playCompletionTick();
      // 빈 응답 감지: free quota 만료 등으로 LLM이 아무 텍스트 없이 종료된 경우 토스트
      // 폴링 지연(2s) 고려해 3.5초 뒤 재확인한다.
      const timer = setTimeout(() => {
        const cur = messagesRef.current;
        if (!cur || cur.length === 0) return;
        const last = cur[cur.length - 1];
        const hasVisible = last.parts.some((p: any) => {
          if (p.type === "text" && typeof p.text === "string" && p.text.trim()) return true;
          if (p.type === "tool" || p.type === "patch" || p.type === "file" || p.type === "agent" || p.type === "reasoning") return true;
          return false;
        });
        const isEmptyAssistant = last.info.role === "assistant" && !hasVisible;
        const isUserWithoutReply = last.info.role === "user";
        if ((isEmptyAssistant || isUserWithoutReply) && last.info.id !== lastBillingToastRef.current) {
          showToast.error(
            "LLM 응답이 비어있습니다. Free quota 만료, 타임아웃 또는 provider 오류일 수 있습니다. 모델/키를 확인하세요. (https://opencode.ai/zen / https://openrouter.ai/credits)",
            { duration: 10000 },
          );
        }
      }, 3500);
      return () => clearTimeout(timer);
    }
  }, [isStreaming]);

  // billing 문구가 assistant 텍스트에 직접 포함된 경우(스트리밍 본문으로 전달)에도 토스트
  useEffect(() => {
    if (!messages || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (last.info.role !== "assistant") return;
    if (last.info.id === lastBillingToastRef.current) return;
    const combinedText = last.parts
      .filter((p: any) => p.type === "text" && typeof p.text === "string")
      .map((p: any) => (p.text as string))
      .join(" ");
    if (!combinedText.trim()) return;
    if (isBillingQuotaMessage(combinedText)) {
      lastBillingToastRef.current = last.info.id;
      showToast.error(combinedText.slice(0, 400) + " — free quota/balance exhausted. (https://opencode.ai/zen)", {
        duration: 10000,
      });
    }
  }, [messages, isBillingQuotaMessage]);

  // 컨텍스트 초과(length) 자동 관리: finish=length 또는 MessageOutputLengthError 감지
  useEffect(() => {
    if (!messages || messages.length === 0) return;
    const lengthMsg = messages.find((m: any) => {
      const finish = (m.info as any)?.finish
      const errName = (m.info as any)?.error?.name
      if (finish === "length" || errName === "MessageOutputLengthError") return true;
      if (m.parts?.some((p: any) => p.type === "step-finish" && p.reason === "length")) return true;
      return false;
    }) as any;
    if (!lengthMsg) return;
    if (lastLengthToastRef.current === lengthMsg.info.id) return;
    lastLengthToastRef.current = lengthMsg.info.id;
    const pct = ctx.usagePercentage ? Math.round(ctx.usagePercentage) : 0;
    showToast.error(
      `컨텍스트 한도 초과로 응답이 잘렸습니다 (finish=length, ${pct ? pct + "%" : "한도 초과"}). 요약(compact) 또는 이전 대화 잘라내기로 정리하세요.`,
      { duration: 8000 }
    );
    setLengthModal({ open: true, messageId: lengthMsg.info.id });
  }, [messages, ctx.usagePercentage]);

  const handleCompact = useCallback(async () => {
    if (!sessionId) return;
    setIsCompacting(true);
    try {
      await summarizeSession.mutateAsync({ sessionID: sessionId });
      showToast.success("세션을 요약(compact)했습니다. 컨텍스트가 정리되었습니다.", { duration: 4000 });
      setLengthModal({ open: false, messageId: null });
    } catch (e) {
      showToast.error((e as Error).message || "요약(compact)에 실패했습니다. 수동으로 잘라내기를 시도하세요.");
    } finally {
      setIsCompacting(false);
    }
  }, [sessionId, summarizeSession]);

  const handleAutoTruncate = useCallback(async () => {
    if (!messages || !sessionId) return;
    // length 메시지 이전의 유저 메시지부터 잘라내어 최근 턴을 제거
    const lengthIdx = messages.findIndex((m: any) => (m.info as any)?.finish === "length" || (m.info as any)?.error?.name === "MessageOutputLengthError" || m.parts?.some((p: any) => p.type === "step-finish" && p.reason === "length"));
    if (lengthIdx < 0) return;
    // 이전 유저 메시지 찾기 (없으면 length 메시지 자체를 커서로)
    let cursorId: string | null = null;
    for (let i = lengthIdx; i >= 0; i--) {
      if (messages[i].info.role === "user") { cursorId = messages[i].info.id; break; }
    }
    cursorId = cursorId ?? (messages[lengthIdx] as any).info.id;
    if (!cursorId) return;
    try {
      const res = await truncateSession.mutateAsync({ sessionID: sessionId, messageID: cursorId });
      if (res?.success) {
        showToast.success(`이전 대화 ${res.messagesRemoved ?? ""}개를 잘라냈습니다. 다시 시도하세요.`);
        setLengthModal({ open: false, messageId: null });
      }
    } catch (e) {
      showToast.error((e as Error).message || "잘라내기에 실패했습니다.");
    }
  }, [messages, sessionId, truncateSession]);

  const { scrollToBottom } = useAutoScroll({
    containerRef: messageContainerRef,
    messages,
    sessionId,
    enabled: effectiveAutoScroll,
    onScrollStateChange: setShowScrollButton
  });

  // 세션 변경 시 세션별 임시 오버라이드는 초기화 (설정 기본값으로 복귀)
  useEffect(() => {
    setAutoScrollOverride(null)
  }, [sessionId]);

  // permission/question 카드가 새로 뜨면(allow 버튼 포함) 하단까지 스크롤 — 카드가 길어도 버튼이 보이게
  useEffect(() => {
    if (currentPermission || currentQuestion) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollToBottom())
      })
    }
  }, [currentPermission, currentQuestion, scrollToBottom])

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

  

  const scrollToMessage = useCallback((messageID: string) => {
    setHighlightedMessageID(messageID);
    requestAnimationFrame(() => {
      document.getElementById(`message-${messageID}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    const msgID = searchParams.get('msg');
    if (!msgID) return;
    if (!messages) return;
    const found = messages.some((m) => m.info.id === msgID);
    setSearchParams({}, { replace: true });
    if (found) {
      requestAnimationFrame(() => scrollToMessage(msgID));
    }
  }, [searchParams, setSearchParams, messages, scrollToMessage]);

  const handleFileClick = useCallback(async (filePath: string) => {
    const normalizedFilePath = filePath.replace(/\\/g, '/')
    let pathToOpen = normalizedFilePath
    
    if (repo?.fullPath) {
      const normalizedFullPath = repo.fullPath.replace(/\\/g, '/')
      const workspaceReposPath = normalizedFullPath.substring(0, normalizedFullPath.lastIndexOf('/'))
      
      if (normalizedFilePath.startsWith(workspaceReposPath + '/')) {
        pathToOpen = normalizedFilePath.substring(workspaceReposPath.length + 1)
      } else if (repo?.localPath && normalizedFilePath.startsWith('chat_uploads/')) {
        pathToOpen = `${repo.localPath}/${normalizedFilePath}`
      } else if (repo?.localPath && !normalizedFilePath.includes('/')) {
        const candidate = `${repo.localPath}/chat_uploads/${normalizedFilePath}`
        const exists = await fetch(`${API_BASE_URL}/api/files/${candidate}`)
          .then((res) => res.ok)
          .catch(() => false)
        pathToOpen = exists ? candidate : normalizedFilePath
      }
    }
    
    setSelectedFilePath(pathToOpen)
    setFileBrowserOpen(true)
  }, [repo?.fullPath, repo?.localPath]);

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

  const handleQuestionReply = useCallback(async (requestID: string, answers: string[][]) => {
    if (!openCodeClient) return
    await openCodeClient.replyToQuestion(requestID, answers)
  }, [openCodeClient]);

  const handleQuestionReject = useCallback(async (requestID: string) => {
    if (!openCodeClient) return
    await openCodeClient.rejectQuestion(requestID)
  }, [openCodeClient]);

  const handlePermissionResponse = useCallback(async (
    permissionID: string,
    permissionSessionID: string,
    response: PermissionResponse
  ) => {
    if (!openCodeClient) return
    if (currentPermission?.v2) {
      await openCodeClient.respondToPermissionV2(permissionID, response)
    } else {
      await openCodeClient.respondToPermission(permissionSessionID, permissionID, response)
    }
  }, [openCodeClient, currentPermission]);

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

  const handleEditMessage = useCallback((messageID: string, text: string) => {
    setHiddenAfterID(messageID)
    setInjectedPrompt((prev) => ({
      token: (prev?.token ?? 0) + 1,
      text,
    }))
  }, []);

  const handleCancelEdit = useCallback(() => {
    setHiddenAfterID(null)
    setInjectedPrompt(null)
  }, []);

  const handleResendEdit = useCallback(async (messageID: string): Promise<boolean> => {
    if (!sessionId) return false
    try {
      const result = await truncateSession.mutateAsync({ sessionID: sessionId, messageID })
      if (!result?.success) {
        showToast.error('Failed to truncate session')
        return false
      }
      setHiddenAfterID(null)
      setInjectedPrompt(null)
      return true
    } catch (error) {
      showToast.error((error as Error).message || 'Failed to truncate session')
      return false
    }
  }, [sessionId, truncateSession]);

  const handleTruncate = useCallback((messageID: string) => {
    if (!sessionId) return
    handleResendEdit(messageID)
  }, [sessionId, handleResendEdit]);

  const handleInjectedPromptConsumed = useCallback(() => {
    setInjectedPrompt(null)
  }, []);

const handleGlobalDrop = useCallback(async (e: DragEvent) => {
    const files = e.dataTransfer?.files
    if (!files || files.length === 0 || !repo?.localPath) return

    e.preventDefault()
    const uploadDir = `${repo.localPath}/chat_uploads`
    const results: { name: string; path: string }[] = []
    let lastError: string | null = null

    for (const file of Array.from(files)) {
      const formData = new FormData()
      formData.append('file', file)
      try {
        const res = await fetch(`${API_BASE_URL}/api/files/${uploadDir}`, {
          method: 'POST',
          body: formData,
        })
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          if (!lastError) lastError = body?.error || `Upload failed: ${res.statusText}`
          continue
        }
        const data = await res.json().catch(() => null)
        const savedName: string = data?.name || file.name
        results.push({ name: savedName, path: `chat_uploads/${savedName}` })
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
      queryClient?.invalidateQueries({ queryKey: ['files'] })
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
                isStreaming={isStreaming}
                pendingPermissions={headerPendingPermissions}
        opcodeUrl={opcodeUrl}
        repoDirectory={repoDirectory}
        onFileBrowserOpen={() => setFileBrowserOpen(true)}
        onSettingsOpen={openSettings}
        onCommandsOpen={() => setCommandsOpen(true)}
        onPermissionRulesOpen={() => setPermissionRulesOpen(true)}
        onSessionTitleUpdate={handleSessionTitleUpdate}
      />

      <div ref={splitContainerRef} className="flex-1 overflow-hidden flex relative">
        <div className="flex-1 overflow-hidden flex flex-col relative min-w-0">
          <UntrackedSuggestionBanner />
          <div key={sessionId} ref={messageContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden pb-28 overscroll-contain">
            {opcodeUrl && repoDirectory && (
              <MessageThread 
                opcodeUrl={opcodeUrl} 
                sessionID={sessionId} 
                directory={repoDirectory}
                messages={messages}
                isLoading={messagesLoading}
                onFileClick={handleFileClick}
                onEditMessage={handleEditMessage}
                onTruncate={handleTruncate}
                hiddenAfterID={hiddenAfterID}
                onCancelEdit={handleCancelEdit}
                highlightedMessageID={highlightedMessageID}
              />
            )}
            {currentQuestion && (
              <div className="mt-2">
                <QuestionRequestCard
                  question={currentQuestion}
                  onReply={handleQuestionReply}
                  onReject={handleQuestionReject}
                  onDismiss={dismissQuestion}
                />
              </div>
            )}
            {currentPermission && (
              <div className="mt-2">
                <PermissionRequestCard
                  permission={currentPermission}
                  pendingCount={pendingCount}
                  viewedSessionID={sessionId}
                  sessionTitles={sessionTitles}
                  repoId={repoId}
                  onRespond={handlePermissionResponse}
                  onDismiss={dismissPermission}
                />
              </div>
            )}
          </div>
          {opcodeUrl && repoDirectory && (
            <div className="absolute bottom-0 left-0 right-0 flex justify-center pb-1 pointer-events-none">
              <div className="contents pointer-events-auto">
              <PromptInput
                opcodeUrl={opcodeUrl}
                directory={repoDirectory}
                uploadDir={`${repo.localPath}/chat_uploads`}
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
                injectedPrompt={injectedPrompt}
                onInjectedPromptConsumed={handleInjectedPromptConsumed}
                onSubmitted={handleCancelEdit}
                onCancelEdit={handleCancelEdit}
                editTargetMessageID={hiddenAfterID}
                onResendEdit={handleResendEdit}
                autoScrollEnabled={effectiveAutoScroll}
                onAutoScrollChange={setAutoScrollOverride}
              />
            </div>
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
        directory={repoDirectory}
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
                sessionHrefBase={
                  window.location.pathname.match(/\/repos\/(\d+)\/sessions\//)
                    ? `/repos/${window.location.pathname.match(/\/repos\/(\d+)\/sessions\//)![1]}/sessions`
                    : undefined
                }
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

      <CommandsPanel
        open={commandsOpen}
        onClose={() => setCommandsOpen(false)}
        opcodeUrl={opcodeUrl}
        sessionID={sessionId}
        directory={repoDirectory}
        repoId={repoId}
        onExecuteCommand={handleExecuteCommand}
        onScrollToMessage={scrollToMessage}
      />

      <PermissionRulesDialog
        open={permissionRulesOpen}
        onOpenChange={setPermissionRulesOpen}
        repoId={repoId}
      />

      <Dialog open={lengthModal.open} onOpenChange={(o) => setLengthModal({ open: o, messageId: o ? lengthModal.messageId : null })}>
        <DialogContent className="max-w-lg">
          <DialogTitle>컨텍스트 한도 초과</DialogTitle>
          <div className="mt-2 space-y-3 text-sm">
            <p className="text-muted-foreground">
              모델 응답이 <span className="font-mono font-bold text-red-500">finish=length</span> 로 잘렸습니다. 컨텍스트가 한도({ctx.contextLimit ? `${ctx.contextLimit.toLocaleString()} tokens` : "초과"})를 넘어 더 이상 정상 생성이 불가합니다.
              {ctx.usagePercentage ? ` 현재 ${Math.round(ctx.usagePercentage)}% (${ctx.totalTokens.toLocaleString()} tokens) 사용 중.` : ""}
            </p>
            <p className="text-xs text-muted-foreground">요약(compact)은 서버에서 대화를 요약해 컨텍스트를 줄입니다. 실패하면 이전 대화를 잘라내세요.</p>
            <div className="flex gap-2 justify-end pt-2">
              <button
                onClick={() => setLengthModal({ open: false, messageId: null })}
                className="px-3 py-1.5 rounded-md border text-sm"
              >
                닫기
              </button>
              <button
                onClick={handleAutoTruncate}
                disabled={truncateSession.isPending}
                className="px-3 py-1.5 rounded-md bg-yellow-500/10 border border-yellow-500/30 text-yellow-700 dark:text-yellow-400 text-sm disabled:opacity-50"
              >
                {truncateSession.isPending ? "처리 중..." : "이전 대화 잘라내기"}
              </button>
              <button
                onClick={handleCompact}
                disabled={isCompacting || summarizeSession.isPending}
                className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm disabled:opacity-50"
              >
                {isCompacting || summarizeSession.isPending ? "요약 중..." : "요약(compact) 실행"}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
