import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getRepo } from "@/api/repos";
import { MessageThread, isMessageStreaming } from "@/components/message/MessageThread";
import { PromptInput } from "@/components/message/PromptInput";
import { ModelSelectDialog } from "@/components/model/ModelSelectDialog";
import { SessionDetailHeader } from "@/components/session/SessionDetailHeader";
import { SessionJumpDialog } from "@/components/session/SessionJumpDialog";
import { SessionMoreMenu } from "@/components/session/SessionMoreMenu";
import { buildSessionMarkdown, buildSessionText, buildSessionHtml, sessionFileName, downloadTextFile, printSessionPdf } from "@/lib/sessionExport";
import type { SessionExportFormat } from "@/lib/sessionExport";
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
import { useContextUsage, markSessionCompacted } from "@/hooks/useContextUsage";
import type { CommandWithScope } from "@/hooks/useCommands";
import { Loader2 } from "lucide-react";
import type { PermissionResponse } from "@/api/types";
import { showToast } from "@/lib/toast";
import { uploadFileWithProgress, isUploadInFlight, DuplicateUploadError } from "@/api/files";
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
  // 입력창 오버레이 높이: 메시지 하단 패딩 + 이전보기 바 위치 계산용
  const inputWrapRef = useRef<HTMLDivElement>(null);
  const [inputH, setInputH] = useState(120);
  useEffect(() => {
    const el = inputWrapRef.current;
    if (!el) return;
    setInputH(el.offsetHeight);
    const ro = new ResizeObserver(() => setInputH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const queryClient = useQueryClient()
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [sessionsDialogOpen, setSessionsDialogOpen] = useState(false);
  const [jumpOpen, setJumpOpen] = useState(false);
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
  const [globalUpload, setGlobalUpload] = useState<{ name: string; loaded: number; total: number; index: number; count: number } | null>(null);
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
  // 고정 개수만 보여준다: DOM에는 항상 최대 WINDOW_SIZE개 (메모리/DOM 절약).
  // - windowStart === null: 하단 고정(마지막 N개)
  // - 위로 스크롤하면 윈도우가 위로 이동(LOAD_STEP), 아래쪽 DOM은 해제
  // - 맨 아래 도달하면 하단 고정으로 복귀
  // 위치 보정은 브라우저 네이티브 overflow-anchor에 맡긴다 (키가 msg.info.id로
  // 안정적이라 prepend 시 뷰가 제자리에 유지된다). 수동 scrollTop 보정 금지 —
  // 네이티브 앵커와 이중 보정되면 오히려 튄다.
  const WINDOW_SIZE = 10;
  const LOAD_STEP = 2;
  const EDGE_PX = 225;
  const SHIFT_COOLDOWN_MS = 500;
  const [windowStart, setWindowStart] = useState<number | null>(null);
  const windowStartRef = useRef<number | null>(null);
  // 이전 이동이 커밋되기 전 중복 이동 방지 (rAF마다 shift가 쌓여
  // 한 번에 최상단까지 날아가며 와다다 떨리던 원인)
  const shiftPendingRef = useRef(false);
  // 경계 왕복(나왔다 사라졌다) 방지: shift 직후 앵커 정착 스크롤이
  // 반대쪽 엣지로 보여도 쿨다운 동안은 추가 shift 금지
  const lastShiftAtRef = useRef(0);
  // 프로그램 이동(smooth scrollIntoView) 중에는 엣지 반응 금지.
  // 안 그러면 애니메이션 도중 윈도우가 움직여 타겟이 언마운트되고
  // 스크롤이 중간에 멈춘다. wheel이 오면 사용자가 개입한 것이므로 해제.
  const navLockUntilRef = useRef(0);
  // 하단 근처 여부 (엣지 트리거용: 근처 진입 시 1회만 복귀)
  const wasNearBottomRef = useRef(false);
  // Back to latest 요청 플래그: setWindowStart(null) 커밋 후에 스크롤해야
  // 옛 scrollHeight 기준으로 스크롤하는 레이스를 피할 수 있다
  const pendingLatestPinRef = useRef(false);
  useEffect(() => {
    windowStartRef.current = windowStart;
    shiftPendingRef.current = false;
  }, [windowStart]);
  // Back to latest: null 커밋 후(새 DOM 반영 후)에 하단 고정.
  // double-rAF + 120ms 폴백으로 늦은 페인트까지 커버한다.
  useEffect(() => {
    if (!pendingLatestPinRef.current || windowStart !== null) return;
    pendingLatestPinRef.current = false;
    const pin = () => {
      const cc = messageContainerRef.current;
      if (cc) cc.scrollTop = cc.scrollHeight;
    };
    requestAnimationFrame(() => requestAnimationFrame(pin));
    const t = setTimeout(pin, 120);
    return () => clearTimeout(t);
  }, [windowStart]);
  const prevMsgLenRef = useRef<number>(0);
  // 세션 변경 시 하단 고정 + 이전 세션 메시지 캐시 해제 (브라우저 메모리 절약)
  useEffect(() => {
    setWindowStart(null)
    shiftPendingRef.current = false
    lastShiftAtRef.current = 0
    wasNearBottomRef.current = false
    prevMsgLenRef.current = 0
    queryClient.removeQueries({ queryKey: ["opencode", "messages"], type: "inactive" } as never)
  }, [sessionId, queryClient]);
  const baseMessages = useMemo(() => {
    if (!messages) return undefined;
    const editIndex = hiddenAfterID ? messages.findIndex((m) => m.info.id === hiddenAfterID) : -1;
    return editIndex >= 0 ? messages.slice(0, editIndex + 1) : messages;
  }, [messages, hiddenAfterID]);
  // scrollToMessage(콜백)에서 최신 목록을 읽기 위한 미러
  const baseMessagesRef = useRef(baseMessages);
  useEffect(() => { baseMessagesRef.current = baseMessages; }, [baseMessages]);
  // 길이 변화 처리: 대량 감소(컴팩트/트렁케이트) → 하단 고정,
  // 내가 보낸 턴이면 하단 고정, 위를 보고 있었으면 화면 유지
  useEffect(() => {
    const len = baseMessages?.length ?? 0;
    const prev = prevMsgLenRef.current;
    prevMsgLenRef.current = len;
    if (len === 0 || prev === 0) return; // 첫 로드/세션전환: 하단 고정 유지
    if (len < prev - 10) {
      setWindowStart(null);
      return;
    }
    if (len <= prev) return;
    const last = baseMessages?.[len - 1];
    const lastIsUser = !!last && (last.info.role === 'user' || last.info.id.startsWith('optimistic'));
    if (lastIsUser) {
      setWindowStart(null);
    }
    // 어시스턴트 스트리밍 증가분은 시작점 유지 → 화면 고정 (아무것도 안 함)
  }, [baseMessages?.length]);
  const maxStart = Math.max(0, (baseMessages?.length ?? 0) - WINDOW_SIZE);
  const start = windowStart === null ? maxStart : Math.min(windowStart, maxStart);
  const visibleMessages = useMemo(() => {
    if (!baseMessages) return undefined;
    if (baseMessages.length <= WINDOW_SIZE) return baseMessages;
    return baseMessages.slice(start, start + WINDOW_SIZE);
  }, [baseMessages, start]);
  const hasMore = start > 0;
  const hiddenCount = start;
  // useAutoScroll의 추종 해제 함수 (아래 useAutoScroll 선언 뒤에 연결)
  const markDisengagedRef = useRef<(() => void) | null>(null);
  // 윈도우 위로 이동. 위치 보정은 네이티브 overflow-anchor가 담당하므로
  // 여기서는 추종 해제 + 시작점 이동만 한다.
  // 이전 이동이 커밋되기 전 중복 이동 금지 (rAF마다 쌓여 한 번에
  // 최상단까지 날아가며 와다다 떨리던 원인)
  const shiftWindowUp = useCallback(() => {
    if (shiftPendingRef.current) return;
    if (Date.now() - lastShiftAtRef.current < SHIFT_COOLDOWN_MS) return;
    const len = baseMessages?.length ?? 0;
    if (len === 0) return;
    const cur = windowStartRef.current ?? Math.max(0, len - WINDOW_SIZE);
    if (cur <= 0) return;
    markDisengagedRef.current?.();
    shiftPendingRef.current = true;
    lastShiftAtRef.current = Date.now();
    // 보상 스크롤이 하단 근처에 떨어져도 즉시 복귀하지 않도록 근처로 표시
    // (다음 실제 스크롤 이벤트에서 위치로 재계산된다)
    wasNearBottomRef.current = true;
    setWindowStart(Math.max(0, cur - LOAD_STEP));
  }, [baseMessages?.length]);
  // 윈도우 아래로 이동 (단계별, 끝에서만 하단 고정 복귀).
  // 위쪽 DOM을 해제하고 아래쪽을 붙이므로 스크롤 위치는 네이티브
  // overflow-anchor가 유지한다. 최신 근처면 null로 스냅 + 하단 핀.
  const shiftWindowDown = useCallback(() => {
    if (shiftPendingRef.current) return;
    if (Date.now() - lastShiftAtRef.current < SHIFT_COOLDOWN_MS) return;
    const len = baseMessages?.length ?? 0;
    if (len === 0) return;
    const cur = windowStartRef.current;
    if (cur === null) return; // 이미 하단 고정
    const maxS = Math.max(0, len - WINDOW_SIZE);
    if (cur >= maxS) {
      setWindowStart(null);
      return;
    }
    markDisengagedRef.current?.();
    shiftPendingRef.current = true;
    lastShiftAtRef.current = Date.now();
    const next = cur + LOAD_STEP;
    if (next >= maxS) {
      pendingLatestPinRef.current = true;
      setWindowStart(null);
    } else {
      setWindowStart(next);
    }
  }, [baseMessages?.length]);
  const handleLoadMore = shiftWindowUp;
  // 스크롤 감지: 위 근처 → 위로 2개, 아래 근처 → 아래로 2개(끝에서만 하단 고정)
  // + 끝에 닿은 채 더 밀어도(wheel) 페이지가 넘어가게 wheel도 처리한다.
  // (scroll만으로는 scrollTop=0/맨밑에서 더 밀 때 이벤트가 안 나서 멈춰 보임)
  useEffect(() => {
    const c = messageContainerRef.current;
    if (!c) return;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        if (!c) return;
        // 프로그램 이동 중 엣지 shift 금지 (타겟 언마운트 방지)
        if (Date.now() < navLockUntilRef.current) return;
        const scrollable = c.scrollHeight > c.clientHeight + 40;
        if (!scrollable) return;
        // 위를 우선: 짧은 내용에서 위·아래가 동시에 근처여도 위로만 간다 (왕복 루프 방지)
        if (c.scrollTop < EDGE_PX) {
          const len = baseMessages?.length ?? 0;
          const cur = windowStartRef.current ?? Math.max(0, len - WINDOW_SIZE);
          if (cur > 0) {
            wasNearBottomRef.current = true;
            shiftWindowUp();
            return;
          }
        }
        const distToBottom = c.scrollHeight - (c.scrollTop + c.clientHeight);
        if (distToBottom < EDGE_PX) {
          if (windowStartRef.current !== null) {
            wasNearBottomRef.current = true;
            shiftWindowDown();
          } else {
            wasNearBottomRef.current = true;
          }
        } else {
          wasNearBottomRef.current = false;
        }
      });
    };
    // 끝에 닿은 상태에서 방향키로/휠로 더 미는 경우 scroll이 안 나므로 여기서 직접 이동
    const onWheel = (e: WheelEvent) => {
      // 사용자 휠 개입이면 프로그램 이동 락 해제
      navLockUntilRef.current = 0;
      if (e.deltaY < 0 && c.scrollTop <= 0) {
        const len = baseMessages?.length ?? 0;
        const cur = windowStartRef.current ?? Math.max(0, len - WINDOW_SIZE);
        if (cur > 0) shiftWindowUp();
      } else if (e.deltaY > 0) {
        const distToBottom = c.scrollHeight - (c.scrollTop + c.clientHeight);
        if (distToBottom <= 1 && windowStartRef.current !== null) shiftWindowDown();
      }
    };
    c.addEventListener("scroll", onScroll, { passive: true });
    c.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      c.removeEventListener("scroll", onScroll);
      c.removeEventListener("wheel", onWheel);
    };
    // 컨테이너가 key={sessionId}로 리마운트되므로 세션 변경 시 리스너 재부착
  }, [shiftWindowUp, shiftWindowDown, sessionId]);
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
  const recentlyAborted = sessionId ? isRecentlyAborted(sessionId) : false;
  const isStreaming = isConnected && !recentlyAborted && ((!!lastMessage && isMessageStreaming(lastMessage)) || dbBusy || descendantBusy || (sessionId ? hasActiveSend(sessionId) : false));
  const sseEnabled = !!sessionId && !recentlyAborted && (hasActiveSend(sessionId) || isStreaming);
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
      // 첫 채팅 등에서 polling/SSE 경합으로 isStreaming이 잠깐 false→true로 튀는 경우 이중 트리거 방지 — 800ms 디바운스
      const debounce = setTimeout(() => {
        if (prevStreamingRef.current) return;
        if (!isCancel) {
          // working 공백(연결 흔들림·자식 세션 종료 등)에 complete가 아닌데 발송하지 않도록
          // 마지막 어시스턴트 메시지 finished + DB busy 아님을 재확인한다
          const cur = messagesRef.current;
          const last = cur?.[cur.length - 1] as any;
          const lastDone = !!last && last.info?.role === 'assistant' && !!((last.info?.time as any)?.completed);
          if (!lastDone) return;
          try {
            const statuses = queryClient.getQueryData<{ sessionId: string; status: string }[]>(["session-status-db"]);
            if (statuses?.some((s) => s.sessionId === sessionId && s.status === 'busy') === true) return;
          } catch {}
        }
        if (canSound) void playCompletionTick();
        if (canPush) {
          const title = isCancel ? '응답이 취소되었습니다' : '응답이 완료되었습니다'
          const repoLabel = repo ? (repo.repoUrl ? repo.repoUrl.split("/").pop()?.replace(".git","") || repo.localPath : repo.localPath) : (repoId ? `repo ${repoId}` : 'Workspace');
          const sessLabel = (session as unknown as { title?: string })?.title || 'Untitled Session';
          const body = `${repoLabel} · ${sessLabel}`;
          sendPushNotification(title, { body, tag: sessionId }, id ? `/repos/${id}/sessions/${sessionId}` : `/session/${sessionId}`, preferences?.pushNotificationDuration ?? 0)
        }
      }, 800);
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
      return () => { clearTimeout(debounce); clearTimeout(timer); };
    }
  }, [isStreaming, preferences, sessionId, repo, session, repoId, id]);

  // 첫 답변 완료 시 서버가 생성한 제목을 헤더에 동적 반영 (제목 없을 때만 refetch)
  const prevStreamingForTitleRef = useRef(false);
  useEffect(() => {
    const was = prevStreamingForTitleRef.current;
    prevStreamingForTitleRef.current = isStreaming;
    if (was && !isStreaming && sessionId) {
      const needTitle = () => {
        const cur = queryClient.getQueryData<{ title?: string }>(["opencode", "session", opcodeUrl, sessionId, repoDirectory]);
        const t = cur?.title;
        return !t || t === 'Untitled Session';
      };
      if (!needTitle()) return;
      queryClient.invalidateQueries({ queryKey: ["opencode", "session", opcodeUrl, sessionId, repoDirectory] });
      queryClient.invalidateQueries({ queryKey: ["opencode", "sessions", opcodeUrl, repoDirectory] });
      // 서버 제목 생성이 늦을 수 있어 4초 뒤 한 번 더 확인
      const timer = setTimeout(() => {
        if (needTitle()) {
          queryClient.invalidateQueries({ queryKey: ["opencode", "session", opcodeUrl, sessionId, repoDirectory] });
        }
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [isStreaming, sessionId, opcodeUrl, repoDirectory, queryClient]);

  // 권한 요청 도착 시 소리/푸시 — 자동승인 대상이면 OS 푸시 생략 (툴 알림 전 선조치)
  const prevPermissionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const pid = currentPermission?.id ?? null;
    if (pid && pid !== prevPermissionIdRef.current) {
      prevPermissionIdRef.current = pid;
      const permSnapshot = currentPermission
      setTimeout(async () => {
        if (prevPermissionIdRef.current !== pid) return;
        try {
          const { isPermissionAutoApprovable } = await import('@/hooks/useAutoApprovePermissions')
          if (permSnapshot && isPermissionAutoApprovable(permSnapshot as unknown as never)) return
        } catch {}
        // 스냅샷 시점과 현재가 다른 권한이면 무시 (이미 자동승인으로 제거된 경우)
        if (currentPermission?.id !== pid) return
        if (shouldPlaySound(sessionId, false, preferences ?? {}, repoId)) void playCompletionTick();
        if (shouldPush(sessionId, preferences ?? {}, repoId)) {
          const title = '승인이 필요합니다';
          const pattern = (currentPermission as unknown as { pattern?: string[]; permission?: string })?.pattern?.[0] ?? (currentPermission as unknown as { permission?: string })?.permission ?? '';
          const repoLabel = repo ? (repo.repoUrl ? repo.repoUrl.split("/").pop()?.replace(".git","") || repo.localPath : repo.localPath) : `repo ${repoId}`;
          const sessLabel = (session as unknown as { title?: string })?.title || sessionId?.slice(0,8) || '';
          const body = `${repoLabel} · ${sessLabel}${pattern ? ` — ${pattern}` : ''}`;
          sendPushNotification(title, { body, tag: `perm-${pid}` }, id ? `/repos/${id}/sessions/${sessionId}` : `/session/${sessionId}`, preferences?.pushNotificationDuration ?? 0);
        }
      }, 1200);
    } else if (!pid) {
      prevPermissionIdRef.current = null;
    }
  }, [currentPermission?.id, preferences, sessionId, repoId, currentPermission, repo, session]);

  // 질문 요청 도착 시에도 동일하게 알림
  const prevQuestionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const qid = currentQuestion?.id ?? null;
    if (qid && qid !== prevQuestionIdRef.current) {
      prevQuestionIdRef.current = qid;
      if (shouldPlaySound(sessionId, false, preferences ?? {}, repoId)) void playCompletionTick();
      if (shouldPush(sessionId, preferences ?? {}, repoId)) {
        const repoLabel = repo ? (repo.repoUrl ? repo.repoUrl.split("/").pop()?.replace(".git","") || repo.localPath : repo.localPath) : (repoId ? `repo ${repoId}` : 'Workspace');
        const sessLabel = (session as unknown as { title?: string })?.title || sessionId?.slice(0,8) || '';
        const body = `${repoLabel} · ${sessLabel}`;
        sendPushNotification('질문이 도착했습니다', { body, tag: `q-${qid}` }, id ? `/repos/${id}/sessions/${sessionId}` : `/session/${sessionId}`, preferences?.pushNotificationDuration ?? 0);
      }
    } else if (!qid) {
      prevQuestionIdRef.current = null;
    }
  }, [currentQuestion?.id, preferences, sessionId, repoId, currentQuestion, repo, session, id]);

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
      markSessionCompacted(sessionId)
      showToast.success("Session summarized (compact). Context cleaned up.", { duration: 4000 });
      setLengthModal({ open: false, messageId: null });
      setWindowStart(null);
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
  // ... 메뉴: 전체 내려받기 (윈도우와 무관하게 전체 메시지 기준)
  const handleExportFile = useCallback((format: SessionExportFormat | 'pdf') => {
    const list = messagesRef.current ?? messages;
    if (!list || list.length === 0) {
      showToast.error('No messages to export yet.');
      return;
    }
    const title = (session as unknown as { title?: string })?.title || 'Untitled Session';
    if (format === 'pdf') {
      if (!printSessionPdf(list, title)) {
        showToast.error('Popup blocked — allow popups for this site to print/PDF.');
      }
      return;
    }
    const content = format === 'md'
      ? buildSessionMarkdown(list, title)
      : format === 'html'
        ? buildSessionHtml(list, title, true)
        : buildSessionText(list, title);
    const mime = format === 'html' ? 'text/html' : format === 'md' ? 'text/markdown' : 'text/plain';
    downloadTextFile(sessionFileName(title, format), content, mime);
    showToast.success(`Exported ${list.length} message(s) as .${format}`);
  }, [messages, session]);
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

  const { scrollToBottom, markDisengaged } = useAutoScroll({
    containerRef: messageContainerRef,
    messages,
    sessionId,
    enabled: effectiveAutoScroll,
  });
  useEffect(() => { markDisengagedRef.current = markDisengaged }, [markDisengaged]);

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

  // 세션 첫 진입/새로고침 시 맨 아래로 스크롤 (?msg= / #message- 지정 진입은 그쪽 우선).
  // 반복 interval로 하단을 계속 강제하면 휠 스크롤과 싸우므로,
  // 즉시 1회 + 콘텐츠가 커질 때만 핀하고 실제 스크롤 제스처가 오면 영구 중단한다.
  // (pointerdown/click은 중단 조건에서 제외 — 클릭 한 번에 보호가 풀리면
  //  뒤늦은 이미지·폰트 성장을 못 따라가 새로고침 시 아래로 안 간다)
  const initialScrollDoneRef = useRef<string | null>(null)
  useEffect(() => {
    if (!baseMessages || baseMessages.length === 0) return
    if (initialScrollDoneRef.current === sessionId) return
    initialScrollDoneRef.current = sessionId!
    try {
      const sp = new URLSearchParams(window.location.search)
      const h = window.location.hash
      if (sp.get('msg') || h.startsWith('#message-') || h.startsWith('#msg=')) return
    } catch {}
    // 브라우저의 새로고침 스크롤 복원이 끼어들지 못하게 수동 모드
    try { history.scrollRestoration = 'manual' } catch {}
    const c = messageContainerRef.current
    if (!c) return
    let stopped = false
    const stop = () => { stopped = true }
    const pin = () => {
      if (stopped) return
      const cc = messageContainerRef.current
      if (cc) scrollToBottom()
    }
    pin()
    // 컨텐츠가 늘어나는 동안(최대 8s) 하단 유지 — 늦은 페인트·이미지·복원
    // 스크롤 대응. 커졌을 때만 핀하므로 휠과 싸우지 않고,
    // 사용자 스크롤이 오면 즉시 영구 중단한다.
    const t0 = Date.now()
    let lastH = c.scrollHeight
    const iv = setInterval(() => {
      const cc = messageContainerRef.current
      if (stopped || !cc || Date.now() - t0 > 8000) { clearInterval(iv); return }
      if (cc.scrollHeight !== lastH) { lastH = cc.scrollHeight; pin() }
    }, 300)
    // 컨테이너 내 이미지 로드가 끝나도 하단 유지 (capture 단계)
    const onLoadCapture = (e: Event) => {
      if ((e.target as HTMLElement)?.tagName === 'IMG') pin()
    }
    // 웹폰트 스왑으로 늦게 자라는 높이도 따라간다 (1회성)
    try {
      (document as Document).fonts?.ready.then(() => pin()).catch(() => {})
    } catch {}
    c.addEventListener('load', onLoadCapture, true)
    c.addEventListener('wheel', stop, { passive: true })
    c.addEventListener('touchmove', stop, { passive: true })
    return () => {
      clearInterval(iv)
      c.removeEventListener('load', onLoadCapture, true)
      c.removeEventListener('wheel', stop)
      c.removeEventListener('touchmove', stop)
    }
  }, [baseMessages?.length, sessionId, scrollToBottom])
  useEffect(() => { initialScrollDoneRef.current = null }, [sessionId])

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

  

  // 로그/검색/런 패널에서 해당 채팅으로 이동. 타겟이 윈도우 밖이면
  // 먼저 포함되게 옮기고(커밋 후 엘리먼트가 생긴다), 최대 12프레임 재시도한다.
  const scrollToMessage = useCallback((messageID: string) => {
    setHighlightedMessageID(messageID);
    markDisengaged();
    navLockUntilRef.current = Date.now() + 1200;
    const list = baseMessagesRef.current;
    if (list) {
      const idx = list.findIndex((m) => m.info.id === messageID);
      if (idx >= 0) {
        const len = list.length;
        const cur = windowStartRef.current ?? Math.max(0, len - WINDOW_SIZE);
        if (idx < cur || idx >= cur + WINDOW_SIZE) {
          setWindowStart(Math.max(0, Math.min(idx - 5, len - WINDOW_SIZE)));
        }
      }
    }
    let tries = 0;
    const attempt = () => {
      const el = document.getElementById(`message-${messageID}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (tries++ < 30) requestAnimationFrame(attempt);
    };
    requestAnimationFrame(() => requestAnimationFrame(attempt));
  }, [markDisengaged]);

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
    // 윈도우 포함 + 스크롤 재시도는 scrollToMessage가 담당하므로
    // 여기서는 파라미터만 소비한다 (재실행돼도 clear済라 바로 리턴, 루프 없음)
    if (msgFromQuery) setSearchParams({}, { replace: true });
    if (msgFromHash) history.replaceState(null, '', window.location.pathname + window.location.search);
    scrollToMessage(msgID);
  }, [searchParams, setSearchParams, messages, baseMessages, scrollToMessage]);

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

    const allFiles = Array.from(files)
    const freshFiles = allFiles.filter((f) => !isUploadInFlight(f))
    if (freshFiles.length < allFiles.length) {
      showToast.info(`이미 업로드 중인 ${allFiles.length - freshFiles.length}개 파일은 제외합니다`)
    }
    if (freshFiles.length === 0) return

    // 영역을 즉시 띄우고 (첫 paint 확보), 진행 콜백은 스로틀로 렌더 폭풍 방지
    setGlobalUpload({ name: freshFiles[0].name, loaded: 0, total: freshFiles[0].size || 1, index: 1, count: freshFiles.length })
    let lastProgAt = 0
    for (let i = 0; i < freshFiles.length; i++) {
      const file = freshFiles[i]
      setGlobalUpload({ name: file.name, loaded: 0, total: file.size || 1, index: i + 1, count: freshFiles.length })
      try {
        const data = await uploadFileWithProgress(`${API_BASE_URL}/api/files/${uploadDir}`, file, (loaded, total) => {
          const now = Date.now()
          if (now - lastProgAt < 150) return
          lastProgAt = now
          setGlobalUpload({ name: file.name, loaded, total: total || file.size || 1, index: i + 1, count: freshFiles.length })
        })
        const savedName: string = data?.name || file.name
        results.push({ name: savedName, path: `chat_uploads/${savedName}` })
      } catch (e) {
        if (e instanceof DuplicateUploadError) continue
        if (!lastError) lastError = e instanceof Error ? e.message : 'Upload failed'
        continue
      }
    }
    setGlobalUpload(null)

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
      {ctx.contextLimit != null && (ctx.usagePercentage ?? 0) >= 90 && (
        <div className={`px-4 py-1.5 text-xs flex items-center gap-2 border-b shrink-0 ${(ctx.usagePercentage ?? 0) >= 95 ? 'bg-red-500/10 border-red-500/30 text-red-400' : 'bg-yellow-500/10 border-yellow-500/30 text-yellow-600 dark:text-yellow-400'}`}>
          <span className="flex-1 min-w-0 truncate">
            {(ctx.usagePercentage ?? 0) >= 95
              ? `Context ${Math.round(ctx.usagePercentage ?? 0)}% (${ctx.totalTokens.toLocaleString()} / ${ctx.contextLimit.toLocaleString()}) — sending is blocked. Compact or start a new session.`
              : `Context ${Math.round(ctx.usagePercentage ?? 0)}% (${ctx.totalTokens.toLocaleString()} / ${ctx.contextLimit.toLocaleString()}) — compact을 권장합니다.`}
          </span>
          <button
            onClick={handleCompact}
            disabled={isCompacting}
            className="px-2 py-1 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 disabled:opacity-50 shrink-0"
          >
            {isCompacting ? 'Compacting…' : 'Compact'}
          </button>
          <button
            onClick={() => handleNewSession()}
            className="px-2 py-1 rounded-md bg-blue-600 text-white text-[11px] font-medium hover:bg-blue-700 shrink-0"
          >
            New Session
          </button>
        </div>
      )}

      <div ref={splitContainerRef} className="flex-1 overflow-hidden flex relative">
        <div className="flex-1 overflow-hidden flex flex-col relative min-w-0">
          <UntrackedSuggestionBanner />
          <div key={sessionId} ref={messageContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain" style={{ paddingBottom: inputH + (windowStart !== null ? 76 : 24) }}>
            {/* 상단 고정 바: Load more + … 나란히 중앙 */}
            <div className="sticky top-0 z-10 flex items-center justify-center gap-2 py-2 bg-gradient-to-b from-background to-transparent">
              {hasMore && baseMessages && (
                <button
                  onClick={handleLoadMore}
                  className="text-xs px-3 py-1.5 rounded-full border bg-card hover:bg-accent text-muted-foreground hover:text-foreground shadow-sm"
                >
                  <span className="sm:hidden">Load more</span>
                  <span className="hidden sm:inline">Load more — {hiddenCount} older message{hiddenCount !== 1 ? "s" : ""} hidden · click or scroll up</span>
                </button>
              )}
              <SessionMoreMenu
                onExport={handleExportFile}
                onOpenJump={() => setJumpOpen(true)}
                triggerClassName="inline-flex items-center px-2 py-1.5 rounded-full border bg-card shadow-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
              />
            </div>
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
            {windowStart !== null && baseMessages && (
              <div className="sticky z-10 flex justify-center gap-2 py-2 bg-gradient-to-t from-background to-transparent" style={{ bottom: inputH }}>
                <button
                  onClick={shiftWindowDown}
                  className="text-xs px-3 py-1.5 rounded-full border bg-card hover:bg-accent text-muted-foreground hover:text-foreground shadow-sm"
                >
                  <span className="sm:hidden">Show newer</span>
                  <span className="hidden sm:inline">Show newer · scroll down</span>
                </button>
                <button
                  onClick={() => {
                    pendingLatestPinRef.current = true;
                    setWindowStart(null);
                  }}
                  className="text-xs px-3 py-1.5 rounded-full border bg-card hover:bg-accent text-muted-foreground hover:text-foreground shadow-sm"
                >
                  <span className="sm:hidden">Back</span>
                  <span className="hidden sm:inline">Back to latest</span>
                </button>
              </div>
            )}
          </div>
          {opcodeUrl && repoDirectory && (
            <div ref={inputWrapRef} className={`absolute bottom-0 left-0 right-0 flex justify-center pb-1 pointer-events-none ${windowStart !== null ? "bg-background/80 backdrop-blur-sm" : ""}`}>
              <div className="contents pointer-events-auto">
              <PromptInput
                opcodeUrl={opcodeUrl}
                directory={repoDirectory}
                uploadDir={`${repo.localPath}/chat_uploads`}
                sessionID={sessionId}
                disabled={!isConnected}
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
          {globalUpload && (
            <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-40 w-[320px] max-w-[80%] px-3 py-2 rounded-lg text-xs bg-blue-500/10 border border-blue-500/30 text-blue-600 dark:text-blue-400 backdrop-blur-md">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="truncate">업로드 중 {globalUpload.index}/{globalUpload.count} — {globalUpload.name}</span>
                <span className="font-mono shrink-0">{Math.round((globalUpload.loaded / Math.max(globalUpload.total, 1)) * 100)}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-blue-500/20 overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-[width]"
                  style={{ width: `${Math.min(100, Math.round((globalUpload.loaded / Math.max(globalUpload.total, 1)) * 100))}%` }}
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
      <SessionJumpDialog
        open={jumpOpen}
        onClose={() => setJumpOpen(false)}
        messages={messages}
        onJump={(id) => {
          // 모달(스크롤 잠금·포커스 복원·닫힘 애니메이션)이 끝난 뒤 이동해야
          // smooth 스크롤이 중간에 끊기거나 무시되지 않는다.
          setJumpOpen(false);
          setTimeout(() => scrollToMessage(id), 250);
        }}
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
