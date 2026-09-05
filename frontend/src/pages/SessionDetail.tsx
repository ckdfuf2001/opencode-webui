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
import { useSession, useSessions, useAbortSession, useUpdateSession, useOpenCodeClient, useMessages, usePollLastMessage, useEphemeralSessionSSE, useTruncateSession, useDeleteMessage, useSummarizeSession, useReconcileOrphanedStreams, useSessionStatusMap, useCreateSession, useSendPrompt, isRecentlyAborted, hasActiveSend } from "@/hooks/useOpenCode";
import { NavigationPanel } from "@/components/navigation/NavigationPanel";
import { AddRepoDialog } from "@/components/repo/AddRepoDialog";
import { useOpencodeHealth } from "@/hooks/useOpencodeHealth";
import { OPENCODE_API_ENDPOINT, API_BASE_URL } from "@/config";
import { playCompletionTick } from "@/lib/sounds";
import { shouldPlaySound, shouldPush, sendPushNotification } from "@/lib/notifications";
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
  useEffect(() => {
    if (!sessionId) return
    const key = `pendingPrompt:${sessionId}`
    const pending = sessionStorage.getItem(key)
    if (pending) {
      sessionStorage.removeItem(key)
      setInjectedPrompt({ token: Date.now(), text: pending })
    }
  }, [sessionId])
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
  // 윈도잉: 첫 진입/컴팩트 후 최근 N개만 보이고 위로 스크롤 시 점진 로딩 — 메모리 절약을 위해 15로 축소
  const INITIAL_VISIBLE = 15;
  const LOAD_STEP = 15;
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const visibleCountRef = useRef(visibleCount);
  useEffect(() => { visibleCountRef.current = visibleCount }, [visibleCount]);
  // 세션 변경 시 초기화 + 이전 세션 메시지 캐시 해제 (브라우저 메모리 절약)
  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE)
    queryClient.removeQueries({ queryKey: ["opencode", "messages"], type: "inactive" } as never)
  }, [sessionId, queryClient]);
  // 컴팩트/트렁케이트 등으로 메시지가 크게 줄면(예: summarize) 다시 최근만 보이게
  const prevMsgLenRef = useRef<number>(0);
  useEffect(() => {
    const len = messages?.length ?? 0;
    const prev = prevMsgLenRef.current;
    prevMsgLenRef.current = len;
    // 길이가 큰 폭으로 줄었을 때(컴팩트) 초기화
    if (prev > 0 && len > 0 && len < prev - 10) {
      setVisibleCount(INITIAL_VISIBLE);
    } else if (len > 0 && prev === 0) {
      // 첫 로드도 최근만
      setVisibleCount(INITIAL_VISIBLE);
    }
  }, [messages?.length]);
  const baseMessages = useMemo(() => {
    if (!messages) return undefined;
    const editIndex = hiddenAfterID ? messages.findIndex((m) => m.info.id === hiddenAfterID) : -1;
    return editIndex >= 0 ? messages.slice(0, editIndex + 1) : messages;
  }, [messages, hiddenAfterID]);
  const visibleMessages = useMemo(() => {
    if (!baseMessages) return undefined;
    if (baseMessages.length <= visibleCount) return baseMessages;
    return baseMessages.slice(-visibleCount);
  }, [baseMessages, visibleCount]);
  const hasMore = (baseMessages?.length ?? 0) > visibleCount;
  const hiddenCount = (baseMessages?.length ?? 0) - visibleCount;
  const handleLoadMore = useCallback(() => {
    const c = messageContainerRef.current;
    if (!c || !baseMessages) {
      setVisibleCount((p) => Math.min(p + LOAD_STEP, baseMessages?.length ?? p + LOAD_STEP));
      return;
    }
    const prevHeight = c.scrollHeight;
    const prevTop = c.scrollTop;
    setVisibleCount((p) => Math.min(p + LOAD_STEP, baseMessages.length));
    // 스크롤 점프 방지: 높이 증가분만큼 scrollTop 보정
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const newHeight = c.scrollHeight;
        c.scrollTop = prevTop + (newHeight - prevHeight);
      });
    });
  }, [baseMessages]);
  // 위로 스크롤 시 자동 로딩 (throttle 200ms)
  useEffect(() => {
    const c = messageContainerRef.current;
    if (!c || !hasMore) return;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        if (!c) return;
        if (c.scrollTop < 160 && hasMore) {
          handleLoadMore();
        }
      });
    };
    c.addEventListener("scroll", onScroll, { passive: true });
    return () => c.removeEventListener("scroll", onScroll);
  }, [hasMore, handleLoadMore]);
  const {
    data: dbStatuses,
    isError: statusError,
    isFetching: statusFetching,
  } = useSessionStatusMap();
  const { data: opencodeHealthy, isError: healthError, isFetching: healthFetching } = useOpencodeHealth();
  const isConnected = !healthError && !!opencodeHealthy && !statusError && !!dbStatuses;
  const isReconnecting = (healthError && healthFetching) || (statusError && statusFetching) || (!opencodeHealthy && !healthError);
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
  const isStreaming = isConnected && ((!!lastMessage && isMessageStreaming(lastMessage)) || dbBusy || descendantBusy);
  const sseEnabled = !!sessionId && (hasActiveSend(sessionId) || isStreaming);
  // Poll last message even when SSE is active — bash PTY output is not always via SSE delta (tool case), polling is the reliable fallback
  usePollLastMessage(opcodeUrl, sessionId, repoDirectory, isStreaming)
  useEphemeralSessionSSE(opcodeUrl, sessionId, repoDirectory, sseEnabled)
  useEffect(() => {
    if (sessionId && isRecentlyAborted(sessionId)) setHiddenAfterID(null)
  }, [isStreaming, sessionId])
  const effectiveAutoScroll = autoScrollOverride ?? (preferences?.autoScroll ?? true);
  const { data: session, isLoading: sessionLoading } = useSession(opcodeUrl, sessionId, repoDirectory);
  useReconcileOrphanedStreams(opcodeUrl, repoDirectory);
  const abortSession = useAbortSession(opcodeUrl, repoDirectory);
  const updateSession = useUpdateSession(opcodeUrl, repoDirectory);
  const truncateSession = useTruncateSession(opcodeUrl, repoDirectory);
  const deleteMessageMutation = useDeleteMessage(opcodeUrl, repoDirectory);
  const summarizeSession = useSummarizeSession(opcodeUrl, repoDirectory);
  const ctx = useContextUsage(opcodeUrl, sessionId, repoDirectory);
  const { open: openSettings } = useSettingsDialog();
  const [lengthModal, setLengthModal] = useState<{ open: boolean; messageId: string | null }>({ open: false, messageId: null });
  const [isCompacting, setIsCompacting] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [addRepoOpen, setAddRepoOpen] = useState(false);
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
    // cancel/abort 시에도 완료음 재생 — was가 true였다면 streaming이 꺼질 때(또는 abort 직후) 모두 재생
    const aborted = sessionId ? isRecentlyAborted(sessionId) : false;
    const isCancel = aborted;
    const canSound = shouldPlaySound(sessionId, isCancel, preferences ?? {}, repoId);
    const canPush = shouldPush(sessionId, preferences ?? {}, repoId);
    if (was && (!isStreaming || aborted)) {
      if (canSound) void playCompletionTick();
      if (canPush) {
        const title = isCancel ? '응답이 취소되었습니다' : '응답이 완료되었습니다'
        const body = sessionId ?? ''
        sendPushNotification(title, { body, tag: sessionId }, id ? `/repos/${id}/sessions/${sessionId}` : `/session/${sessionId}`)
      }
      // 빈 응답 감지: free quota 만료 등으로 LLM이 아무 텍스트 없이 종료된 경우 토스트
      // 단, 사용자가 직접 cancel/abort 한 경우는 제외한다.
      // 폴링 지연(2s) 고려해 3.5초 뒤 재확인한다.
      const timer = setTimeout(() => {
        const cur = messagesRef.current;
        if (!cur || cur.length === 0) return;
        const last = cur[cur.length - 1] as any;
        const errName = last.info?.error?.name ?? last.info?.error?.data?.name
        const isAborted = errName === "MessageAbortedError" || last.info?.finish === "aborted" || (last.parts?.some((p: any) => p.type === "step-finish" && p.reason === "aborted"))
        if (isAborted) return;
        const hasVisible = last.parts.some((p: any) => {
          if (p.type === "text" && typeof p.text === "string" && p.text.trim()) return true;
          if (p.type === "tool" || p.type === "patch" || p.type === "file" || p.type === "agent" || p.type === "reasoning") return true;
          return false;
        });
        const isEmptyAssistant = last.info.role === "assistant" && !hasVisible;
        const isUserWithoutReply = last.info.role === "user";
        if ((isEmptyAssistant || isUserWithoutReply) && last.info.id !== lastBillingToastRef.current) {
          showToast.error(
            "The LLM response was empty. This may be due to a free quota, timeout, or provider error. Check your model/key. (https://opencode.ai/zen / https://openrouter.ai/credits)",
            { duration: 10000 },
          );
        }
      }, 3500);
      return () => clearTimeout(timer);
    }
  }, [isStreaming, preferences, sessionId]);

  // 권한 요청 도착 시 소리/푸시 (세션별/글로벌 설정 따름)
  const prevPermissionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const pid = currentPermission?.id ?? null;
    if (pid && pid !== prevPermissionIdRef.current) {
      prevPermissionIdRef.current = pid;
      if (shouldPlaySound(sessionId, false, preferences ?? {}, repoId)) void playCompletionTick();
      if (shouldPush(sessionId, preferences ?? {}, repoId)) {
        const title = '승인이 필요합니다';
        const body = (currentPermission as unknown as { pattern?: string[]; permission?: string })?.pattern?.[0] ?? (currentPermission as unknown as { permission?: string })?.permission ?? sessionId ?? '';
        sendPushNotification(title, { body, tag: `perm-${pid}` }, id ? `/repos/${id}/sessions/${sessionId}` : `/session/${sessionId}`);
      }
    } else if (!pid) {
      prevPermissionIdRef.current = null;
    }
  }, [currentPermission?.id, preferences, sessionId, repoId, currentPermission]);

  // 질문 요청 도착 시에도 동일하게 알림
  const prevQuestionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const qid = currentQuestion?.id ?? null;
    if (qid && qid !== prevQuestionIdRef.current) {
      prevQuestionIdRef.current = qid;
      if (shouldPlaySound(sessionId, false, preferences ?? {}, repoId)) void playCompletionTick();
      if (shouldPush(sessionId, preferences ?? {}, repoId)) {
        sendPushNotification('질문이 도착했습니다', { body: sessionId ?? '', tag: `q-${qid}` }, id ? `/repos/${id}/sessions/${sessionId}` : `/session/${sessionId}`);
      }
    } else if (!qid) {
      prevQuestionIdRef.current = null;
    }
  }, [currentQuestion?.id, preferences, sessionId, repoId, currentQuestion]);

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

  const lastCompactAtRef = useRef<number>(0)
  // 컨텍스트 초과(length) — 실제 한계 도달 시에만 표시 (오탐 방지, compact 후 무시)
  useEffect(() => {
    if (!messages || messages.length === 0) return;
    if (ctx.isLoading) return;
    // 가장 최근 length 메시지 찾기 — 마지막 메시지가 length일 때만 유효
    let lengthIdx = -1;
    let lengthMsg: any = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m: any = messages[i];
      const finish = (m.info as any)?.finish;
      const errName = (m.info as any)?.error?.name;
      const isLength = finish === "length" || errName === "MessageOutputLengthError" || m.parts?.some((p: any) => p.type === "step-finish" && p.reason === "length");
      if (isLength) { lengthIdx = i; lengthMsg = m; break; }
    }
    if (!lengthMsg) return;
    if (lastLengthToastRef.current === lengthMsg.info.id) return;
    const isLast = lengthIdx === messages.length - 1;
    if (!isLast) return;
    const msgTime = (lengthMsg as any)?.info?.time?.created ?? 0
    if (msgTime && msgTime < lastCompactAtRef.current) return;
    const hasAnyAfter = messages.length - 1 > lengthIdx;
    if (hasAnyAfter) return;
    // Output vs Context 구분: MessageOutputLengthError만 output, 나머지는 context (step-finish length는 usage로 구분)
    const errName = (lengthMsg as any)?.info?.error?.name as string | undefined;
    const isOutput = errName === 'MessageOutputLengthError';
    const isContext = !isOutput;
    // Context limit는 usage가 높을 때만 유효, Output limit는 usage와 무관
    if (isContext && (ctx.usagePercentage == null || ctx.usagePercentage < 85)) return;
    lastLengthToastRef.current = lengthMsg.info.id;
    const pct = ctx.usagePercentage ? Math.round(ctx.usagePercentage) : 0;
    const total = ctx.totalTokens ?? 0;
    const limit = ctx.contextLimit ?? 0;
    const dbg = ` [dbg: usage ${pct}% (${total.toLocaleString()}/${limit ? limit.toLocaleString() : '?'}) tokens, finish=${(lengthMsg as any)?.info?.finish ?? 'length'}, error=${errName ?? 'none'}, isLast=${isLast}, idx=${lengthIdx}/${messages.length - 1}]`;
    showToast.error(
      isOutput
        ? `Output limit reached (finish=length). The model hit its output token limit — try Continue to split and continue.${dbg}`
        : `Context limit reached (finish=length, ${pct ? pct + "%" : "limit exceeded"}). Clean up with summarize (compact) or truncating previous messages.${dbg}`,
      { duration: 8000 }
    );
    setLengthModal({ open: true, messageId: lengthMsg.info.id });
  }, [messages, ctx.usagePercentage, ctx.isLoading, ctx.totalTokens, ctx.contextLimit]);

  const handleCompact = useCallback(async () => {
    if (!sessionId) return;
    setIsCompacting(true);
    try {
      // ctx.currentModel 은 preferences.defaultModel 을 우선하고, 없으면 최신
      // assistant 메시지의 providerID/modelID 로부터 유도된다. 그것조차 없으면
      // 실제 대화 메시지의 model 메타데이터를 역방향으로 탐색한다. 그마저 없으면
      // 하드코딩된 모델로 조용히 진행하는 대신 명확한 오류를 던진다.
      let modelStr = ctx.currentModel;
      if (!modelStr && messages?.length) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const info = (messages[i] as any)?.info;
          if (info && info.providerID && info.modelID) {
            modelStr = `${info.providerID}/${info.modelID}`;
            break;
          }
        }
      }
      if (!modelStr) throw new Error("No model info found. Select a model first, then run summarize (compact).");
      const slashIdx = modelStr.indexOf("/");
      if (slashIdx === -1) throw new Error(`Invalid model info (${modelStr}). Select a model again.`);
      const providerID = modelStr.slice(0, slashIdx);
      const modelID = modelStr.slice(slashIdx + 1);
      if (!providerID || !modelID) throw new Error("Invalid model info.");
      const ok = await summarizeSession.mutateAsync({ sessionID: sessionId, providerID, modelID });
      if (ok === false) throw new Error("The server could not complete summarize (compact). Try again, or truncate earlier messages instead.");
      lastCompactAtRef.current = Date.now()
      showToast.success("Session summarized (compact). Context cleaned up.", { duration: 4000 });
      setLengthModal({ open: false, messageId: null });
      setVisibleCount(INITIAL_VISIBLE);
      // 컴팩트 후에는 최근만 보이고 하단으로
      requestAnimationFrame(() => {
        const c = messageContainerRef.current;
        if (c) c.scrollTop = c.scrollHeight;
      });
    } catch (e) {
      showToast.error((e as Error).message || "Summarize (compact) failed. Try truncating earlier messages manually.");
    } finally {
      setIsCompacting(false);
    }
  }, [sessionId, summarizeSession, ctx.currentModel, messages]);

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
        showToast.success(`Truncated ${res.messagesRemoved ?? ""} previous message(s). Try again.`);
        setLengthModal({ open: false, messageId: null });
      }
    } catch (e) {
      showToast.error((e as Error).message || "Failed to truncate messages.");
    }
  }, [messages, sessionId, truncateSession]);

  const sendPromptContinue = useSendPrompt(opcodeUrl, repoDirectory)
  const handleContinueOutput = useCallback(async () => {
    if (!sessionId) return
    try {
      setLengthModal({ open: false, messageId: null })
      await sendPromptContinue.mutateAsync({ sessionID: sessionId, parts: [{ type: 'text', text: 'Continue from where you left off. Please continue the previous response.' } as never] } as never)
      showToast.success('Continuing output...')
    } catch (e) {
      showToast.error((e as Error).message || 'Failed to continue.')
    }
  }, [sessionId, sendPromptContinue])

  const createSessionMutation = useCreateSession(opcodeUrl, repoDirectory);
  const handleNewSession = useCallback(async () => {
    try {
      const s = await createSessionMutation.mutateAsync({});
      setLengthModal({ open: false, messageId: null });
      navigate(`/repos/${repoId}/sessions/${s.id}`);
      showToast.success("New session created");
    } catch (e) {
      showToast.error((e as Error).message || "Failed to create new session");
    }
  }, [createSessionMutation, navigate, repoId]);

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
    const msgFromQuery = searchParams.get('msg');
    const hash = window.location.hash;
    const msgFromHash = hash.startsWith('#message-') ? hash.slice(9) : hash.startsWith('#msg=') ? hash.slice(5) : null;
    const msgID = msgFromQuery || msgFromHash;
    if (!msgID) return;
    if (!messages || !baseMessages) return;
    const idx = baseMessages.findIndex((m) => m.info.id === msgID);
    if (idx === -1) return;
    // ensure window includes target when navigating via hash/?msg
    const need = baseMessages.length - idx;
    if (need > visibleCount) setVisibleCount(Math.min(baseMessages.length, need + 5));
    if (msgFromQuery) setSearchParams({}, { replace: true });
    requestAnimationFrame(() => scrollToMessage(msgID));
    if (msgFromHash) history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [searchParams, setSearchParams, messages, baseMessages, visibleCount, scrollToMessage]);

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

  const handleRecallUseInChat = useCallback((text: string) => {
    // Recall 검색 결과를 채팅 입력으로 보낸다 — PromptInput이 injectedPrompt를 소비
    setInjectedPrompt((prev) => ({
      token: (prev?.token ?? 0) + 1,
      text,
    }))
  }, []);

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

  const handleDeleteMessage = useCallback(async (messageID: string) => {
    if (!sessionId) return
    try {
      const result = await deleteMessageMutation.mutateAsync({ sessionID: sessionId, messageID })
      if (!result?.success) {
        showToast.error('Failed to delete message')
        return
      }
      setHiddenAfterID(null)
      setInjectedPrompt(null)
      showToast.success('Message (this turn) deleted')
    } catch (error) {
      showToast.error((error as Error).message || 'Failed to delete message')
    }
  }, [sessionId, deleteMessageMutation]);

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
        onNavOpen={() => setNavOpen(true)}
      />

      <div ref={splitContainerRef} className="flex-1 overflow-hidden flex relative">
        <div className="flex-1 overflow-hidden flex flex-col relative min-w-0">
          <UntrackedSuggestionBanner />
          <div key={sessionId} ref={messageContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden pb-28 overscroll-contain">
            {hasMore && baseMessages && (
              <div className="sticky top-0 z-10 flex justify-center py-2 bg-gradient-to-b from-background to-transparent">
                <button
                  onClick={handleLoadMore}
                  className="text-xs px-3 py-1.5 rounded-full border bg-card hover:bg-accent text-muted-foreground hover:text-foreground shadow-sm"
                >
                  Load more — {hiddenCount} older message{hiddenCount !== 1 ? "s" : ""} hidden · click or scroll up
                </button>
              </div>
            )}
            {opcodeUrl && repoDirectory && (
              <MessageThread 
                opcodeUrl={opcodeUrl} 
                sessionID={sessionId} 
                directory={repoDirectory}
                messages={visibleMessages}
                isLoading={messagesLoading}
                onFileClick={handleFileClick}
                onEditMessage={handleEditMessage}
                onTruncate={handleTruncate}
                onDelete={handleDeleteMessage}
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
                onCompact={handleCompact}
                onNewSession={handleNewSession}
                isStreaming={isStreaming}
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
        onUseInChat={handleRecallUseInChat}
      />

      <PermissionRulesDialog
        open={permissionRulesOpen}
        onOpenChange={setPermissionRulesOpen}
        repoId={repoId}
        sessionId={sessionId}
      />

      <NavigationPanel open={navOpen} onClose={() => setNavOpen(false)} onNewRepo={() => setAddRepoOpen(true)} />
      <AddRepoDialog open={addRepoOpen} onOpenChange={setAddRepoOpen} />

      <Dialog open={lengthModal.open} onOpenChange={(o) => setLengthModal({ open: o, messageId: o ? lengthModal.messageId : null })}>
        <DialogContent className="max-w-lg">
          <DialogTitle>{(() => {
            const m = messages?.find((x: unknown) => (x as { info: { id: string } }).info.id === lengthModal.messageId) as unknown as { info: { error?: { name?: string } } } | undefined
            const isOutput = m?.info?.error?.name === 'MessageOutputLengthError'
            return isOutput ? 'Output limit reached' : 'Context limit exceeded'
          })()}</DialogTitle>
          <div className="mt-2 space-y-3 text-sm">
            <p className="text-muted-foreground">
              {(() => {
                const m = messages?.find((x: unknown) => (x as { info: { id: string } }).info.id === lengthModal.messageId) as unknown as { info: { error?: { name?: string } } } | undefined
                const isOutput = m?.info?.error?.name === 'MessageOutputLengthError'
                if (isOutput) return <>The model hit its <span className="font-mono font-bold text-amber-500">output limit (finish=length)</span>. The response was cut off because the output token limit was reached, not the context window. Try Continue to split and continue.</>
                return <>The model response was truncated with <span className="font-mono font-bold text-red-500">finish=length</span>. The context has reached its limit ({ctx.contextLimit ? `${ctx.contextLimit.toLocaleString()} tokens` : "exceeded"}), so normal generation is no longer possible.{ctx.usagePercentage ? ` Currently using ${Math.round(ctx.usagePercentage)}% (${ctx.totalTokens.toLocaleString()} tokens).` : ""}</>
              })()}
            </p>
            <p className="text-xs text-muted-foreground">For output limit: Continue will send a follow-up to resume. For context limit: summarize (compact) reduces context by summarizing the conversation on the server. If it fails, truncate earlier messages instead.</p>
            <div className="flex gap-2 justify-end pt-2 flex-wrap">
              <button
                onClick={() => setLengthModal({ open: false, messageId: null })}
                className="px-3 py-1.5 rounded-md border text-sm"
              >
                Close
              </button>
              {(() => {
                const m = messages?.find((x: unknown) => (x as { info: { id: string } }).info.id === lengthModal.messageId) as unknown as { info: { error?: { name?: string } } } | undefined
                const isOutput = m?.info?.error?.name === 'MessageOutputLengthError'
                return isOutput ? (
                  <button onClick={handleContinueOutput} disabled={sendPromptContinue.isPending} className="px-3 py-1.5 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-50 hover:bg-emerald-700"> {sendPromptContinue.isPending ? 'Continuing...' : 'Continue (split)'} </button>
                ) : null
              })()}
              <button
                onClick={handleAutoTruncate}
                disabled={truncateSession.isPending}
                className="px-3 py-1.5 rounded-md bg-yellow-500/10 border border-yellow-500/30 text-yellow-700 dark:text-yellow-400 text-sm disabled:opacity-50"
              >
                {truncateSession.isPending ? "Processing..." : "Truncate previous messages"}
              </button>
              <button
                onClick={handleCompact}
                disabled={isCompacting || summarizeSession.isPending}
                className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm disabled:opacity-50"
              >
                {isCompacting || summarizeSession.isPending ? "Summarizing..." : "Compact"}
              </button>
              <button
                onClick={handleNewSession}
                disabled={createSessionMutation.isPending}
                className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm disabled:opacity-50 hover:bg-blue-700"
              >
                {createSessionMutation.isPending ? "Creating..." : "New Session"}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
