import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { OpenCodeClient } from "../api/opencode";
import type {
  MessageWithParts,
  MessageListResponse,
  ContentPart,
} from "../api/types";
import type { paths } from "../api/opencode-types";
import { showToast } from "@/lib/toast"
import { markSessionIdle } from "./useSessionActivity"
import { clearSessionNotifyData } from "@/lib/notifications"
import { listSessionStatuses } from "@/api/session-status"
import { stripMemoryRecall } from "@/lib/stripRecall"
import { API_BASE_URL } from "@/config"


type SendPromptRequest = NonNullable<
  paths["/session/{id}/message"]["post"]["requestBody"]
>["content"]["application/json"];

/** ?��? abort 직후 ?�링??미처�??�태�??�살??뱃�?가 깜빡?�는 것을 막는 가?? */
const RECENTLY_ABORTED_MS = 12_000;
const recentlyAborted = new Map<string, number>();

/** ?�송 중인 ?��? user 메시지. 2s ?�링??캐시�???��?�도 ?��??�다. */
const pendingOptimistic = new Map<string, MessageWithParts>();

const activeSendControllers = new Map<string, AbortController>();
const activeSSEMap = new Map<string, EventSource>();

export function abortActiveSend(sessionID: string): void {
  const ac = activeSendControllers.get(sessionID)
  if (ac) {
    ac.abort()
    activeSendControllers.delete(sessionID)
  }
  const es = activeSSEMap.get(sessionID)
  if (es) {
    try { es.close(); } catch {}
    activeSSEMap.delete(sessionID)
  }
  pendingOptimistic.delete(sessionID)
}

/**
 * cancel 시점에 잡아둔 인스턴스만 중단한다. abort POST가 늦게 끝나
 * onSettled가 돌 때 사용자가 이미 새로 보낸 턴이 있으면, 그 턴의
 * AbortController/EventSource는 절대 건드리지 않는다 (신규 메시지 오폭 방지).
 * map에 잡아둔 것과 같은 인스턴스가 남아 있을 때만 엔트리를 지운다.
 */
export function abortSpecificSend(
  sessionID: string,
  targets?: { ac?: AbortController | null; es?: EventSource | null },
): void {
  const ac = targets?.ac
  if (ac) {
    try { ac.abort() } catch {}
    if (activeSendControllers.get(sessionID) === ac) activeSendControllers.delete(sessionID)
  }
  const es = targets?.es
  if (es) {
    try { es.close(); } catch {}
    if (activeSSEMap.get(sessionID) === es) activeSSEMap.delete(sessionID)
  }
}

/** 거�? 문자??join ?�이 길이�??�산 ???�링마다 MB�?join ?�당 방�?.
 *  join('').length === �?길이???�이므�?길이 비교 ?�정 결과???�일?�다. */
function textPartsLength(parts: MessageWithParts["parts"]): number {
  let n = 0
  for (const p of parts) {
    if ((p as { type?: string }).type !== "text") continue
    n += ((p as { text?: string }).text ?? "").length
  }
  return n
}

function toolOutputLength(parts: MessageWithParts["parts"]): number {
  let n = 0
  for (const p of parts) {
    if ((p as { type?: string }).type !== "tool") continue
    const st = (p as { state?: { output?: string; metadata?: { output?: string } } }).state
    n += (st?.output ?? st?.metadata?.output ?? "").length
  }
  return n
}

/** SSE가 ?�버?�만 ?�는 ??메시지�?가리키�?가�?카드�?만들지 ?�고 목록 refetch�?
 *  ?�당�?�??�용??빨리 가?�온?? reasoning?�??�작 지?�이 ?��?�?300ms,
 *  �??�는 ?�션??800ms ?�로?��?refetch ??���?막는?? */
const lastFastPullAt = new Map<string, number>();
const lastReasoningPullAt = new Map<string, number>();
function fastPullMessages(
  queryClient: ReturnType<typeof useQueryClient>,
  opcodeUrl: string | null | undefined,
  sessionID: string,
  directory?: string,
  isReasoning: boolean = false,
) {
  const now = Date.now();
  // reasoning SSE??별도 300ms ?�로?�????�작 지??체감???��?�????�주 ?�긴??
  if (isReasoning) {
    if (now - (lastReasoningPullAt.get(sessionID) ?? 0) < 300) return;
    lastReasoningPullAt.set(sessionID, now);
  } else {
    if (now - (lastFastPullAt.get(sessionID) ?? 0) < 800) return;
    lastFastPullAt.set(sessionID, now);
  }
  queryClient.invalidateQueries({ queryKey: ["opencode", "messages", opcodeUrl, sessionID, directory] });
}

/** truncate 직후 opencode 메모리�? ??목록???�려�????�어 뷰�? ?��??�는 가??
 *  ?�간???�닌 "?�거??메시지 ID" 기�??�로 걸러 ??메시지??즉시 ?�과?�다. */
const RECENTLY_TRUNCATED_MS = 12_000;
const recentlyTruncated = new Map<string, { until: number; removedIds: Set<string> }>();

function applyTruncationWindow(
  sessionID: string,
  data: MessageListResponse,
): MessageListResponse {
  const entry = recentlyTruncated.get(sessionID);
  if (!entry) return data;
  if (Date.now() > entry.until) {
    recentlyTruncated.delete(sessionID);
    return data;
  }
  return data.filter((m) => !entry.removedIds.has(m.info.id));
}

export function isRecentlyAborted(sessionID: string): boolean {
  const at = recentlyAborted.get(sessionID);
  if (!at) return false;
  if (Date.now() - at > RECENTLY_ABORTED_MS) {
    recentlyAborted.delete(sessionID);
    return false;
  }
  return true;
}

type PromptPart = NonNullable<SendPromptRequest["parts"]>[number];

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  xml: "application/xml",
  csv: "text/csv",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  jsx: "text/javascript",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

function mimeForFilename(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  return MIME_BY_EXT[ext] ?? "application/octet-stream"
}

// opencode providers only accept image/*, audio/*, text/* and application/pdf
// as inline file parts. Everything else (office docs, json, binaries) must go
// as a text mention so the agent can read it with doc-reader instead of the
// request failing with "file part media type ... not supported".
function canSendAsFilePart(mime: string): boolean {
  return (
    mime === "application/pdf" ||
    mime.startsWith("image/") ||
    mime.startsWith("audio/") ||
    mime.startsWith("text/")
  )
}

function isAbortCancellation(error: unknown): boolean {
  if (error && typeof error === "object") {
    const code = (error as { code?: string }).code
    if (code === "ERR_CANCELED" || code === "ECONNABORTED") return true
    const message = (error as { message?: string }).message
    if (typeof message === "string" && /cancel|abort/i.test(message)) return true
  }
  return false
}

function isProxyTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const anyErr = error as Record<string, unknown>
  const status = (anyErr.response as { status?: number } | undefined)?.status
  if (status === 504) {
    const data = (anyErr.response as { data?: unknown } | undefined)?.data as Record<string, unknown> | undefined
    const msg = ((data?.error as string) || (data?.message as string) || (anyErr.message as string) || '').toLowerCase()
    if (msg.includes('proxy timeout') || msg.includes('600s') || msg.includes('gateway timeout')) return true
  }
  const msg = ((anyErr.message as string) || '').toLowerCase()
  return msg.includes('[backend proxy] gateway timeout') || msg.includes('proxy timeout')
}

// Format server error similar to OpenCode's formatServerError - 40x provider-agnostic
function extractProviderMessage(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined
  const d = data as Record<string, unknown>
  if (typeof d.message === "string" && d.message.trim()) return d.message.trim()
  if (typeof d.error === "string" && d.error.trim()) return d.error.trim()
  if (d.error && typeof d.error === "object") {
    const e = d.error as Record<string, unknown>
    if (typeof e.message === "string" && e.message.trim()) return e.message.trim()
  }
  if (typeof d._tag === "string" && d._tag.trim()) return d._tag.trim()
  return undefined
}

function isBillingQuotaMessage(msg: string): boolean {
  const m = msg.toLowerCase()
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
  )
}

function formatServerError(error: unknown): string {
  if (error && typeof error === "object" && "response" in error) {
    const axiosError = error as { response?: { data?: unknown; status?: number; headers?: Record<string, string> } }
    const status = axiosError.response?.status
    const data = axiosError.response?.data
    const providerMsg = extractProviderMessage(data)

    if (providerMsg) {
      if (isBillingQuotaMessage(providerMsg)) {
        return providerMsg + " - free quota/balance exhausted. Payment required. (Zen: https://opencode.ai/zen / OpenRouter: https://openrouter.ai/credits)"
      }
      return providerMsg
    }

    if (typeof status === "number") {
      if (status === 400) return "Bad Request (400). Check model ID or parameters."
      if (status === 401) return "Authentication failed (401). Check your API key."
      if (status === 402) return "Payment Required (402). Insufficient balance - please add credits. (https://opencode.ai/zen)"
      if (status === 403) return "Access denied (403). No permission for this model/feature."
      if (status === 404) return "Not Found (404). Check model ID or endpoint."
      if (status === 408) return "Request Timeout (408). Please retry."
      if (status === 413) return "Payload Too Large (413). Reduce context length."
      if (status === 422) return "Unprocessable (422). Check parameter values."
      if (status === 429) return "Rate limit exceeded (429). Please wait or check your quota."
      if (status >= 400 && status < 500) return "Client error (" + status + "). Check your request."
      if (status === 500) return "Server error (500). Provider failure - retry later."
      if (status === 502) return "Bad Gateway (502). Cannot connect to OpenCode server - check backend status."
      if (status === 503) return "Service Unavailable (503). Provider overloaded - retry later."
      if (status === 504) return "Gateway Timeout (504). Please retry."
      if (status >= 500) return "Server error (" + status + "). Please retry later."
    }
  }
  if (error instanceof Error && error.message) {
    if (isBillingQuotaMessage(error.message)) {
      return error.message + " - payment/recharge required."
    }
    return error.message
  }
  if (typeof error === "string" && error.length > 0) {
    if (isBillingQuotaMessage(error)) return error + " - payment/recharge required."
    return error
  }
  return "An unexpected error occurred."
}

export const useOpenCodeClient = (opcodeUrl: string | null | undefined, directory?: string) => {
  return useMemo(
    () => (opcodeUrl ? new OpenCodeClient(opcodeUrl, directory) : null),
    [opcodeUrl, directory],
  );
};

export function isInterruptedMessage(msg: MessageWithParts | undefined | null): boolean {
  if (!msg) return false
  if (msg.info.role !== 'assistant') return false
  if ("completed" in msg.info.time && msg.info.time.completed) return false
  return true
}

export async function continueInterruptedSession(
  client: OpenCodeClient,
  sessionID: string,
): Promise<boolean> {
  try {
    const status = await client.getSessionStatus()
    if (status[sessionID]?.type === 'busy') return false
    const messages = await client.listMessages(sessionID)
    const last = messages[messages.length - 1]
    if (!isInterruptedMessage(last)) return false
    await client.sendPrompt(sessionID, { parts: [{ type: 'text', text: 'Continue' }] })
    return true
  } catch {
    return false
  }
}

export const useSessions = (opcodeUrl: string | null | undefined, directory?: string) => {
  const client = useOpenCodeClient(opcodeUrl, directory);

  return useQuery({
    queryKey: ["opencode", "sessions", opcodeUrl, directory],
    queryFn: () => client!.listSessions(),
    enabled: !!client,
    refetchInterval: 2000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 5000,
  });
};

export const useSession = (opcodeUrl: string | null | undefined, sessionID: string | undefined, directory?: string) => {
  const client = useOpenCodeClient(opcodeUrl, directory);

  return useQuery({
    queryKey: ["opencode", "session", opcodeUrl, sessionID, directory],
    queryFn: () => client!.getSession(sessionID!),
    enabled: !!client && !!sessionID,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 5000,
  });
};

export const useMessages = (opcodeUrl: string | null | undefined, sessionID: string | undefined, directory?: string) => {
  const client = useOpenCodeClient(opcodeUrl, directory);
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: ["opencode", "messages", opcodeUrl, sessionID, directory],
    queryFn: async () => {
      // 백엔??캐시�?경유??가?�온?????�론???�링??opencode ?�벤?�루?��? ?�리지 ?�는??
      const dirQs = directory ? `?directory=${encodeURIComponent(directory)}` : '';
      const res = await fetch(`${API_BASE_URL}/api/session-messages/${sessionID!}${dirQs}`);
      if (!res.ok) throw new Error('Failed to load messages');
      const data = (await res.json()) as MessageListResponse;
      let result = applyTruncationWindow(sessionID!, data);
      const cached = queryClient.getQueryData<MessageListResponse>(["opencode", "messages", opcodeUrl, sessionID, directory]);
      if (cached && result.length > 0 && cached.length > 0) {
        const cachedLast = cached[cached.length - 1]!;
        const resultLast = result[result.length - 1]!;
        if (cachedLast.info.id === resultLast.info.id && cachedLast.parts.length > resultLast.parts.length) {
          result = [...result.slice(0, -1), cachedLast];
        } else if (cachedLast.info.id === resultLast.info.id) {
          // 길이 ?�산?�로�?비교 ??join?�?거�? ?�당?�라 길이 ?�정?�는 ?��? ?�는??
          const cTextLen = textPartsLength(cachedLast.parts);
          const rTextLen = textPartsLength(resultLast.parts);
          const cToolLen = toolOutputLength(cachedLast.parts);
          const rToolLen = toolOutputLength(resultLast.parts);
          if (cTextLen > rTextLen || cToolLen > rToolLen) result = [...result.slice(0, -1), cachedLast];
        }
      }
      const optimistic = pendingOptimistic.get(sessionID!);
      let realUserArrived = false;
      if (optimistic) {
        const optimisticCreated = optimistic.info.time?.created ?? 0;
        const getSignature = (parts: MessageWithParts["parts"]) => parts
          .map((p) => {
            const t = (p as { type?: string }).type
            if (t === "text") return stripMemoryRecall(((p as { text?: string }).text ?? "").trim())
            if (t === "file") return ((p as { filename?: string }).filename ?? "").trim()
            return ""
          })
          .filter(Boolean)
          .join("\n")
        const optimisticSig = getSignature(optimistic.parts as unknown as MessageWithParts["parts"]);
        realUserArrived = result.some((m) => {
          if (m.info.role !== "user" || m.info.id === optimistic.info.id) return false;
          if (m.info.id.startsWith("optimistic_sending_")) return false;
          const created = m.info.time?.created ?? 0;
          if (Math.abs(created - optimisticCreated) > 60000) return false;
          // ?�전 ?�의 user 메시지�??�번 ?�송?�로 ?�인?��? ?�도�??�버 반영 ?�각?�?
          // optimistic ?�성 ?�각 ?�후?�야 ?�다 (?�록 ?�차 2s ?�용).
          if (created < optimisticCreated - 2000) return false;
          if (!optimisticSig) return true;
          const text = getSignature(m.parts as unknown as MessageWithParts["parts"]);
          if (text === optimisticSig) return true;
          if (Math.abs(created - optimisticCreated) < 5000) return true;
          return false;
        });
        if (!realUserArrived) {
          // ?��? ?�송 ?�후???�성???�제 ?�버 메시지가 ?�으�??�이 진행??�?
          // ?�명/?�각 매칭??빗나가???�린 반영·?�일멘션 변?�·큐 지??발송)
          // placeholder???�린????붙들�??�으�??�구 ?�류?�고
          // hasActiveSend?�WORKING까�? 고착?�다. strict > �??�전 ???�인 방�?.
          const oc = optimistic.info.time?.created ?? 0;
          realUserArrived = result.some((m) => {
            if (m.info.id === optimistic.info.id || m.info.id.startsWith("optimistic_")) return false;
            return (m.info.time?.created ?? 0) > oc;
          });
        }
      }
      if (optimistic && !realUserArrived) {
        // ?�버???�직 반영??user 메시지가 ?�으�?sending placeholder�?refetch
        // 결과???�시 붙인?? �?refetch(500ms)?�서 ??채팅???�라졌다 ?��??�는
        // 깜빡???�이 "??채팅(sending) ???�버 반영 ??교체"�??�정?�게 ?��??�다.
        // ?? ??분이 지?�도 반영?��? ?�으�??�실???�송?�로 보고 중단?�다.
        // (기존 30s ?�리???�전 ??메시지???�아 건너?????�어 ?�구 ?�류?�다.
        //  ?�류?�면 hasActiveSend?�WORKING까�? 계속 켜진??)
        // ?�제 ?�버 메시지가 ?�중???�면 ?�상 ?�더?�다 ??placeholder???�시 UI??�?
        const optimisticCreated = optimistic.info.time?.created ?? 0;
        if (optimisticCreated > 0 && Date.now() - optimisticCreated > 120000) {
          pendingOptimistic.delete(sessionID!);
        } else {
          result = [...result, {
            info: {
              id: `optimistic_sending_${optimistic.info.id}`,
              role: "user" as const,
              sessionID: sessionID!,
              time: { created: optimistic.info.time?.created ?? Date.now() },
            } as MessageWithParts["info"],
            parts: optimistic.parts,
          } as MessageWithParts];
        }
      } else if (result.some((m) => m.info.id.startsWith("optimistic_sending_"))) {
        result = result.filter((m) => !m.info.id.startsWith("optimistic_sending_"))
      }
      if (realUserArrived) {
        pendingOptimistic.delete(sessionID!)
      }
      const statuses = queryClient.getQueryData<{ sessionId: string; status: string }[]>(["session-status-db"])
      const isBusy = statuses?.some((s) => s.sessionId === sessionID && s.status === "busy") ?? false
      const hasPending = pendingOptimistic.has(sessionID!) || activeSendControllers.has(sessionID!)
      if (isRecentlyAborted(sessionID!)) {
        return reconcileOrphanedStreams(result, sessionID!, false);
      }
      if (hasPending) return reconcileOrphanedStreams(result, sessionID!, true)
      return reconcileOrphanedStreams(result, sessionID!, isBusy);
    },
    enabled: !!client && !!sessionID,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // 복�? ??캐시가 ?�아가 ?�피??+ 처음부???�시 로드?�는 체감??줄이??30�??��?.
    // ?�션 ?�환 ??inactive 쿼리??SessionDetail?�서 직접 ?�거?��?�?메모�??�수 ?�음.
    gcTime: 5 * 60 * 1000,
    placeholderData: (previousData) => previousData,
    staleTime: 2000,
    refetchInterval: (query) => {
      if (isRecentlyAborted(sessionID!)) return 2000
      const data = query.state.data as MessageListResponse | undefined
      const last = data?.[data.length - 1] as unknown as { info: { role: string; time: Record<string, unknown> }; parts: { type: string }[] } | undefined
      const hasReasoning = !!last?.parts?.some((p) => p.type === 'reasoning')
      const hasPending = pendingOptimistic.has(sessionID!) || activeSendControllers.has(sessionID!)
      if (hasPending) return hasReasoning ? 500 : 1500
      const streaming = last ? !('completed' in (last.info.time as Record<string, unknown>) && (last.info.time as { completed?: number }).completed) && last.info.role === 'assistant' : false
      if (hasReasoning && streaming) return 500
      if (streaming) return 1000
      const statuses = queryClient.getQueryData<{ sessionId: string; status: string }[]>(["session-status-db"])
      const dbBusy = statuses?.some((s) => s.sessionId === sessionID && s.status === "busy") ?? false
      if (dbBusy) return 1000
      // 완전 idle이면 10초로 늦춘다 — 2초마다 전체 목록 파싱이 긴 세션에서
      // 힙을 계속 부풀리는 주범이다. 스트리밍/전송/busy는 위에서 빠른 주기 유지.
      // (TUI 등 외부 변경은 최대 10초 늦게 반영, 상태 배지는 별도 2초 폴링 유지)
      return 10000
    },
  });
};

export const usePollLastMessage = (
  opcodeUrl: string | null | undefined,
  sessionID: string | undefined,
  directory?: string,
  enabled?: boolean,
) => {
  const client = useOpenCodeClient(opcodeUrl, directory);
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ["opencode", "last-message", opcodeUrl, sessionID, directory],
    queryFn: async () => {
      const all = queryClient.getQueryData<MessageListResponse>(["opencode", "messages", opcodeUrl, sessionID, directory])
      const last = all?.[all.length - 1]
      if (!last) return null
      if (last.info.id.startsWith("optimistic_")) return null
      if ('completed' in (last.info.time as Record<string, unknown>) && (last.info.time as { completed?: number }).completed) return null
      try {
        const msg = await client!.getMessage(sessionID!, last.info.id)
        const merged: MessageListResponse = all ? [...all.slice(0, -1), msg as MessageWithParts] : [msg as MessageWithParts]
        queryClient.setQueryData(["opencode", "messages", opcodeUrl, sessionID, directory], (old: MessageListResponse | undefined) => {
          if (!old || old.length === 0) return merged
          const curLast = old[old.length - 1]
          if (curLast.info.id !== last.info.id) return old
          const curCompleted = 'completed' in (curLast.info.time as Record<string, unknown>) && Boolean((curLast.info.time as { completed?: number }).completed)
          const nextCompleted = 'completed' in (msg.info.time as Record<string, unknown>) && Boolean((msg.info as { time: { completed?: number } }).time.completed)
          // SSE가 ?�서 ?��? ?�으�??�링 결과가 ??��?��? ?�도�?보존 ???�전?�는 ?�일 ?�스?�일 ?�만 ?��???SSE 증분???�아갔다
          // 길이가 ?�르�?join ?�이 ?�정 (?�트리밍 �?99%????경로), 같을 ?�만 ?�용 ?�등 ?�인
          const curTextLen = textPartsLength(curLast.parts)
          const nextTextLen = textPartsLength(msg.parts as MessageWithParts["parts"])
          const curToolLen = toolOutputLength(curLast.parts)
          const nextToolLen = toolOutputLength(msg.parts as MessageWithParts["parts"])
          if (curLast.parts.length === msg.parts.length && curCompleted === nextCompleted && curTextLen === nextTextLen && curToolLen === nextToolLen) {
            const curText = curLast.parts.filter((p: unknown) => (p as { type: string }).type === 'text').map((p: unknown) => (p as { text: string }).text ?? '').join('')
            const nextText = (msg.parts as unknown[]).filter((p: unknown) => (p as { type: string }).type === 'text').map((p: unknown) => (p as { text: string }).text ?? '').join('')
            const curTool = curLast.parts.filter((p: unknown) => (p as { type: string }).type === 'tool').map((p: unknown) => ((p as unknown as { state?: { output?: string; metadata?: { output?: string } } }).state?.output ?? (p as unknown as { state?: { metadata?: { output?: string } } }).state?.metadata?.output ?? '')).join('')
            const nextTool = (msg.parts as unknown[]).filter((p: unknown) => (p as { type: string }).type === 'tool').map((p: unknown) => ((p as unknown as { state?: { output?: string; metadata?: { output?: string } } }).state?.output ?? (p as unknown as { state?: { metadata?: { output?: string } } }).state?.metadata?.output ?? '')).join('')
            if (curText === nextText && curTool === nextTool) return old
          }
          // SSE가 ??길면 ?�버 ?�답??lagging ????��?��? ?�는??
          if (curTextLen > nextTextLen || curToolLen > nextToolLen) return old
          // ?�버가 ??길거???�료 ?�태가 바뀌었???�만 교체
          return [...old.slice(0, -1), msg as MessageWithParts]
        })
        return msg
      } catch {
        return null
      }
    },
    enabled: !!client && !!sessionID && !!enabled,
    refetchInterval: 380,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 0,
  });
};

function reconcileOrphanedStreams(
  messages: MessageListResponse,
  sessionID: string,
  isBusy: boolean,
): MessageListResponse {
  let changed = false;
  // 0-part 미완�?assistant(ghost)??busy ?�안 마�?�?것만 ?��???LLM ?�답 ?�역??
  // 바로 보여준??(?�버???�이 ?�긴 honest ?�호 ??가�?카드가 ?�니??.
  // idle???�면 ?�거???�류 ?��???막고, 캐시???�는 ?�트??SSE ?��? ?�성?�?merge ?�계?�서 차단?�다.
  const filtered = messages.filter((msg, idx) => {
    const ghost =
      msg.info.sessionID === sessionID &&
      msg.info.role === "assistant" &&
      !("completed" in msg.info.time && msg.info.time.completed) &&
      msg.parts.length === 0;
    if (!ghost) return true;
    // busy ?�안 마�?�?ghost???��? (LLM ?�답 ?�역 즉시 ?�시)
    if (isBusy && idx === messages.length - 1) return true;
    changed = true;
    return false;
  });
  if (isBusy) return changed ? filtered : messages;
  const updated = filtered.map((msg): MessageWithParts => {
    if (msg.info.sessionID !== sessionID) return msg;
    if (msg.info.role !== "assistant") return msg;
    if ("completed" in msg.info.time && msg.info.time.completed) return msg;
    changed = true;
    const parts = msg.parts.map((part) => {
      if (part.type === "tool" && part.state?.status === "running") {
        // input/command/output?�??��??�고 ?�태�?error�??�집?�다.
        // ?�째�?갈아?�으�?중단???�의 명령???�면?�서 ?�라진다.
        return {
          ...part,
          state: { ...part.state, status: "error" as const, error: "Run was interrupted" },
        } as MessageWithParts["parts"][number];
      }
      return part;
    });
    return {
      ...msg,
      info: {
        ...msg.info,
        time: { ...msg.info.time, completed: msg.info.time.created ?? Date.now() },
      },
      parts,
    };
  });
  return changed ? updated : messages;
}

export const useReconcileOrphanedStreams = (opcodeUrl: string | null | undefined, directory?: string) => {
  const client = useOpenCodeClient(opcodeUrl, directory);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!client) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const status = await client.getSessionStatus();
        if (cancelled || !status) return;
        const queries = queryClient.getQueryCache().getAll();
        for (const query of queries) {
          const key = query.queryKey;
          if (key[0] !== "opencode" || key[1] !== "messages") continue;
          if (key[2] !== opcodeUrl || key[4] !== directory) continue;
          const sessionID = key[3];
          if (typeof sessionID !== "string" || !sessionID) continue;
          if (status[sessionID]?.type === "busy") continue;
          const data = query.state.data as MessageListResponse | undefined;
          if (!data) continue;
          const reconciled = reconcileOrphanedStreams(data, sessionID, false);
          if (reconciled !== data) {
            queryClient.setQueryData(key, reconciled);
            markSessionIdle(sessionID);
          }
        }
      } catch {
        // status endpoint unavailable; skip this cycle
      }
    };

    tick();
    const interval = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [client, queryClient, opcodeUrl, directory]);
};

export const useCreateSession = (opcodeUrl: string | null | undefined, directory?: string) => {
  const client = useOpenCodeClient(opcodeUrl, directory);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: {
      title?: string;
      agent?: string;
      model?: string;
    }) => {
      if (!client) throw new Error("No client available");
      return client.createSession(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["opencode", "sessions", opcodeUrl, directory] });
    },
  });
};

export const useDeleteSession = (opcodeUrl: string | null | undefined, directory?: string) => {
  const queryClient = useQueryClient();
  const client = useOpenCodeClient(opcodeUrl, directory);

  return useMutation({
    mutationFn: async (arg: string | string[] | { ids: string | string[]; withIndex?: boolean }) => {
      if (!client) {
        throw new Error('OpenCode client not available');
      }
      const withIndex = typeof arg === 'object' && !Array.isArray(arg) && 'ids' in arg ? (arg.withIndex !== false) : true
      const rawIds = typeof arg === 'object' && !Array.isArray(arg) && 'ids' in arg ? arg.ids : (arg as string | string[])
      const ids = Array.isArray(rawIds) ? rawIds : [rawIds]
      
      const deletePromises = ids.map(async (sessionID) => {
        await client.deleteSession(sessionID, { withIndex });
      })
      
      const results = await Promise.allSettled(deletePromises)
      const failures = results.filter(result => result.status === 'rejected')
      
      if (failures.length > 0) {
        throw new Error(`Failed to delete ${failures.length} session(s)`)
      }
      
      return results
    },
    onSuccess: (_data, variables) => {
      const raw = typeof variables === 'object' && !Array.isArray(variables) && variables !== null && 'ids' in (variables as any) ? (variables as any).ids : variables
      const ids = Array.isArray(raw) ? raw : [raw];
      try {
        for (const sid of ids) clearSessionNotifyData(String(sid))
      } catch {}
      const sessionsKey = ["opencode", "sessions", opcodeUrl, directory] as const;
      const current = queryClient.getQueryData<{ id: string }[]>(sessionsKey);
      if (current) {
        queryClient.setQueryData(
          sessionsKey,
          current.filter((s) => !ids.includes(s.id)),
        );
      }
      queryClient.invalidateQueries({ queryKey: sessionsKey });
    },
  });
};

export const useSummarizeSession = (opcodeUrl: string | null | undefined, directory?: string) => {
  const client = useOpenCodeClient(opcodeUrl, directory);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionID, providerID, modelID }: { sessionID: string; providerID: string; modelID: string }) => {
      if (!client) throw new Error("No client available");
      return client.summarizeSession(sessionID, providerID, modelID);
    },
    onSuccess: (_data, variables) => {
      const { sessionID } = variables;
      queryClient.invalidateQueries({ queryKey: ["opencode", "messages", opcodeUrl, sessionID, directory] });
      queryClient.invalidateQueries({ queryKey: ["opencode", "session", opcodeUrl, sessionID, directory] });
    },
    onError: (error) => {
      showToast.error(formatServerError(error), { duration: 8000 });
    },
  });
};

export const useTruncateSession = (opcodeUrl: string | null | undefined, directory?: string) => {
  const queryClient = useQueryClient();
  const client = useOpenCodeClient(opcodeUrl, directory);

  return useMutation({
    mutationFn: async ({ sessionID, messageID }: { sessionID: string; messageID: string }) => {
      if (!client) throw new Error("No client available");
      if (messageID.startsWith("optimistic_")) {
        return { success: true, messagesRemoved: 0, partsRemoved: 0, eventsRemoved: 0, todoRemoved: 0, remainingMessages: 0 }
      }
      return client.truncateSession(sessionID, messageID);
    },
    onMutate: async ({ sessionID, messageID }) => {
      const messagesKey = ["opencode", "messages", opcodeUrl, sessionID, directory] as const;
      await queryClient.cancelQueries({ queryKey: messagesKey });
      const previous = queryClient.getQueryData<MessageListResponse>(messagesKey);
      const cursor = previous?.find((m) => m.info.id === messageID);
      if (previous && cursor) {
        const cursorTime = cursor.info.time?.created ?? 0;
        const removedIds = new Set(
          previous
            .filter((m) => (m.info.time?.created ?? 0) >= cursorTime)
            .map((m) => m.info.id),
        );
        recentlyTruncated.set(sessionID, {
          until: Date.now() + RECENTLY_TRUNCATED_MS,
          removedIds,
        });
        queryClient.setQueryData<MessageListResponse>(messagesKey, () =>
          previous.filter((m) => (m.info.time?.created ?? 0) < cursorTime),
        );
      }
      return { messagesKey, previous };
    },
    onError: (error, variables, context) => {
      if (isRecentlyAborted(variables.sessionID)) {
        return
      }
      const msg = (error as { message?: string })?.message ?? ""
      if (msg.includes("optimistic_")) return
      if (context?.previous) {
        queryClient.setQueryData(context.messagesKey, context.previous);
      }
    },
    onSettled: (_data, _error, variables) => {
      const { sessionID } = variables;
      queryClient.invalidateQueries({ queryKey: ["opencode", "session", opcodeUrl, sessionID, directory] });
      queryClient.invalidateQueries({ queryKey: ["opencode", "messages", opcodeUrl, sessionID, directory] });
    },
  });
};

export const useDeleteMessage = (opcodeUrl: string | null | undefined, directory?: string) => {
  const queryClient = useQueryClient();
  const client = useOpenCodeClient(opcodeUrl, directory);

  return useMutation({
    mutationFn: async ({ sessionID, messageID }: { sessionID: string; messageID: string }) => {
      if (!client) throw new Error("No client available");
      return client.deleteMessage(sessionID, messageID);
    },
    onSettled: (_data, _error, variables) => {
      const { sessionID } = variables;
      queryClient.invalidateQueries({ queryKey: ["opencode", "session", opcodeUrl, sessionID, directory] });
      queryClient.invalidateQueries({ queryKey: ["opencode", "messages", opcodeUrl, sessionID, directory] });
    },
  });
};

export const useUpdateSession = (opcodeUrl: string | null | undefined, directory?: string) => {
  const queryClient = useQueryClient();
  const client = useOpenCodeClient(opcodeUrl, directory);

  return useMutation({
    mutationFn: async ({ sessionID, title }: { sessionID: string; title: string }) => {
      if (!client) throw new Error("No client available");
      return client.updateSession(sessionID, { title });
    },
    onSuccess: (_, variables) => {
      const { sessionID } = variables;
      queryClient.invalidateQueries({ queryKey: ["opencode", "session", opcodeUrl, sessionID, directory] });
      queryClient.invalidateQueries({ queryKey: ["opencode", "sessions", opcodeUrl, directory] });
    },
  });
};

const createOptimisticUserMessage = (
  sessionID: string,
  parts: ContentPart[],
  optimisticID: string,
): MessageWithParts => {
  const messageParts = parts.flatMap((part, index): MessageWithParts["parts"] => {
    if (part.type === "text") {
      return [{
        id: `${optimisticID}_part_${index}`,
        type: "text" as const,
        text: part.content,
        messageID: optimisticID,
        sessionID,
      }];
    }
    if (!canSendAsFilePart(mimeForFilename(part.name))) {
      return [{
        id: `${optimisticID}_part_${index}`,
        type: "text" as const,
        text: mentionFor(part),
        messageID: optimisticID,
        sessionID,
      }];
    }
    const fileUrl = part.path.startsWith("file:") ? part.path : `file:///${part.path.replace(/\\/g, "/").replace(/ /g, "%20")}`
    return [{
      id: `${optimisticID}_part_${index}`,
      type: "file" as const,
      mime: mimeForFilename(part.name),
      filename: part.name,
      url: fileUrl,
      messageID: optimisticID,
      sessionID,
    }];
  });

  return {
    info: {
      id: optimisticID,
      role: "user",
      sessionID,
      time: { created: Date.now() },
    },
    parts: messageParts,
  } as MessageWithParts;
};

const mentionFor = (part: ContentPart & { name: string; path: string }): string => {
  const path = part.path.replace(/^file:\/{2,3}/, "").replace(/\\/g, "/")
  const chatIdx = path.indexOf("/chat_uploads/")
  if (chatIdx >= 0) {
    // workspace 기준 상대경로를 유지한다. 레포 prefix를 떼면 존재 확인이 안 돼 칩이 안 뜬다.
    const reposIdx = path.indexOf("/repos/")
    const rel = reposIdx >= 0 ? path.slice(reposIdx + "/repos/".length) : path.slice(chatIdx + 1)
    return `@"${rel}"`
  }
  const reposIdx = path.indexOf("/repos/")
  const rel = reposIdx >= 0 ? path.slice(reposIdx + "/repos/".length) : part.name
  return `@"${rel}"`
};

export const useSendPrompt = (opcodeUrl: string | null | undefined, directory?: string) => {
  const client = useOpenCodeClient(opcodeUrl, directory);
  const queryClient = useQueryClient();
  // Use default model for optimistic assistant placeholder so LLM area shows correct model immediately
  let defaultModel: string | undefined
  try {
    const settingsData = queryClient.getQueryData<{ preferences?: { defaultModel?: string } }>(["settings"])
    defaultModel = settingsData?.preferences?.defaultModel
    if (!defaultModel) {
      try { defaultModel = localStorage.getItem('opencode-default-model') ?? undefined } catch {}
    }
  } catch {}

  return useMutation({
    mutationFn: async ({
      sessionID,
      prompt,
      parts,
      model,
      agent,
    }: {
      sessionID: string;
      prompt?: string;
      parts?: ContentPart[];
      model?: string;
      agent?: string;
    }) => {
      if (!client) throw new Error("No client available");

      const optimisticUserID = `optimistic_user_${Date.now()}_${Math.random()}`;

      const contentParts = parts || [{ type: "text" as const, content: prompt || "", name: "" }];

      const userMessage = createOptimisticUserMessage(
        sessionID,
        contentParts,
        optimisticUserID,
      );
      await queryClient.cancelQueries({ queryKey: ["opencode", "messages", opcodeUrl, sessionID, directory] });
      pendingOptimistic.set(sessionID, userMessage);
      // sending 중에는 내용 없이 빈 sending 마크만 같은 위치에 둔다.
      // 실 메시지는 서버 반영 후 교체된다.
      const sendingPlaceholderID = `optimistic_sending_${optimisticUserID}`
      const sendingPlaceholder: MessageWithParts = {
        info: {
          id: sendingPlaceholderID,
          role: "user" as const,
          sessionID,
          time: { created: Date.now() },
        } as unknown as MessageWithParts["info"],
        parts: [],
      } as MessageWithParts
      queryClient.setQueryData<MessageListResponse>(
        ["opencode", "messages", opcodeUrl, sessionID, directory],
        (old) => [...(old || []), sendingPlaceholder],
      );

      const requestData: SendPromptRequest = {
        parts: parts?.flatMap((part): PromptPart[] => {
          if (part.type === "text") {
            return [{ type: "text", text: part.content }]
          }
          const mime = mimeForFilename(part.name)
          if (!canSendAsFilePart(mime)) {
            return [{ type: "text", text: mentionFor(part) }]
          }
          return [{
            type: "file",
            mime,
            filename: part.name,
            url: part.path.startsWith("file:")
              ? part.path
              : `file:///${part.path.replace(/\\/g, "/").replace(/ /g, "%20")}`,
          }]
        }) || [{ type: "text", text: prompt || "" }],
      };

      if (model) {
        const firstSlash = model.indexOf("/");
        if (firstSlash > 0) {
          const providerID = model.slice(0, firstSlash);
          const modelID = model.slice(firstSlash + 1);
          if (providerID && modelID) {
            requestData.model = {
              providerID,
              modelID,
            };
          }
        }
      }

      if (agent) {
        requestData.agent = agent;
      }

      const esUrl = client.getEventSourceURL();
      let es: EventSource | null = null;
      const sseMergePart = (part: MessageWithParts["parts"][number], delta?: string) => {
        const key = ["opencode", "messages", opcodeUrl, sessionID, directory] as const;
        queryClient.setQueryData<MessageListResponse>(key, (old) => {
          if (!old) return old;
          const mid = (part as { messageID: string }).messageID;
          const idx = old.findIndex((m) => m.info.id === mid);
          if (idx === -1) {
            // reasoning ?�벤?�는 별도 ?�로?�?300ms)�???빨리 ?�긴?????�작 체감 개선
            const pt = (part as { type?: string }).type
            fastPullMessages(queryClient, opcodeUrl, sessionID, directory, pt === 'reasoning')
            return old
          }
          const msg = old[idx]!;
          let pIdx = msg.parts.findIndex((p) => (p as { id: string }).id === (part as { id: string }).id);
          // Fallback for tool: id may change across updates, match by tool + running status
          if (pIdx === -1 && (part as { type: string }).type === "tool") {
            const toolName = (part as { tool: string }).tool;
            pIdx = msg.parts.findIndex((p) => (p as { type: string; tool?: string }).type === "tool" && (p as { tool: string }).tool === toolName && (p as { state?: { status?: string } }).state?.status === "running");
          }
          let nextParts: MessageWithParts["parts"];
          if (pIdx === -1) nextParts = [...msg.parts, part];
          else {
            const existing = msg.parts[pIdx] as { type: string; text?: string; state?: { output?: string; metadata?: { output?: string }; status?: string } };
            let nextPart: typeof part = part;
            if (delta) {
              if (existing.type === "reasoning" && typeof existing.text === "string") {
                const pText = (part as { text?: string }).text ?? "";
                if (pText === existing.text + delta) nextPart = part;
                else nextPart = { ...existing, text: existing.text + delta } as unknown as typeof part;
              } else if (existing.type === "text" && typeof existing.text === "string") {
                const pText = (part as { text?: string }).text ?? "";
                if (pText === existing.text + delta) nextPart = part;
                else nextPart = { ...part, text: existing.text + delta } as typeof part;
              } else if (existing.type === "tool") {
                const st = (existing as unknown as { state: Record<string, unknown> }).state ?? {} as Record<string, unknown>;
                const isRunning = (st as { status?: string }).status === 'running';
                if (isRunning) {
                  const meta = ((st as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>;
                  const curMeta = typeof (meta as { output?: unknown }).output === 'string' ? (meta as { output: string }).output : '';
                  const partMetaOut = (part as unknown as { state?: { metadata?: { output?: string } } }).state?.metadata?.output ?? "";
                  if (partMetaOut === curMeta + delta) nextPart = part;
                  else nextPart = { ...existing, state: { ...st, metadata: { ...meta, output: curMeta + delta } } } as unknown as typeof part;
                } else {
                  const cur = typeof (st as { output?: unknown }).output === 'string' ? (st as { output: string }).output : '';
                  const partOut = (part as unknown as { state?: { output?: string } }).state?.output ?? "";
                  if (partOut === cur + delta) nextPart = part;
                  else nextPart = { ...existing, state: { ...st, output: cur + delta } } as unknown as typeof part;
                }
              }
            }
            nextParts = [...msg.parts]; nextParts[pIdx] = nextPart;
          }
          const next = [...old]; next[idx] = { ...msg, parts: nextParts }; return next;
        });
      };
      const sseMergeMessage = (info: MessageWithParts["info"]) => {
        const key = ["opencode", "messages", opcodeUrl, sessionID, directory] as const;
        queryClient.setQueryData<MessageListResponse>(key, (old) => {
          if (!old) return old;
          const idx = old.findIndex((m) => m.info.id === info.id);
          if (idx === -1) { fastPullMessages(queryClient, opcodeUrl, sessionID, directory, true); return old; }
          const next = [...old]; next[idx] = { ...next[idx]!, info }; return next;
        });
      };
      const sseHandle = (e: MessageEvent) => {
        try {
          const raw = (e as MessageEvent).data as string;
          let parsed: Record<string, unknown>; try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
          let t: string, p: Record<string, unknown>;
          if (typeof parsed.type === "string" && parsed.properties && typeof parsed.properties === "object") { t = parsed.type as string; p = parsed.properties as Record<string, unknown>; }
          else { t = (e as unknown as { type: string }).type || ""; p = parsed as Record<string, unknown>; if (t === "message" && typeof parsed.type === "string") { t = parsed.type as string; p = (parsed.properties as Record<string, unknown>) ?? parsed; } }
          if (t === "message.part.updated") {
            const part = (p.part ?? p) as MessageWithParts["parts"][number] & { sessionID: string; messageID?: string };
            const delta = (p.delta as string | undefined) ?? (p.text as string | undefined);
            const sid = (part as { sessionID: string }).sessionID ?? (p.sessionID as string) ?? (p.sessionId as string);
            if (sid !== sessionID) return;
            const mid = (part as { messageID: string }).messageID ?? (p.messageID as string);
            const partForMerge = mid && !(part as { messageID: string }).messageID ? { ...part, messageID: mid } as MessageWithParts["parts"][number] : part as MessageWithParts["parts"][number];
            sseMergePart(partForMerge, delta);
           } else if (t === "message.part.delta") {
            const sid = (p.sessionID as string) ?? (p.sessionId as string);
            if (sid !== sessionID) return;
            const mid = p.messageID as string; const pid = (p.partID as string) ?? (p.id as string); const delta = p.delta as string;
            if (!mid || !pid || !delta) return;
            const key = ["opencode", "messages", opcodeUrl, sessionID, directory] as const;
            queryClient.setQueryData<MessageListResponse>(key, (old) => {
              if (!old) return old; const idx = old.findIndex((m) => m.info.id === mid); if (idx === -1) { fastPullMessages(queryClient, opcodeUrl, sessionID, directory); return old; }
              const msg = old[idx]!; let pIdx = msg.parts.findIndex((pp) => (pp as { id: string }).id === pid);
              if (pIdx === -1) {
                pIdx = msg.parts.findIndex((pp) => (pp as { type: string; state?: { status?: string } }).type === "tool" && (pp as { state?: { status?: string } }).state?.status === "running");
                if (pIdx === -1) return old;
              }
              const existing = msg.parts[pIdx] as { type: string; text?: string; state?: { output?: string; metadata?: { output?: string }; status?: string } };
              let nextPart: MessageWithParts["parts"][number];
              if (existing.type === "reasoning") {
                nextPart = { ...existing, text: (existing.text ?? "") + delta } as MessageWithParts["parts"][number];
              } else if (existing.type === "text") {
                nextPart = { ...existing, text: (existing.text ?? "") + delta } as MessageWithParts["parts"][number];
              } else if (existing.type === "tool") {
                const st = (existing as unknown as { state: Record<string, unknown> }).state ?? {} as Record<string, unknown>;
                const isRunning = (st as { status?: string }).status === 'running';
                if (isRunning) {
                  const meta = ((st as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>;
                  const curMeta = typeof (meta as { output?: unknown }).output === 'string' ? (meta as { output: string }).output : '';
                  nextPart = { ...existing, state: { ...st, metadata: { ...meta, output: curMeta + delta } } } as unknown as MessageWithParts["parts"][number];
                } else {
                  const cur = typeof (st as { output?: unknown }).output === 'string' ? (st as { output: string }).output : '';
                  nextPart = { ...existing, state: { ...st, output: cur + delta } } as unknown as MessageWithParts["parts"][number];
                }
              } else return old;
              const nextParts = [...msg.parts]; nextParts[pIdx] = nextPart;
              const next = [...old]; next[idx] = { ...msg, parts: nextParts }; return next;
            });
            return;
          } else if (t === "message.updated") {
            const info = (p.info ?? p) as MessageWithParts["info"] & { sessionID: string };
            const sid = (info as { sessionID: string }).sessionID ?? (p.sessionID as string);
            if (sid !== sessionID) return; sseMergeMessage(info as MessageWithParts["info"]);
          } else if (t === "session.idle") {
            const sid = (p.sessionID as string) ?? (p.sessionId as string);
            if (sid && sid !== sessionID) return;
            queryClient.invalidateQueries({ queryKey: ["opencode", "messages", opcodeUrl, sessionID, directory] });
            queryClient.invalidateQueries({ queryKey: ["session-status-db"] });
            queryClient.invalidateQueries({ queryKey: ["sessions", opcodeUrl, directory] });
            // 즉시 Working 마크 ?�제 ??2s ?�링 ?��??�이 캐시?�서 직접 ?�거
            queryClient.setQueryData(["session-status-db"], (old: unknown) => {
              if (!Array.isArray(old)) return old;
              return (old as Array<{ sessionId: string; status: string }>).filter((s) => s.sessionId !== sid);
            });
          }
        } catch {}
      };
      try {
        es = new EventSource(esUrl);
        activeSSEMap.set(sessionID, es);
        es.onmessage = sseHandle;
        ["message.part.updated","message.updated","message.removed","session.idle"].forEach((tt) => { try { es!.addEventListener(tt, sseHandle as EventListener); } catch {} });
      } catch {}

      const ac = new AbortController()
      activeSendControllers.set(sessionID, ac)
      let response: unknown
      try {
        response = await client.sendPrompt(sessionID, requestData, { signal: ac.signal });
      } finally {
        if (activeSendControllers.get(sessionID) === ac) activeSendControllers.delete(sessionID)
        if (es) { try { es.close(); } catch {} activeSSEMap.delete(sessionID); }
      }

      return { optimisticUserID, response };
    },
    onSettled: (_data, _error, variables) => {
      if (activeSendControllers.get(variables.sessionID)) activeSendControllers.delete(variables.sessionID)
      queryClient.invalidateQueries({ queryKey: ["opencode", "messages", opcodeUrl, variables.sessionID, directory] })
      // sending?�??�버???�상 반영?�어 ?�면??뿌려�??�까지 ?��? ??useMessages??realUserArrived?�서 교체
      // ?�패/?�?�아???�비??30�??�에�?강제 ?�리 (?�무 ?�찍 지?��? ?�음)
      setTimeout(() => {
        if (!pendingOptimistic.has(variables.sessionID)) return
        const cur = queryClient.getQueryData<MessageListResponse>(["opencode", "messages", opcodeUrl, variables.sessionID, directory])
        const pending = pendingOptimistic.get(variables.sessionID)
        if (!pending) return
        const real = cur?.find((m) => {
          if (m.info.role !== "user" || m.info.id.startsWith("optimistic_sending_") || m.info.id.startsWith("optimistic_")) return false
          if (Math.abs((m.info.time?.created ?? 0) - (pending.info.time?.created ?? 0)) > 60000) return false
          return true
        })
        if (!real) {
          queryClient.setQueryData<MessageListResponse>(["opencode", "messages", opcodeUrl, variables.sessionID, directory], (old) => old?.filter((m) => !m.info.id.startsWith("optimistic_sending_")) ?? old)
          pendingOptimistic.delete(variables.sessionID)
        }
      }, 30000)
    },
    onError: (error, variables) => {
      const { sessionID } = variables;
      const formatted = formatServerError(error)
      queryClient.setQueryData<MessageListResponse>(
        ["opencode", "messages", opcodeUrl, sessionID, directory],
        (old) => old?.filter((msg) => !msg.info.id.startsWith("optimistic_")),
      );
      pendingOptimistic.delete(sessionID)
      if (!isAbortCancellation(error) && !isProxyTimeoutError(error)) {
        showToast.error(formatted, { duration: 8000 });
      }
    },
    onSuccess: (_data, variables) => {
      const { sessionID } = variables;
      // keep optimistic until real arrives to avoid flicker (dedup in useMessages)
      queryClient.invalidateQueries({
        queryKey: ["opencode", "session", opcodeUrl, sessionID, directory],
      });
    },
  });
};

export const useSessionStatusMap = () => {
  return useQuery({
    queryKey: ["session-status-db"],
    queryFn: listSessionStatuses,
    refetchInterval: 2000,
    staleTime: 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
};

export const useAbortSession = (opcodeUrl: string | null | undefined, directory?: string) => {
  const client = useOpenCodeClient(opcodeUrl, directory);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionID: string) => {
      if (!client) throw new Error("No client available");
      await client.abortSession(sessionID);
    },
    onMutate: async (sessionID) => {
      // ??�� ?�나??abort POST??onSettled가 cancel 직후 ?�로 보낸 ?�을
      // 죽이지 ?�도�? 지�?진행 중인 ?�스?�스�??�아?�다 (context�??�달).
      const acAtAbort = activeSendControllers.get(sessionID)
      const esAtAbort = activeSSEMap.get(sessionID)
      const pendingAtAbort = pendingOptimistic.get(sessionID)
      abortActiveSend(sessionID)
      recentlyAborted.set(sessionID, Date.now());
      await queryClient.cancelQueries({ queryKey: ["opencode", "messages", opcodeUrl, sessionID, directory] })
      await queryClient.cancelQueries({ queryKey: ["opencode", "last-message", opcodeUrl, sessionID, directory] })
      markSessionMessagesCompleted(queryClient, opcodeUrl, directory, sessionID);
      queryClient.setQueryData<MessageListResponse>(["opencode", "messages", opcodeUrl, sessionID, directory], (old) => {
        if (!old) return old
        return old.filter((m) => !m.info.id.startsWith("optimistic_") && !m.info.id.startsWith("optimistic_sending_"))
      })
      pendingOptimistic.delete(sessionID)
      const statuses = queryClient.getQueryData<{ sessionId: string; status: string; pendingPermissions: number }[]>(['session-status-db'])
      if (statuses) {
        queryClient.setQueryData(['session-status-db'], statuses.map((entry) => entry.sessionId === sessionID ? { ...entry, status: 'idle' as const, pendingPermissions: 0 } : entry))
      } else {
        queryClient.setQueryData(['session-status-db'], [{ sessionId: sessionID, status: 'idle', pendingPermissions: 0 } as never])
      }
      queryClient.setQueryData(['session-status-db'], (old: unknown) => old)
      return { acAtAbort, esAtAbort, pendingAtAbort }
    },
    onError: () => {
    },
    onSettled: (_data, _error, sessionID, context) => {
      const ctx = context as { acAtAbort?: AbortController; esAtAbort?: EventSource; pendingAtAbort?: MessageWithParts } | undefined
      // cancel ?�후 ?�로 ?�작???�송?�?건드리�? ?�는?????�아??것만 ?�리
      abortSpecificSend(sessionID, { ac: ctx?.acAtAbort, es: ctx?.esAtAbort })
      if (ctx?.pendingAtAbort && pendingOptimistic.get(sessionID) === ctx.pendingAtAbort) {
        pendingOptimistic.delete(sessionID)
      }
      // ???�이 ?��? ?�고 ?�으�?메시지 ?�태???????�유 ???�료 마킹 ?�략
      if (!activeSendControllers.has(sessionID)) {
        markSessionMessagesCompleted(queryClient, opcodeUrl, directory, sessionID);
      }
      queryClient.invalidateQueries({ queryKey: ['opencode', 'messages', opcodeUrl, sessionID, directory] })
      queryClient.invalidateQueries({ queryKey: ['opencode', 'last-message', opcodeUrl, sessionID, directory] })
      queryClient.invalidateQueries({ queryKey: ['opencode', 'sessions', opcodeUrl, directory] })
      queryClient.invalidateQueries({ queryKey: ['session-status-db'] })
    },
  });
};

function markSessionMessagesCompleted(
  queryClient: ReturnType<typeof useQueryClient>,
  opcodeUrl: string | null | undefined,
  directory: string | undefined,
  sessionID: string,
) {
  const messagesKey = ['opencode', 'messages', opcodeUrl, sessionID, directory] as const
  const data = queryClient.getQueryData<MessageListResponse>(messagesKey)
  if (!data) return
  let changed = false
  const updated: MessageListResponse = []
  for (const msg of data) {
    if (msg.info.role !== 'assistant') {
      updated.push(msg)
      continue
    }
    if ('completed' in msg.info.time && msg.info.time.completed) {
      updated.push(msg)
      continue
    }
    changed = true
    // �?placeholder(?�트 ?�는 미완�?카드)???�료 처리 ?�???�거?�다.
    if (msg.parts.length === 0) continue
    const patchedParts = msg.parts.map((part) => {
      if ((part as { type?: string }).type === 'tool' && (part as { state?: { status?: string } }).state?.status === 'running') {
        // input/command/output ?��? ???�태�?error�?(?�째�?갈아?�으�?명령???�라진다)
        const st = (part as { state?: Record<string, unknown> }).state ?? {}
        return { ...part, state: { ...st, status: 'error' as const, error: 'Run was interrupted' } } as typeof part
      }
      return part
    })
    updated.push({ ...msg, info: { ...msg.info, time: { ...msg.info.time, completed: Date.now() } }, parts: patchedParts })
  }
  if (changed) {
    queryClient.setQueryData(messagesKey, updated)
  }
}

export const useSendShell = (opcodeUrl: string | null | undefined, directory?: string) => {
  const client = useOpenCodeClient(opcodeUrl, directory);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sessionID,
      command,
      agent,
    }: {
      sessionID: string;
      command: string;
      agent?: string;
    }) => {
      if (!client) throw new Error("No client available");

      const optimisticUserID = `optimistic_user_${Date.now()}_${Math.random()}`;

      const userMessage = createOptimisticUserMessage(
        sessionID,
        [{ type: "text" as const, content: command }],
        optimisticUserID,
      );
      await queryClient.cancelQueries({ queryKey: ["opencode", "messages", opcodeUrl, sessionID, directory] });
      pendingOptimistic.set(sessionID, userMessage);
      queryClient.setQueryData<MessageListResponse>(
        ["opencode", "messages", opcodeUrl, sessionID, directory],
        (old) => [...(old || []), userMessage],
      );

      const response = await client.sendShell(sessionID, {
        command,
        agent: agent || "general",
      });

      return { optimisticUserID, response };
    },
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: ["opencode", "messages", opcodeUrl, variables.sessionID, directory] })
      setTimeout(() => {
        if (pendingOptimistic.has(variables.sessionID)) {
          const cur = queryClient.getQueryData<MessageListResponse>(["opencode", "messages", opcodeUrl, variables.sessionID, directory])
          const pending = pendingOptimistic.get(variables.sessionID)
          const pendingText = (pending?.parts.find((p) => (p as { type: string }).type === 'text') as { text?: string } | undefined)?.text?.trim() ?? ''
          const real = cur?.find((m) => {
            if (m.info.role !== "user" || m.info.id.startsWith("optimistic_")) return false
            if ((m.info.time?.created ?? 0) < (pending?.info.time?.created ?? 0) - 5000) return false
            const text = (m.parts.find((p) => (p as { type: string }).type === 'text') as { text?: string } | undefined)?.text?.trim() ?? ''
            if (!text) return false
            if (pendingText && text !== pendingText) return false
            return true
          })
          if (real) {
            queryClient.setQueryData<MessageListResponse>(["opencode", "messages", opcodeUrl, variables.sessionID, directory], (old) => {
              if (!old) return old
              return old.map((msg) => msg.info.id === pending!.info.id ? { ...msg, info: { ...msg.info, id: real.info.id } } : msg)
            })
            pendingOptimistic.delete(variables.sessionID)
          }
        }
      }, 4000)
    },
    onError: (error, variables) => {
      const { sessionID } = variables;
      const formatted = formatServerError(error)
      queryClient.setQueryData<MessageListResponse>(
        ["opencode", "messages", opcodeUrl, sessionID, directory],
        (old) => old?.filter((msg) => !msg.info.id.startsWith("optimistic_") && !msg.info.id.startsWith("optimistic_sending_")),
      );
      pendingOptimistic.delete(sessionID)
      if (!isAbortCancellation(error) && !isProxyTimeoutError(error)) {
        showToast.error(formatted, { duration: 8000 });
      }
    },
    onSuccess: (_data, variables) => {
      const { sessionID } = variables;
      queryClient.invalidateQueries({
        queryKey: ["opencode", "session", opcodeUrl, sessionID, directory],
      });
    },
  });
};

export const useConfig = (opcodeUrl: string | null | undefined, directory?: string) => {
  const client = useOpenCodeClient(opcodeUrl, directory);

  return useQuery({
    queryKey: ["opencode", "config", opcodeUrl, directory],
    queryFn: () => client!.getConfig(),
    enabled: !!client,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 60_000,
  });
};

export function hasActiveSend(sessionID: string): boolean {
  return activeSendControllers.has(sessionID) || pendingOptimistic.has(sessionID)
}

export const useEphemeralSessionSSE = (
  opcodeUrl: string | null | undefined,
  sessionID: string | undefined,
  directory?: string,
  enabled?: boolean,
) => {
  const client = useOpenCodeClient(opcodeUrl, directory);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled || !client || !sessionID) return;
    // Per-send SSE (useSendPrompt) already covers streaming during POST ??avoid double connection
    if (activeSSEMap.has(sessionID)) return;
    const url = client.getEventSourceURL();
    let closed = false;
    let es: EventSource | null = null;
    try {
      es = new EventSource(url);
    } catch {
      return;
    }
    const mergePart = (part: MessageWithParts["parts"][number], delta?: string) => {
      const key = ["opencode", "messages", opcodeUrl, sessionID, directory] as const;
      queryClient.setQueryData<MessageListResponse>(key, (old) => {
        if (!old) return old;
        const mid = (part as { messageID: string }).messageID;
        const idx = old.findIndex((m) => m.info.id === mid);
        // 캐시???�는 message id???�트??추정 role �???카드�?만들지 ?�고,
        // 목록 refetch�??�당�??�버???�제 메시지�?빨리 가?�온??
        if (idx === -1) { fastPullMessages(queryClient, opcodeUrl, sessionID, directory); return old; }
        const msg = old[idx]!;
        let pIdx = msg.parts.findIndex((p) => (p as { id: string }).id === (part as { id: string }).id);
        if (pIdx === -1 && (part as { type: string }).type === "tool") {
          const toolName = (part as { tool: string }).tool;
          pIdx = msg.parts.findIndex((p) => (p as { type: string; tool?: string }).type === "tool" && (p as { tool: string }).tool === toolName && (p as { state?: { status?: string } }).state?.status === "running");
        }
        let nextParts: MessageWithParts["parts"];
        if (pIdx === -1) {
          nextParts = [...msg.parts, part];
        } else {
          const existing = msg.parts[pIdx] as { type: string; text?: string; state?: { output?: string; metadata?: { output?: string }; status?: string } };
          let nextPart: typeof part = part;
          if (delta) {
            if (existing.type === "text" && typeof existing.text === "string") {
              nextPart = { ...part, text: existing.text + delta } as typeof part;
            } else if (existing.type === "tool") {
              const st = (existing as unknown as { state: Record<string, unknown> }).state ?? {} as Record<string, unknown>;
              const isRunning = (st as { status?: string }).status === 'running';
              if (isRunning) {
                const meta = ((st as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>;
                const curMeta = typeof (meta as { output?: unknown }).output === 'string' ? (meta as { output: string }).output : '';
                const partMetaOut = (part as unknown as { state?: { metadata?: { output?: string } } }).state?.metadata?.output ?? "";
                if (partMetaOut === curMeta + delta) nextPart = part;
                else nextPart = { ...existing, state: { ...st, metadata: { ...meta, output: curMeta + delta } } } as unknown as typeof part;
              } else {
                const cur = typeof (st as { output?: unknown }).output === 'string' ? (st as { output: string }).output : '';
                const partOut = (part as unknown as { state?: { output?: string } }).state?.output ?? "";
                if (partOut === cur + delta) nextPart = part;
                else nextPart = { ...existing, state: { ...st, output: cur + delta } } as unknown as typeof part;
              }
            }
          }
          nextParts = [...msg.parts];
          nextParts[pIdx] = nextPart;
        }
        const nextMsg: MessageWithParts = { ...msg, parts: nextParts };
        const next = [...old];
        next[idx] = nextMsg;
        return next;
      });
    };
    const mergeMessage = (info: MessageWithParts["info"]) => {
      const key = ["opencode", "messages", opcodeUrl, sessionID, directory] as const;
      queryClient.setQueryData<MessageListResponse>(key, (old) => {
        if (!old) return old;
        const idx = old.findIndex((m) => m.info.id === info.id);
        if (idx === -1) { fastPullMessages(queryClient, opcodeUrl, sessionID, directory); return old; }
        const next = [...old];
        next[idx] = { ...next[idx]!, info };
        return next;
      });
    };
    const handleRaw = (e: MessageEvent) => {
      try {
        const raw = (e as MessageEvent).data as string;
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
        let t: string;
        let p: Record<string, unknown>;
        if (typeof parsed.type === "string" && parsed.properties && typeof parsed.properties === "object") {
          t = parsed.type as string;
          p = parsed.properties as Record<string, unknown>;
        } else {
          t = (e as unknown as { type: string }).type || "";
          p = parsed as Record<string, unknown>;
          if (t === "message" && typeof parsed.type === "string") {
            t = parsed.type as string;
            p = (parsed.properties as Record<string, unknown>) ?? parsed;
          }
        }
        if (t === "message.part.updated") {
          const part = (p.part ?? p) as MessageWithParts["parts"][number] & { sessionID: string; messageID: string; id?: string };
          const delta = (p.delta as string | undefined) ?? (p.text as string | undefined);
          const sid = (part as { sessionID: string }).sessionID ?? (p.sessionID as string) ?? (p.sessionId as string);
          if (sid !== sessionID) return;
          const mid = (part as { messageID: string }).messageID ?? (p.messageID as string);
          const pid = (part as { id: string }).id ?? (p.partID as string) ?? (p.id as string);
          const partForMerge = mid && !(part as { messageID: string }).messageID ? { ...part, messageID: mid, id: pid ?? (part as { id: string }).id } as MessageWithParts["parts"][number] : part as MessageWithParts["parts"][number];
          if (delta && partForMerge && typeof (partForMerge as { type: string; text?: string }).text === "string") {
            const existingKey = ["opencode", "messages", opcodeUrl, sessionID, directory] as const;
            const old = queryClient.getQueryData<MessageListResponse>(existingKey);
            const idx = old?.findIndex((m) => m.info.id === (partForMerge as { messageID: string }).messageID) ?? -1;
            if (idx !== -1) {
              const existingPart = old![idx]!.parts.find((pp) => (pp as { id: string }).id === (partForMerge as { id: string }).id) as { text?: string } | undefined;
              if (existingPart && typeof existingPart.text === "string" && typeof (partForMerge as { text?: string }).text === "string" && (partForMerge as { text: string }).text === existingPart.text + delta) {
                mergePart(partForMerge, undefined);
                return;
              }
            }
          }
          mergePart(partForMerge as MessageWithParts["parts"][number], delta);
        } else if (t === "message.part.delta") {
          const sid = (p.sessionID as string) ?? (p.sessionId as string);
          if (sid !== sessionID) return;
          const mid = p.messageID as string; const pid = (p.partID as string) ?? (p.id as string); const delta = p.delta as string;
          if (!mid || !pid || !delta) return;
          const key = ["opencode", "messages", opcodeUrl, sessionID, directory] as const;
          queryClient.setQueryData<MessageListResponse>(key, (old) => {
            if (!old) return old;
            const idx = old.findIndex((m) => m.info.id === mid);
            if (idx === -1) { fastPullMessages(queryClient, opcodeUrl, sessionID, directory); return old; }
            const msg = old[idx]!; let pIdx = msg.parts.findIndex((pp) => (pp as { id: string }).id === pid);
            if (pIdx === -1) {
              pIdx = msg.parts.findIndex((pp) => (pp as { type: string; state?: { status?: string } }).type === "tool" && (pp as { state?: { status?: string } }).state?.status === "running");
              if (pIdx === -1) return old;
            }
            const existing = msg.parts[pIdx] as { type: string; text?: string; state?: { output?: string; metadata?: { output?: string }; status?: string } };
            let nextPart: MessageWithParts["parts"][number];
            if (existing.type === "text") {
              nextPart = { ...existing, text: (existing.text ?? "") + delta } as MessageWithParts["parts"][number];
            } else if (existing.type === "tool") {
              const st = (existing as unknown as { state: Record<string, unknown> }).state ?? {} as Record<string, unknown>;
              const isRunning = (st as { status?: string }).status === 'running';
              if (isRunning) {
                const meta = ((st as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>;
                const curMeta = typeof (meta as { output?: unknown }).output === 'string' ? (meta as { output: string }).output : '';
                nextPart = { ...existing, state: { ...st, metadata: { ...meta, output: curMeta + delta } } } as unknown as MessageWithParts["parts"][number];
              } else {
                const cur = typeof (st as { output?: unknown }).output === 'string' ? (st as { output: string }).output : '';
                nextPart = { ...existing, state: { ...st, output: cur + delta } } as unknown as MessageWithParts["parts"][number];
              }
            } else return old;
            const nextParts = [...msg.parts]; nextParts[pIdx] = nextPart;
            const next = [...old]; next[idx] = { ...msg, parts: nextParts }; return next;
          });
          return;
        } else if (t === "message.updated") {
          const info = (p.info ?? p) as MessageWithParts["info"] & { sessionID: string };
          const sid = (info as { sessionID: string }).sessionID ?? (p.sessionID as string);
          if (sid !== sessionID) return;
          mergeMessage(info as MessageWithParts["info"]);
        } else if (t === "message.removed") {
          const sid = p.sessionID as string;
          const mid = p.messageID as string;
          if (sid !== sessionID) return;
          const key = ["opencode", "messages", opcodeUrl, sessionID, directory] as const;
          queryClient.setQueryData<MessageListResponse>(key, (old) => old?.filter((m) => m.info.id !== mid) ?? old);
        } else if (t === "session.idle" || t === "session.status") {
          const sid = (p.sessionID as string) ?? (p.sessionId as string);
          if (sid && sid !== sessionID) return;
          if (t === "session.idle") {
            queryClient.invalidateQueries({ queryKey: ["opencode", "messages", opcodeUrl, sessionID, directory] });
            queryClient.invalidateQueries({ queryKey: ["session-status-db"] });
          }
        }
      } catch {}
    };
    es.onmessage = handleRaw;
    const types = ["message.part.updated", "message.updated", "message.removed", "session.idle", "session.status"];
    types.forEach((t) => {
      try { es!.addEventListener(t, handleRaw as EventListener); } catch {}
    });
    es.onerror = () => {
      if (closed) return;
    };
    return () => {
      closed = true;
      try { es?.close(); } catch {}
    };
  }, [enabled, opcodeUrl, sessionID, directory, client, queryClient]);
};

