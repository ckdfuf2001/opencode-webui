import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { OpenCodeClient } from "../api/opencode";
import type {
  MessageWithParts,
  MessageListResponse,
  ContentPart,
  Session,
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

/** 캔슬 배찌: 마지막 결과가 캔슬이면 다음 채팅 시작 전까지 유지 */
const cancelledUntilNextSend = new Set<string>();
export function markCancelledUntilNextSend(sessionID: string): void {
  cancelledUntilNextSend.add(sessionID);
}
export function clearCancelledUntilNextSend(sessionID: string): void {
  cancelledUntilNextSend.delete(sessionID);
}
export function isCancelledUntilNextSend(sessionID: string): boolean {
  return cancelledUntilNextSend.has(sessionID);
}

/** ?�송 중인 ?��? user 메시지. 2s ?�링??캐시�???��?�도 ?��??�다. */
const pendingOptimistic = new Map<string, MessageWithParts>();

const activeSendControllers = new Map<string, AbortController>();
const activeSSEMap = new Map<string, EventSource>();

/**
 * SSE 설정 off 시 킬 스위치 — 진행 중 per-send 스트림까지 즉시 닫는다.
 * POST 자체는 계속되고 폴링이 갱신을 담당하므로 전송은 유실되지 않는다.
 */
export function closeAllSessionSSE(): void {
  for (const [, es] of activeSSEMap) {
    try { es.close(); } catch {}
  }
  activeSSEMap.clear()
}

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

function reasoningPartsLength(parts: MessageWithParts["parts"]): number {
  let n = 0
  for (const p of parts) {
    if ((p as { type?: string }).type !== "reasoning") continue
    n += ((p as { text?: string }).text ?? "").length
  }
  return n
}

function runningToolCount(parts: MessageWithParts["parts"]): number {
  let n = 0
  for (const p of parts) {
    if ((p as { type?: string }).type !== "tool") continue
    if ((p as { state?: { status?: string } }).state?.status === "running") n++
  }
  return n
}

function isCompleted(info: MessageWithParts["info"]): boolean {
  return Boolean((info.time as { completed?: number } | undefined)?.completed)
}

/**
 * 단일 메시지 지문 비교 — 종류별 분리 비교한다. 한 메시지 안에서 text 합산과
 * tool 합산을 뭉개면 상쇄 오판이 난다 (running 120k→완료 20k 캡 축소 vs 텍스트
 * 증가). running 툴 수도 센다 — 길이가 안 변는 running→completed 전이 대응.
 */
function sameMessageContent(a: MessageWithParts, b: MessageWithParts): boolean {
  if (a.parts.length !== b.parts.length) return false
  if (textPartsLength(a.parts) !== textPartsLength(b.parts)) return false
  if (toolOutputLength(a.parts) !== toolOutputLength(b.parts)) return false
  if (reasoningPartsLength(a.parts) !== reasoningPartsLength(b.parts)) return false
  if (runningToolCount(a.parts) !== runningToolCount(b.parts)) return false
  return isCompleted(a.info) === isCompleted(b.info)
}

/**
 * 메시지 목록 지문 비교 — join 없이 길이 합산만으로 판정한다.
 * 내용이 동일하면 캐시 참조를 그대로 반환해 매 폴링마다 새 배열이 생기는
 * 할당 압력을 막는다 (structuralSharing만으로는 하위 useMemo가 다 깨진다).
 */
function sameMessageList(a: MessageListResponse, b: MessageListResponse): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const ma = a[i]!
    const mb = b[i]!
    if (ma.info.id !== mb.info.id) return false
    if (!sameMessageContent(ma, mb)) return false
  }
  return true
}

/**
 * 캐시가 fetch 결과보다 앞선 상태인지 — SSE가 fetch보다 먼저 간 경우 fresh를
 * 덮어쓰면 화면이 순간 되감기므로 캐시를 유지한다.
 * 적용 범위는 마지막 미완료 메시지로 한정한다. SSE가 앞설 수 있는 구간은
 * 거기뿐이고, 과거 메시지는 캡 축소·reconcile 반영을 위해 항상 fresh 우선이다.
 * 끝난 턴의 축소(120k→20k)는 정상 축소라 캐시 유지 대상이 아니다.
 */
function isCachedAhead(cached: MessageListResponse, fresh: MessageListResponse): boolean {
  if (cached.length !== fresh.length || cached.length === 0) return false
  const last = cached.length - 1
  for (let i = 0; i < last; i++) {
    // 과거 메시지는 무조건 fresh 우선 (id만 맞는지 확인)
    if (cached[i]!.info.id !== fresh[i]!.info.id) return false
  }
  const mc = cached[last]!
  const mf = fresh[last]!
  if (mc.info.id !== mf.info.id) return false
  if (mc.parts.length !== mf.parts.length) return false
  if (isCompleted(mc.info) !== isCompleted(mf.info)) return false
  // 완료된 턴이면 축소는 정상 — fresh 채택
  if (isCompleted(mf.info)) return false
  const lc = textPartsLength(mc.parts) + toolOutputLength(mc.parts) + reasoningPartsLength(mc.parts)
  const lf = textPartsLength(mf.parts) + toolOutputLength(mf.parts) + reasoningPartsLength(mf.parts)
  return lc > lf
}

// bash 등 대용량 툴 출력은 메모리에 전부 들고 있으면 힙이 GB 단위로 부푼다.
// pnpm 같은 대량 출력이 툴 하나에 4GB까지 가던 걸 방지 — 완료된 툴은 20k까지만 메모리에 유지
export const MAX_TOOL_OUTPUT_KEEP = 20_000
export const TOOL_TRUNCATE_NOTICE = '\n\n…[output truncated for memory — see full log in session]'
/**
 * SSE 스트리밍 병합용 cap. 전송 경로(useSendPrompt)와 동일한 기준:
 * 실행 중은 꼬리 120k(실시간 tail 확인용), 끝난 건 앞 20k.
 * ephemeral SSE(SessionDetail 실시간 병합)도 같은 cap을 써야
 * git pull·인덱싱 같은 장시간 턴에서 힙이 GB로 부푸는 걸 막는다.
 */
export function capRunningStreamOutput(s: string): string {
  if (s.length <= MAX_TOOL_OUTPUT_KEEP * 6) return s
  return `…[stream truncated, showing last ${MAX_TOOL_OUTPUT_KEEP} chars]\n` + s.slice(-MAX_TOOL_OUTPUT_KEEP)
}
export function capFinishedStreamOutput(s: string): string {
  if (s.length <= MAX_TOOL_OUTPUT_KEEP) return s
  return s.slice(0, MAX_TOOL_OUTPUT_KEEP) + TOOL_TRUNCATE_NOTICE + ` (${s.length - MAX_TOOL_OUTPUT_KEEP} chars omitted)`
}
/** tool 파트 통째 교체(part.updated 전체 수신) 때도 output을 cap. 원본은 opencode에 보관. */
export function capSseToolPart<T>(part: T): T {
  const p = part as unknown as { type?: string; state?: { output?: unknown; metadata?: { output?: unknown }; status?: string } }
  if (!p || p.type !== 'tool' || !p.state) return part
  const running = p.state.status === 'running'
  const cap = running ? capRunningStreamOutput : capFinishedStreamOutput
  const out = p.state.output
  const metaOut = p.state.metadata?.output
  if (typeof out === 'string' && out.length > (running ? MAX_TOOL_OUTPUT_KEEP * 6 : MAX_TOOL_OUTPUT_KEEP)) {
    return { ...(p as object), state: { ...p.state, output: cap(out) } } as unknown as T
  }
  if (typeof metaOut === 'string' && metaOut.length > (running ? MAX_TOOL_OUTPUT_KEEP * 6 : MAX_TOOL_OUTPUT_KEEP)) {
    return { ...(p as object), state: { ...p.state, metadata: { ...p.state.metadata, output: cap(metaOut) } } } as unknown as T
  }
  return part
}
/**
 * SSE 실시간 병합용 text cap. 전송 경로(useSendPrompt)는 tool만 cap하고 text는
 * 두지 않지만, ephemeral SSE는 별도 EventSource라 reasoning·assistant 텍스트가
 * 무한히 쌓이는 경로다. git pull 로그가 텍스트로 스트리밍되면
 * 단일 part가 MB~GB로 자라 힙을 폭발시킨다. 응답 본문은 일반적으로
 * 1MB 미만이므로 1MB 상한은正常使用를 해치지 않으면서 방어한다.
 */
const MAX_TEXT_PART_KEEP = 1_000_000
export function capSseTextPart(s: string): string {
  if (s.length <= MAX_TEXT_PART_KEEP) return s
  return s.slice(0, MAX_TEXT_PART_KEEP) + `\n\n…[text truncated ${s.length - MAX_TEXT_PART_KEEP} chars]`
}
export function truncateLargeToolOutputs(messages: MessageListResponse): MessageListResponse {
  let changed = false
  let totalKept = 0
  const next = messages.map((msg) => {
    let msgChanged = false
    const newParts = msg.parts.map((part: any) => {
      // reasoning은 text/tool과 같은 cap을 적용한다 — 기존에 미절단이라
      // 873개 reasoning 파트가 통째로 힙에 남던 구멍을 막는다.
      if (part.type === 'reasoning' && typeof part.text === 'string' && part.text.length > MAX_TOOL_OUTPUT_KEEP) {
        msgChanged = true
        const truncated = part.text.slice(0, MAX_TOOL_OUTPUT_KEEP) + TOOL_TRUNCATE_NOTICE + ` (${part.text.length - MAX_TOOL_OUTPUT_KEEP} chars omitted)`
        totalKept += MAX_TOOL_OUTPUT_KEEP
        return { ...part, text: truncated }
      }
      // snapshot 통째 보관도 잘라낸다 (원본은 opencode DB에 유지)
      if (part.type === 'snapshot' && typeof part.snapshot === 'string' && part.snapshot.length > MAX_TOOL_OUTPUT_KEEP) {
        msgChanged = true
        const src = part.snapshot as string
        totalKept += MAX_TOOL_OUTPUT_KEEP
        return { ...part, snapshot: src.slice(0, MAX_TOOL_OUTPUT_KEEP) + TOOL_TRUNCATE_NOTICE + ` (${src.length - MAX_TOOL_OUTPUT_KEEP} chars omitted)` }
      }
      // file 파트의 data: URL(base64 붙여넣기 이미지)은 렌더에 원문이 필요 없다 — 칩만 남긴다
      if (part.type === 'file' && typeof part.url === 'string' && part.url.startsWith('data:') && part.url.length > 20_000) {
        msgChanged = true
        return { ...part, url: part.url.slice(0, 200) + `…[inline data truncated ${part.url.length - 200} chars]` }
      }
      // step/subtask 등 텍스트성 알 수 없는 파트도 방어적으로 cap
      if ((part.type === 'step-start' || part.type === 'step-finish' || part.type === 'subtask') && typeof part.text === 'string' && part.text.length > MAX_TOOL_OUTPUT_KEEP) {
        msgChanged = true
        const src = part.text as string
        totalKept += MAX_TOOL_OUTPUT_KEEP
        return { ...part, text: src.slice(0, MAX_TOOL_OUTPUT_KEEP) + TOOL_TRUNCATE_NOTICE + ` (${src.length - MAX_TOOL_OUTPUT_KEEP} chars omitted)` }
      }
      // edit 포함 모든 툴 + 큰 text 파트(파일 내용)도 힙을 잡는다 — 같이 잘라냄
      if (part.type === 'text' && typeof part.text === 'string' && part.text.length > MAX_TOOL_OUTPUT_KEEP * 2) {
        msgChanged = true
        const keep = Math.max(5_000, MAX_TOOL_OUTPUT_KEEP - Math.max(0, totalKept - 150_000))
        const truncated = part.text.length > keep ? part.text.slice(0, keep) + TOOL_TRUNCATE_NOTICE + ` (${part.text.length - keep} chars omitted)` : part.text
        totalKept += keep
        return { ...part, text: truncated }
      }
      if (part.type !== 'tool' || !part.state) return part
      const st = part.state as { output?: string; metadata?: { output?: string }; status?: string; input?: unknown }
      const out = st.output ?? st.metadata?.output
      const toolName = (part as any).tool ?? ''
      const isRead = toolName.toLowerCase().includes('read')
      // read는 파일 전체를 그대로 들고 와 더 크게 잡는다 — 10k로 더 짧게
      const keepLimit = isRead ? 10_000 : MAX_TOOL_OUTPUT_KEEP
      // edit/read 등은 input에 파일 내용이 통째로 들어갈 수 있어 input도 같이 체크
      const inputStr = typeof st.input === 'string' ? st.input : st.input ? JSON.stringify(st.input) : ''
      const inputLen = inputStr.length
      if (out) {
        const isRunning = st.status === 'running'
        if (!isRunning && out.length <= keepLimit && inputLen <= keepLimit) {
          totalKept += out.length + Math.min(inputLen, 5_000)
          return part
        }
        if (isRunning && out.length <= keepLimit * 6) {
          totalKept += out.length
          return part
        }
        msgChanged = true
        const budget = Math.max(5_000, keepLimit - Math.max(0, totalKept - 150_000))
        const keep = isRunning ? Math.min(out.length, keepLimit * 6) : Math.min(out.length, budget)
        const truncated = out.length > keep ? out.slice(0, keep) + TOOL_TRUNCATE_NOTICE + ` (${out.length - keep} chars omitted)` : out
        totalKept += keep
        let newState: any = { ...st }
        if (st.output != null) newState.output = truncated
        else newState.metadata = { ...(st.metadata ?? {}), output: truncated }
        // edit/read input도 크면 잘라냄 (원본은 opencode에 보관)
        if (inputLen > keepLimit) {
          const inKeep = 2_000
          newState.input = typeof st.input === 'string' ? (st.input as string).slice(0, inKeep) + `…[input truncated ${inputLen - inKeep} chars]` : st.input
        }
        return { ...part, state: newState }
      }
      // output은 없는데 input만 큰 경우 (edit/read)
      if (inputLen > keepLimit) {
        msgChanged = true
        let newState: any = { ...st, input: typeof st.input === 'string' ? (st.input as string).slice(0, 2_000) + `…[input truncated ${inputLen - 2_000} chars]` : st.input }
        return { ...part, state: newState }
      }
      return part
    })
    if (msgChanged) { changed = true; return { ...msg, parts: newParts } }
    for (const p of newParts) {
      if ((p as any).type === 'tool') {
        const s = (p as any).state
        totalKept += (s?.output ?? s?.metadata?.output ?? '').length
      } else if ((p as any).type === 'text' && typeof (p as any).text === 'string') {
        totalKept += (p as any).text.length
      }
    }
    return msg
  })
  return changed ? next as MessageListResponse : messages
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
  queryClient.invalidateQueries({ queryKey: messagesQueryKey(opcodeUrl, sessionID, directory) });
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

function isReasoningEncryptedMismatchMessage(msg: string): boolean {
  const m = msg.toLowerCase()
  return (
    m.includes("encrypted_content") &&
    (m.includes("reasoning") || m.includes("security") || m.includes("not issued") || m.includes("invalid_request_error"))
  )
}

function reasoningMismatchHint(): string {
  return "History contains reasoning blocks from a different model (or an interrupted turn) — retrying cannot succeed. Switch back to the model that owns the latest good turn, truncate back before the model switch (per-message scissors), or start a new session."
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
      if (isReasoningEncryptedMismatchMessage(providerMsg)) {
        return providerMsg + " - " + reasoningMismatchHint()
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
    if (isReasoningEncryptedMismatchMessage(error.message)) {
      return error.message + " - " + reasoningMismatchHint()
    }
    return error.message
  }
  if (typeof error === "string" && error.length > 0) {
    if (isBillingQuotaMessage(error)) return error + " - payment/recharge required."
    if (isReasoningEncryptedMismatchMessage(error)) return error + " - " + reasoningMismatchHint()
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

export const useSessions = (opcodeUrl: string | null | undefined, directory?: string, opts?: { poll?: boolean; repoId?: number }) => {
  const client = useOpenCodeClient(opcodeUrl, directory);

  return useQuery({
    // 키는 그대로 둔다 — 기존 invalidate 로직이 그대로 먹게.
    // repoId가 있으면 백엔드 병합 API(현재 경로 + 이동 전 별칭)로 가져온다.
    queryKey: ["opencode", "sessions", opcodeUrl, directory],
    queryFn: async () => {
      if (opts?.repoId != null) {
        const res = await fetch(`${API_BASE_URL}/api/repos/${opts.repoId}/sessions`);
        if (!res.ok) throw new Error('Failed to list repo sessions');
        const body = (await res.json()) as { sessions: Session[] };
        return body.sessions;
      }
      return client!.listSessions();
    },
    enabled: !!client,
    // 즐겨찾기 레포 팝업처럼 정적 목록이면 poll:false — 열 때 한 번만 로드한다.
    // Working 배찌는 useSessionStatusMap(전역 폴링)이 따로 갱신하므로 목록 폴링 불필요.
    refetchInterval: opts?.poll === false ? false : 2000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    staleTime: 5000,
    // 미사용 시 10초 뒤 메모리에서 제거 — 세션 목록도 pnpm 로그와 함께 힙 잡음
    gcTime: 10_000,
  });
};

export const useSession = (opcodeUrl: string | null | undefined, sessionID: string | undefined, directory?: string) => {
  const client = useOpenCodeClient(opcodeUrl, directory);

  return useQuery({
    queryKey: ["opencode", "session", opcodeUrl, sessionID, directory],
    queryFn: () => client!.getSession(sessionID!),
    enabled: !!client && !!sessionID,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    staleTime: 5000,
  });
};

/**
 * 폴링이 들고 오는 최근 메시지 수.
 * 전체 목록 폴링(GB)이 메모리 누수의 주범이므로 폴링은 최근 N개로 고정하고,
 * 이동·검색은 meta/range/one API로 주문형 처리한다.
 * 모든 useMessages 호출자는 이 상수를 써서 같은 쿼리키(캐시)를 공유해야 한다 —
 * limit이 다르면 키가 갈라져 이중 풀링이 된다.
 */
export const RECENT_MESSAGE_LIMIT = 60;

/**
 * 메시지 목록 쿼리의 canonical key.
 * 기존 코드 곳곳에 5-segment 키(["opencode","messages",url,sid,dir])가 하드코딩돼
 * 실제 6-segment 키(limit 포함)와 어긋나 읽기/쓰기가 고아 키에 닿던 문제를 막는다.
 * 폴링·SSE·optimistic·주문형 로드 모두 이 키로 통일한다.
 */
export function messagesQueryKey(
  opcodeUrl: string | null | undefined,
  sessionID: string | undefined,
  directory?: string,
  limit: number = RECENT_MESSAGE_LIMIT,
): readonly [string, string, string | null | undefined, string | undefined, string | undefined, number] {
  return ["opencode", "messages", opcodeUrl, sessionID, directory, limit] as const;
}

/** 최근 폴링이 본 세션 전체 메시지 수 (recent 응답의 total). 폴링·backfill마다 갱신.
 * 더보기 잔여 계산이 항상 최신 total을 보게 한다 (버튼 숫자가 흔들리던 원인). */
const recentTotals = new Map<string, number>();
const recentTotalListeners = new Set<() => void>();
function emitRecentTotal(): void {
  for (const fn of recentTotalListeners) {
    try { fn() } catch { /* ignore listener errors */ }
  }
}
export function getRecentTotal(sessionID: string): number | undefined {
  return recentTotals.get(sessionID);
}
export function setRecentTotal(sessionID: string, total: number): void {
  if (Number.isFinite(total) && total >= 0) {
    if (recentTotals.get(sessionID) === total) return;
    recentTotals.set(sessionID, total);
    emitRecentTotal();
  }
}
export function dropRecentTotal(sessionID: string): void {
  if (recentTotals.delete(sessionID)) emitRecentTotal();
}
/** 폴링이 본 전체 메시지 수를 리액티브로 구독한다 (Load more 잔여 표시용). */
export function useRecentTotal(sessionID: string | undefined): number | undefined {
  return useSyncExternalStore(
    (fn) => {
      recentTotalListeners.add(fn);
      return () => { recentTotalListeners.delete(fn) };
    },
    () => (sessionID ? (recentTotals.get(sessionID) ?? undefined) : undefined),
    () => undefined,
  );
}

/** 점프/검색으로 주문형 로드된 구간의 메시지 ID (세션별). 폴링 refetch가 덮어써도 유지한다. */
const backfilledIds = new Map<string, Set<string>>();
export function dropBackfilledId(sessionID: string, messageId: string): void {
  backfilledIds.get(sessionID)?.delete(messageId);
  unpinMessageAnchor(sessionID, messageId);
}
export function clearBackfilledIds(sessionID: string): void {
  backfilledIds.delete(sessionID);
}

/**
 * 점프 앵커 핀. ensureMessageLoaded로 로드된 타겟은 폴링 limit과 무관하게
 * 항상 보존한다 (작은 limit 쿼리가 backfill 조각을 밀어내는 것 방지).
 * 세션 전환 시 releaseMessageAnchors로만 해제한다.
 */
const MAX_PINNED_ANCHORS = 50;
const pinnedAnchors = new Map<string, Set<string>>();
export function pinMessageAnchor(sessionID: string, messageId: string): void {
  if (!messageId) return;
  let set = pinnedAnchors.get(sessionID);
  if (!set) {
    set = new Set();
    pinnedAnchors.set(sessionID, set);
  }
  set.add(messageId);
  while (set.size > MAX_PINNED_ANCHORS) {
    const oldest = set.values().next();
    if (oldest.done) break;
    set.delete(oldest.value);
  }
}
export function unpinMessageAnchor(sessionID: string, messageId: string): void {
  pinnedAnchors.get(sessionID)?.delete(messageId);
}
export function releaseMessageAnchors(sessionID: string): void {
  pinnedAnchors.delete(sessionID);
  // 핀과 함께 backfilled도 해제 — 둘 중 하나만 남으면 캐시가 무한 증식한다.
  // (clearBackfilledIds는 export됐지만 호출자가 없어 실효가 없었음)
  backfilledIds.delete(sessionID);
  pinReloadFailures.delete(sessionID);
  pinReloadLastRun.delete(sessionID);
}

/**
 * 핀은 살아있는데 캐시에 없는 경우 backfill로 재로드한다
 * (GC/리마운트/invalidate 후 점프 위치가 사라지는 것 방지).
 * 삭제된 메시지의 핀은 정리해 좀비 핀이 폴링을 돌지 않게 한다.
 * 네트워크 오류가 지속되면 세션당 연속 실패 3회 후 60초 쿨다운 —
 * messages 변경마다 effect가 돌 때 최대 50핀 × window 요청이 나가는 것을 막는다.
 */
const pinReloadFailures = new Map<string, { count: number; until: number }>();
const PIN_RELOAD_MAX_FAILURES = 3;
const PIN_RELOAD_COOLDOWN_MS = 60_000;
const PIN_RELOAD_MAX_TRACKED = 500;
// 핀 재로드 성공 경로 스로틀 — messages 변경 effect가 매 폴링마다 돌 때
// 전부-보유 상태에서도 Map 순회+getQueryData가 반복되는 것을 막는다.
const pinReloadLastRun = new Map<string, number>();
const PIN_RELOAD_THROTTLE_MS = 2_000;
export async function reloadMissingPins(
  queryClient: ReturnType<typeof useQueryClient>,
  opcodeUrl: string | null | undefined,
  sessionID: string,
  directory: string | undefined,
): Promise<void> {
  const pins = pinnedAnchors.get(sessionID);
  if (!pins || pins.size === 0) return;
  const now0 = Date.now();
  if (now0 - (pinReloadLastRun.get(sessionID) ?? 0) < PIN_RELOAD_THROTTLE_MS) return;
  pinReloadLastRun.set(sessionID, now0);
  const fb = pinReloadFailures.get(sessionID);
  if (fb && Date.now() < fb.until) return;
  const key = messagesQueryKey(opcodeUrl, sessionID, directory);
  const have = new Set((queryClient.getQueryData<MessageListResponse>(key) ?? []).map((m) => m.info.id));
  let failed = 0;
  for (const id of [...pins]) {
    if (have.has(id)) continue;
    try {
      const { messages } = await backfillMessages(queryClient, opcodeUrl, sessionID, directory, { around: id }, 30);
      if (messages.some((m) => m.info.id === id)) {
        const cur = queryClient.getQueryData<MessageListResponse>(key) ?? [];
        cur.forEach((m) => have.add(m.info.id));
      } else {
        unpinMessageAnchor(sessionID, id);
      }
    } catch (e) {
      // 404 등 사라진 메시지의 핀만 정리, 그 외 오류는 카운트 후 쿨다운
      if ((e as { status?: number })?.status === 404) unpinMessageAnchor(sessionID, id);
      else failed++;
    }
  }
  if (failed === 0) {
    pinReloadFailures.delete(sessionID);
    return;
  }
  // 갱신 시 delete 후 set으로 삽입 순서를 올린다 — Map.set은 기존 키 순서를
  // 바꾸지 않아 오래 연 세션의 쿨다운이 상한 정리 때 먼저 날아간다.
  const count = (pinReloadFailures.get(sessionID)?.count ?? 0) + 1;
  pinReloadFailures.delete(sessionID);
  pinReloadFailures.set(sessionID, {
    count: count >= PIN_RELOAD_MAX_FAILURES ? 0 : count,
    until: count >= PIN_RELOAD_MAX_FAILURES ? Date.now() + PIN_RELOAD_COOLDOWN_MS : 0,
  });
  while (pinReloadFailures.size > PIN_RELOAD_MAX_TRACKED) {
    const oldest = pinReloadFailures.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    pinReloadFailures.delete(oldest);
  }
}

function createdOf(m: MessageWithParts): number {
  return (m.info as unknown as { time?: { created?: number } }).time?.created ?? 0;
}

/** 캐시 병합: id 중복 제거 + 생성순 정렬 (stable — 동률은 기존 순서 유지).
 * 상한 초과 시 가장 오래된 비핀 메시지부터 버리고 backfilledIds에서도 제거한다.
 * (스크롤·점프로 2000개 세션을 다 읽으면 canonical 캐시가 그대로 GB 힙이 되던 원인)
 */
const MAX_CACHED_MESSAGES = 250;
function enforceCacheCap(sessionID: string, list: MessageListResponse): MessageListResponse {
  if (list.length <= MAX_CACHED_MESSAGES) return list;
  const pins = pinnedAnchors.get(sessionID);
  const sorted = [...list].sort((a, b) => createdOf(a) - createdOf(b));
  const keep = new Set<string>();
  // 최신 구간은 무조건 유지 (폴링 recent 윈도우)
  for (let i = sorted.length - 1; i >= 0 && keep.size < MAX_CACHED_MESSAGES; i--) {
    keep.add(sorted[i]!.info.id);
  }
  // 핀은 상한 밖이라도 유지 (최대 50개)
  if (pins) for (const id of pins) keep.add(id);
  const ids = backfilledIds.get(sessionID);
  const next = sorted.filter((m) => keep.has(m.info.id));
  if (ids) for (const m of sorted) if (!keep.has(m.info.id)) ids.delete(m.info.id);
  return next;
}
function mergeMessagesDeduped(sessionID: string, existing: MessageListResponse, incoming: MessageListResponse): MessageListResponse {
  const seen = new Set(existing.map((m) => m.info.id));
  const merged: MessageListResponse = [...existing];
  for (const m of incoming) {
    if (!seen.has(m.info.id)) { seen.add(m.info.id); merged.push(m); }
  }
  merged.sort((a, b) => createdOf(a) - createdOf(b));
  return enforceCacheCap(sessionID, truncateLargeToolOutputs(merged));
}

export interface MessageListItem {
  id: string;
  role: string;
  created: number;
  preview: string;
}

/**
 * 개수 전용 — 메시지 본문을 일절 읽지 않는 COUNT(*) (상단 표기용).
 * 가벼우므로 5초 간격으로 폴링해도 부담이 없다.
 */
export const useMessageCount = (
  sessionID: string | undefined,
  opts?: { poll?: boolean },
) => {
  return useQuery({
    queryKey: ["opencode", "message-count", sessionID],
    queryFn: async () => {
      const res = await fetch(`${API_BASE_URL}/api/session-messages/${sessionID!}/count`);
      if (!res.ok) throw new Error('Failed to load message count');
      return (await res.json()) as { total: number };
    },
    enabled: !!sessionID,
    staleTime: 3000,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: opts?.poll === false ? false : 5000,
    retry: false,
  });
};

/**
 * 검색 메뉴 진입 시 소량 리스트 — id/role/시간/미리보기만 (parts 없음, 폴링 없음).
 * order=asc면 오래된 것부터 (다이얼로그 시간순 브라우징용).
 */
export const useMessageList = (
  sessionID: string | undefined,
  opts?: { limit?: number; offset?: number; enabled?: boolean; order?: 'asc' | 'desc' },
) => {
  const limit = opts?.limit ?? 20;
  const offset = opts?.offset ?? 0;
  const order = opts?.order ?? 'desc';
  return useQuery({
    queryKey: ["opencode", "message-list", sessionID, limit, offset, order],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset), order });
      const res = await fetch(`${API_BASE_URL}/api/session-messages/${sessionID!}/list?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load message list');
      return (await res.json()) as { total: number; items: MessageListItem[] };
    },
    enabled: !!sessionID && (opts?.enabled ?? true),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
};

/**
 * 주문형 로드의 공통 몸통. 점프({around})·더보기({before})·향후 아래 확장({after})
 * 모두 여기로 모은다: window fetch → cap → backfilledIds 등록 → dedup 병합 →
 * canonical 키에 setQueryData. 호출자는 앵커와 개수만 지정한다.
 */
type BackfillAnchor = { around: string } | { before: string };
async function backfillMessages(
  queryClient: ReturnType<typeof useQueryClient>,
  opcodeUrl: string | null | undefined,
  sessionID: string,
  directory: string | undefined,
  anchor: BackfillAnchor,
  limit: number,
): Promise<{ messages: MessageListResponse; total: number; hasMore: boolean }> {
  const key = messagesQueryKey(opcodeUrl, sessionID, directory);
  const params = new URLSearchParams({ limit: String(limit) });
  if ('around' in anchor) params.set('around', anchor.around);
  else params.set('before', anchor.before);
  const res = await fetch(`${API_BASE_URL}/api/session-messages/${sessionID}/window?${params.toString()}`);
  if (!res.ok) {
    const err = new Error(`Failed to load message window (HTTP ${res.status})`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const body = (await res.json()) as { total: number; messages: MessageListResponse; hasMore?: boolean };
  const range = truncateLargeToolOutputs(body.messages);
  let ids = backfilledIds.get(sessionID);
  if (!ids) { ids = new Set(); backfilledIds.set(sessionID, ids); }
  for (const m of range) ids.add(m.info.id);
  queryClient.setQueryData<MessageListResponse>(key, (old) =>
    old && old.length > 0 ? mergeMessagesDeduped(sessionID, old, range) : truncateLargeToolOutputs(range),
  );
  setRecentTotal(sessionID, body.total);
  return { messages: range, total: body.total, hasMore: body.hasMore ?? false };
}

/**
 * 점프 타겟이 폴링 윈도우(최근 N개) 밖에 있으면 DB 윈도우 API로
 * 주문형 로드해 캐시에 합친다. 캐시에 있으면 네트워크 없이 true.
 * 전체 목록을 절대 가져오지 않는다.
 */
export async function ensureMessageLoaded(
  queryClient: ReturnType<typeof useQueryClient>,
  opcodeUrl: string | null | undefined,
  sessionID: string,
  directory: string | undefined,
  messageId: string,
): Promise<boolean> {
  const key = messagesQueryKey(opcodeUrl, sessionID, directory);
  const cached = queryClient.getQueryData<MessageListResponse>(key);
  if (cached?.some((m) => m.info.id === messageId)) {
    pinMessageAnchor(sessionID, messageId);
    return true;
  }
  try {
    const { messages } = await backfillMessages(queryClient, opcodeUrl, sessionID, directory, { around: messageId }, 30);
    const found = messages.some((m) => m.info.id === messageId);
    if (found) pinMessageAnchor(sessionID, messageId);
    return found;
  } catch {
    return false;
  }
}

/**
 * 내보내기용 전체 로드: 캐시를 건드리지 않고 서버를 끝까지 읽는다.
 * recent 200건으로 시작해 before 체인(limit 100)으로 과거로 내려가며
 * 로컬 배열에만 쌓는다 — 채팅 캐시를 통째로 불리면 메모리 작업이 무너진다.
 * 0건 진전·hasMore=false·앵커 소실 시 종료한다 (무한 루프 방지).
 * 앵커는 반드시 가장 오래된 메시지 — recent/window 모두 시간 오름차순이라
 * 끝에서 찾으면 최신이 걸려 같은 페이지만 반복한다 (치명적 방향 버그 수정됨).
 */
function oldestExportId(list: MessageListResponse): string | undefined {
  let best: MessageWithParts | null = null
  for (const m of list) {
    if (m.info.id.startsWith('optimistic')) continue
    if (!best || createdOf(m) < createdOf(best)) best = m
  }
  return best?.info.id
}
export async function loadAllSessionMessages(
  sessionID: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ messages: MessageListResponse; total: number }> {
  const acc: MessageListResponse = []
  const seen = new Set<string>()
  const push = (msgs: MessageListResponse) => {
    let added = 0
    for (const m of msgs) {
      if (seen.has(m.info.id)) continue
      seen.add(m.info.id)
      acc.push(m)
      added++
    }
    return added
  }
  const first = await fetch(`${API_BASE_URL}/api/session-messages/${sessionID}/recent?limit=200`)
  if (!first.ok) throw new Error(`Failed to load messages (HTTP ${first.status})`)
  const firstBody = (await first.json()) as { total: number; messages: MessageListResponse }
  const total = firstBody.total ?? 0
  push(truncateLargeToolOutputs(firstBody.messages ?? []))
  onProgress?.(acc.length, total)
  if (acc.length >= total) {
    acc.sort((a, b) => createdOf(a) - createdOf(b))
    return { messages: acc, total }
  }
  let anchor = oldestExportId(acc)
  for (;;) {
    if (!anchor) break
    const params = new URLSearchParams({ limit: '100', before: anchor })
    const res = await fetch(`${API_BASE_URL}/api/session-messages/${sessionID}/window?${params.toString()}`)
    if (!res.ok) throw new Error(`Failed to load message window (HTTP ${res.status})`)
    const body = (await res.json()) as { total: number; messages: MessageListResponse; hasMore?: boolean }
    const added = push(truncateLargeToolOutputs(body.messages ?? []))
    onProgress?.(acc.length, body.total ?? total)
    if (!body.hasMore || added === 0) break
    const next = oldestExportId(acc)
    if (!next || next === anchor) break
    anchor = next
  }
  acc.sort((a, b) => createdOf(a) - createdOf(b))
  return { messages: acc, total }
}

/**
 * 윈도우 상단 메시지보다 오래된 개수 (COUNT 1회).
 * 점프 병합 뒤 캐시에 틈이 생기면 total-len 공식이 어긋나므로 상단 기준으로 직접 센다.
 */
export async function fetchMessageRank(sessionID: string, messageID: string): Promise<number | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/session-messages/${encodeURIComponent(sessionID)}/rank?messageId=${encodeURIComponent(messageID)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { older?: number };
    return typeof body?.older === 'number' ? body.older : null;
  } catch {
    return null;
  }
}

/**
 * 리스트 상단 "더 보기": 캐시된 가장 오래된 메시지 이전을 count개 더 가져와
 * 앞에 붙인다. 새로 붙은 개수(스크롤 위치 유지용)·전체 total·서버 잔여 여부를
 * 돌려준다. truncateLargeToolOutputs·backfilledIds·병합은 backfillMessages가 처리.
 */
export async function loadOlderMessages(
  queryClient: ReturnType<typeof useQueryClient>,
  opcodeUrl: string | null | undefined,
  sessionID: string,
  directory: string | undefined,
  count = 30,
): Promise<{ loaded: number; total: number; hasMore: boolean }> {
  const key = messagesQueryKey(opcodeUrl, sessionID, directory);
  const cached = queryClient.getQueryData<MessageListResponse>(key) ?? [];
  // 낙관적 항목(아직 서버에 없음)을 앵커로 쓰면 window가 404가 된다 — 실재 ID만 쓴다
  const oldest = cached.find((m) => !m.info.id.startsWith('optimistic'));
  if (!oldest) return { loaded: 0, total: getRecentTotal(sessionID) ?? 0, hasMore: false };
  const beforeIds = new Set(cached.map((m) => m.info.id));
  try {
    const { messages, total, hasMore } = await backfillMessages(queryClient, opcodeUrl, sessionID, directory, { before: oldest.info.id }, count);
    const loaded = messages.filter((m) => !beforeIds.has(m.info.id)).length;
    return { loaded, total, hasMore };
  } catch (e) {
    // 앵커가 서버에 없으면(잘린 뒤 stale 캐시 등) 앵커를 캐시·backfilled에서 제거하고
    // 새 최상단 기준으로 1회 재시도. 그래도 실패하면 던져 호출자가 토스트를 띄운다.
    if ((e as { status?: number })?.status === 404) {
      dropBackfilledId(sessionID, oldest.info.id);
      queryClient.setQueryData<MessageListResponse>(key, (old) =>
        old?.filter((m) => m.info.id !== oldest.info.id),
      );
      const fresh = queryClient.getQueryData<MessageListResponse>(key) ?? [];
      const retryAnchor = fresh.find((m) => !m.info.id.startsWith('optimistic'));
      if (retryAnchor) {
        const { messages, total, hasMore } = await backfillMessages(queryClient, opcodeUrl, sessionID, directory, { before: retryAnchor.info.id }, count);
        const loaded = messages.filter((m) => !beforeIds.has(m.info.id)).length;
        return { loaded, total, hasMore };
      }
    }
    throw e;
  }
}

export const useMessages = (opcodeUrl: string | null | undefined, sessionID: string | undefined, directory?: string, limit?: number, opts?: { poll?: boolean }) => {
  const client = useOpenCodeClient(opcodeUrl, directory);
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: messagesQueryKey(opcodeUrl, sessionID, directory, limit ?? RECENT_MESSAGE_LIMIT),
    queryFn: async () => {
      // opencode SQLite에서 최근 N개만 읽는다 — opencode HTTP 목록 API는
      // 페이지네이션이 없어 전체를 직렬화하므로 절대 쓰지 않는다.
      // (즐겨찾기 팝업 limit=10도 같은 recent 엔드포인트를 공유한다)
      const params = new URLSearchParams()
      if (limit && limit > 0) params.set('limit', String(limit))
      else params.set('limit', String(RECENT_MESSAGE_LIMIT))
      const res = await fetch(`${API_BASE_URL}/api/session-messages/${sessionID!}/recent?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load messages');
      const body = (await res.json()) as { total: number; messages: MessageListResponse };
      // 전체 total을 매 폴링마다 기록 — 더보기 잔여 계산용 (별도 count 폴링 없음)
      setRecentTotal(sessionID!, body.total);
      const data = body.messages;
      let result = applyTruncationWindow(sessionID!, data);
      const ownKey = messagesQueryKey(opcodeUrl, sessionID, directory, limit ?? RECENT_MESSAGE_LIMIT);
      const cached = queryClient.getQueryData<MessageListResponse>(ownKey);
      if (cached && result.length > 0 && cached.length > 0) {
        const cachedLast = cached[cached.length - 1]!;
        const resultLast = result[result.length - 1]!;
        if (cachedLast.info.id === resultLast.info.id && cachedLast.parts.length > resultLast.parts.length) {
          result = [...result.slice(0, -1), cachedLast];
        } else if (cachedLast.info.id === resultLast.info.id) {
          // 길이 ?�산?�로�?비교 ??join?�?거�? ?�당?�라 길이 ?�정?�는 ?��? ?�는??
          // reasoning도 비교한다 — SSE로 스트리밍된 추론 텍스트가 DB 빈 텍스트로
          // 덮여 "마지막 reasoning이 완료와 동시에 사라지는" 원인이었다.
          const cTextLen = textPartsLength(cachedLast.parts);
          const rTextLen = textPartsLength(resultLast.parts);
          const cToolLen = toolOutputLength(cachedLast.parts);
          const rToolLen = toolOutputLength(resultLast.parts);
          const cReasonLen = reasoningPartsLength(cachedLast.parts);
          const rReasonLen = reasoningPartsLength(resultLast.parts);
          if (cTextLen > rTextLen || cToolLen > rToolLen || cReasonLen > rReasonLen) result = [...result.slice(0, -1), cachedLast];
        }
      }
      // 주문형 로드된 구형 구간 보존 — 폴링(limit=60)이 refetch해도 점프용 히스토리가 날아가지 않게.
      // 삭제된 메시지의 부활을 막기 위해 backfilledIds에 기록된 것만 유지한다
      // (delete/truncate는 해당 ID를 집합에서 제거한다).
      // 미리보기용 limit=10 쿼리(즐겨찾기 팝업)에는 backfilled를 적용하지 않는다.
      const backfilled = backfilledIds.get(sessionID!);
      const shouldPreserve = !limit || limit >= RECENT_MESSAGE_LIMIT;
      const freshIdsForKeep = new Set(result.map((m) => m.info.id));
      if (shouldPreserve && backfilled && backfilled.size > 0 && cached && result.length > 0) {
        const keep = cached.filter((m) => backfilled.has(m.info.id) && !freshIdsForKeep.has(m.info.id));
        if (keep.length > 0) {
          result = [...keep, ...result].sort((a, b) => createdOf(a) - createdOf(b));
        }
      }
      // 점프 앵커 핀 — limit과 무관하게 항상 보존한다. 작은 limit 쿼리라도
      // 핀은 해당 키 캐시에 있던 항목만 유지하므로 미리보기가 부풀지 않는다.
      const pinned = pinnedAnchors.get(sessionID!);
      if (pinned && pinned.size > 0 && cached && result.length > 0) {
        const keepPinned = cached.filter((m) => pinned.has(m.info.id) && !freshIdsForKeep.has(m.info.id));
        if (keepPinned.length > 0) {
          result = [...keepPinned, ...result].sort((a, b) => createdOf(a) - createdOf(b));
        }
      }
      // 보존 병합 후에도 상한을 강제한다 — 폴링 refetch가 backfilled를
      // 계속 끌고 오면 recent-60 쿼리 캐시가 세션 전체로 부푸는 것을 막는다.
      if (shouldPreserve && result.length > MAX_CACHED_MESSAGES) {
        result = enforceCacheCap(sessionID!, result);
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
      // 대용량 bash 출력 즉시 잘라 메모리 폭증 방지 — 완료된 툴만 80k로 truncate
      result = truncateLargeToolOutputs(result)
      const statuses = queryClient.getQueryData<{ sessionId: string; status: string }[]>(["session-status-db"])
      const isBusy = statuses?.some((s) => s.sessionId === sessionID && s.status === "busy") ?? false
      const hasPending = pendingOptimistic.has(sessionID!) || activeSendControllers.has(sessionID!)
      const reconciled = isRecentlyAborted(sessionID!)
        ? reconcileOrphanedStreams(result, sessionID!, false)
        : hasPending
          ? reconcileOrphanedStreams(result, sessionID!, true)
          : reconcileOrphanedStreams(result, sessionID!, isBusy)
      // 내용 동일하면 캐시 참조 그대로 반환 — 새 배열이 생길 때마다 하위
      // useMemo(MessageThread prepared 등)가 전부 재계산되고 힙이 부푼다.
      // fetch 중 SSE 병합이 끼었을 수 있어 캐시를 다시 읽어 비교한다.
      // SSE가 fetch보다 앞서면 fresh 덮기로 화면이 되감기므로 캐시를 유지한다.
      const latest = queryClient.getQueryData<MessageListResponse>(ownKey) ?? cached
      if (latest && (sameMessageList(latest, reconciled) || isCachedAhead(latest, reconciled))) return latest
      return reconciled;
    },
    enabled: !!client && !!sessionID,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    // 세션 전환 시 이전 메시지 캐시는 10초만 유지 후 메모리에서 제거 — bash 등 대용량 툴 출력이 30초 동안 힙을 잡아 7GB까지 가던 원인
    // idle이면 10초 폴링이라 10초 gcTime이면 다음 폴링 전까지 캐시가 살아있어 깜빡임 없이 유지된다.
    gcTime: 10_000,
    //placeholderData: (previousData) => previousData,
    staleTime: 2000,
    refetchInterval: (query) => {
      // 즐겨찾기 팝업처럼 열 때 한 번만 가져오는 용도 — 폴링 없음 (메모리 대응)
      if (opts?.poll === false) return false
      if (isRecentlyAborted(sessionID!)) return 2000
      const data = query.state.data as MessageListResponse | undefined
      const last = data?.[data.length - 1] as unknown as { info: { role: string; time: Record<string, unknown> }; parts: { type: string }[] } | undefined
      const hasReasoning = !!last?.parts?.some((p) => p.type === 'reasoning')
      const hasPending = pendingOptimistic.has(sessionID!) || activeSendControllers.has(sessionID!)
      // optimistic 미도착(hasPending) 동안은 전체 폴링 유지 — 도착 확인 자체가
      // 전체 목록으로 이루어지므로 끄면 120s 타임아웃까지 고착된다.
      if (hasPending) return hasReasoning ? 500 : 1500
      const streaming = last ? !('completed' in (last.info.time as Record<string, unknown>) && (last.info.time as { completed?: number }).completed) && last.info.role === 'assistant' : false
      // 스트리밍 중 전체 60건 재조회는 중단 — 같은 내용을 수백 번 재파싱하는 주범.
      // 증가분은 380ms last-message 폴링 + SSE가 커버하고, 전체 목록은
      // 턴 완료(SSE idle) 때 갱신된다. 5s는 SSE 유실 시 안전망.
      if (hasReasoning && streaming) return 5000
      if (streaming) return 5000
      const statuses = queryClient.getQueryData<{ sessionId: string; status: string }[]>(["session-status-db"])
      const dbBusy = statuses?.some((s) => s.sessionId === sessionID && s.status === "busy") ?? false
      if (dbBusy) return 5000
      // 완전 idle이면 10초로 늦춘다 — 2초마다 전체 목록 파싱이 긴 세션에서
      // 힙을 계속 부풀리는 주범이다. 전송 중(optimistic 미도착)은 위에서 빠른 주기 유지.
      // (TUI 등 외부 변경은 최대 10초 늦게 반영, 상태 배지는 별도 1.2초 폴링 유지)
      return 10000
    },
  });
};

export const usePollLastMessage = (
  opcodeUrl: string | null | undefined,
  sessionID: string | undefined,
  directory?: string,
  enabled?: boolean,
  /**
   * false(SSE off)면 폴링은 계속하되 완료 메시지만 병합한다.
   * partial 병합을 건너뛰어 off 모드에서 백그라운드 churn·실시간 표시가 없게 한다.
   */
  mergePartial: boolean = true,
) => {
  const client = useOpenCodeClient(opcodeUrl, directory);
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ["opencode", "last-message", opcodeUrl, sessionID, directory],
    queryFn: async () => {
      const all = queryClient.getQueryData<MessageListResponse>(messagesQueryKey(opcodeUrl, sessionID, directory))
      const last = all?.[all.length - 1]
      if (!last) return null
      if (last.info.id.startsWith("optimistic_")) return null
      if ('completed' in (last.info.time as Record<string, unknown>) && (last.info.time as { completed?: number }).completed) return null
      try {
        const msg = await client!.getMessage(sessionID!, last.info.id)
        // msg은 opencode에서 온 원본 — tool output이 수 GB일 수 있다.
        // poll은 380ms마다 setQueryData에 새로운 배열을 넣고,
        // placeholderData/gcTime(10s)로 2사본이 동시에 살아있어 ힵ 폭발이 생긴다.
        // poll 전용으로도 tool output을 cap해야 캐시가 무한히 자라지 않는다.
        const capped = truncateLargeToolOutputs([msg as MessageWithParts])[0]!
        // SSE off 모드: 완료됐을 때만 병합한다. 미완료 partial은 버려
        // 표시(Generating 플레이스홀더)와 캐시 churn이 생기지 않게 한다.
        if (!mergePartial) {
          const done = 'completed' in (capped.info.time as Record<string, unknown>) && Boolean((capped.info as { time: { completed?: number } }).time.completed)
          if (!done) return null
        }
        const merged: MessageListResponse = all ? [...all.slice(0, -1), capped] : [capped]
        queryClient.setQueryData(messagesQueryKey(opcodeUrl, sessionID, directory), (old: MessageListResponse | undefined) => {
          if (!old || old.length === 0) return merged
          const curLast = old[old.length - 1]
          if (curLast.info.id !== last.info.id) return old
          const curCompleted = 'completed' in (curLast.info.time as Record<string, unknown>) && Boolean((curLast.info.time as { completed?: number }).completed)
          const nextCompleted = 'completed' in (capped.info.time as Record<string, unknown>) && Boolean((capped.info as { time: { completed?: number } }).time.completed)
          // SSE가 ?�서 ?��? ?�으�??�링 결과가 ??��?��? ?�도�?보존 ???�전?�는 ?�일 ?�스?�일 ?�만 ?��???SSE 증분???�아갔다
          // 길이가 ?�르�?join ?�이 ?�정 (?�트리밍 �?99%????경로), 같을 ?�만 ?�용 ?�등 ?�인
          const curTextLen = textPartsLength(curLast.parts)
          const nextTextLen = textPartsLength(capped.parts as MessageWithParts["parts"])
          const curToolLen = toolOutputLength(curLast.parts)
          const nextToolLen = toolOutputLength(capped.parts as MessageWithParts["parts"])
          if (curLast.parts.length === capped.parts.length && curCompleted === nextCompleted && curTextLen === nextTextLen && curToolLen === nextToolLen) {
            const curText = curLast.parts.filter((p: unknown) => (p as { type: string }).type === 'text').map((p: unknown) => (p as { text: string }).text ?? '').join('')
            const nextText = (capped.parts as unknown[]).filter((p: unknown) => (p as { type: string }).type === 'text').map((p: unknown) => (p as { text: string }).text ?? '').join('')
            const curTool = curLast.parts.filter((p: unknown) => (p as { type: string }).type === 'tool').map((p: unknown) => ((p as unknown as { state?: { output?: string; metadata?: { output?: string } } }).state?.output ?? (p as unknown as { state?: { metadata?: { output?: string } } }).state?.metadata?.output ?? '')).join('')
            const nextTool = (capped.parts as unknown[]).filter((p: unknown) => (p as { type: string }).type === 'tool').map((p: unknown) => ((p as unknown as { state?: { output?: string; metadata?: { output?: string } } }).state?.output ?? (p as unknown as { state?: { metadata?: { output?: string } } }).state?.metadata?.output ?? '')).join('')
            if (curText === nextText && curTool === nextTool) return old
          }
          // SSE가 ??길면 ?�버 ?�답??lagging ????��?��? ?�는??
          if (curTextLen > nextTextLen || curToolLen > nextToolLen) return old
          // ?�버가 ??길거???�료 ?�태가 바뀌었???�만 교체
          return [...old.slice(0, -1), capped]
        })
        return capped
      } catch {
        return null
      }
    },
    enabled: !!client && !!sessionID && !!enabled,
    // SSE off(mergePartial=false)면 완료 감지용으로만 천천히 폴링한다
    refetchInterval: mergePartial ? 380 : 2000,
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
      queryClient.invalidateQueries({ queryKey: messagesQueryKey(opcodeUrl, sessionID, directory) });
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
      const messagesKey = messagesQueryKey(opcodeUrl, sessionID, directory);
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
        // 잘려나간 ID는 backfilled 집합에서도 제거 — 폴링 preserve가 부활시키지 않게
        for (const id of removedIds) dropBackfilledId(sessionID, id);
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
      queryClient.invalidateQueries({ queryKey: messagesQueryKey(opcodeUrl, sessionID, directory) });
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
    onMutate: async ({ sessionID, messageID }) => {
      // 삭제된 메시지가 폴링 preserve로 부활하지 않게 캐시·backfilled에서 즉시 제거
      dropBackfilledId(sessionID, messageID);
      const key = messagesQueryKey(opcodeUrl, sessionID, directory);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<MessageListResponse>(key);
      queryClient.setQueryData<MessageListResponse>(key, (old) => old?.filter((m) => m.info.id !== messageID));
      return { key, previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(context.key, context.previous);
    },
    onSettled: (_data, _error, variables) => {
      const { sessionID } = variables;
      queryClient.invalidateQueries({ queryKey: ["opencode", "session", opcodeUrl, sessionID, directory] });
      queryClient.invalidateQueries({ queryKey: messagesQueryKey(opcodeUrl, sessionID, directory) });
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
    // 채팅 경로는 레포 없이 chat_uploads/... 로 — 변환은 doc-reader fallback이 처리
    return `@"${path.slice(chatIdx + 1)}"`
  }
  const reposIdx = path.indexOf("/repos/")
  if (reposIdx >= 0) {
    // repos/aaa/src/file.ts → src/file.ts (레포 없이, 채팅과 동일)
    const afterRepos = path.slice(reposIdx + "/repos/".length)
    const slash = afterRepos.indexOf("/")
    const rel = slash >= 0 ? afterRepos.slice(slash + 1) : afterRepos
    return `@"${rel}"`
  }
  return `@"${part.name}"`
};

export const useSendPrompt = (opcodeUrl: string | null | undefined, directory?: string) => {
  const client = useOpenCodeClient(opcodeUrl, directory);
  const queryClient = useQueryClient();
  // Use default model for optimistic assistant placeholder so LLM area shows correct model immediately
  let defaultModel: string | undefined
  try {
    const settingsData = queryClient.getQueryData<{ preferences?: { defaultModel?: string } }>(["settings", "default"])
      ?? queryClient.getQueryData<{ preferences?: { defaultModel?: string } }>(["settings"])
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

      clearCancelledUntilNextSend(sessionID);
      fetch(`${API_BASE_URL}/api/session-status/${encodeURIComponent(sessionID)}/cancelled`, { method: 'DELETE' }).catch(() => {})
      const optimisticUserID = `optimistic_user_${Date.now()}_${Math.random()}`;

      const contentParts = parts || [{ type: "text" as const, content: prompt || "", name: "" }];

      const userMessage = createOptimisticUserMessage(
        sessionID,
        contentParts,
        optimisticUserID,
      );
      await queryClient.cancelQueries({ queryKey: messagesQueryKey(opcodeUrl, sessionID, directory) });
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
        messagesQueryKey(opcodeUrl, sessionID, directory),
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
      // 설정에서 SSE를 끄면 per-send 스트림도 열지 않는다 — 폴링(usePollLastMessage)이 갱신을 담당
      let sseOn = true
      try {
        const sseSettings = queryClient.getQueryData<{ preferences?: { sseStreaming?: boolean } }>(["settings", "default"])
          ?? queryClient.getQueryData<{ preferences?: { sseStreaming?: boolean } }>(["settings"])
        if (sseSettings?.preferences?.sseStreaming === false) sseOn = false
      } catch {}
      const capIncomingToolPart = (p: any): any => {
        if (p?.type !== 'tool' || !p?.state) return p
        const st = p.state as { output?: string; metadata?: { output?: string }; status?: string }
        const out = st.output ?? st.metadata?.output
        if (!out) return p
        const toolName = (p as any).tool ?? ''
        const isRead = String(toolName).toLowerCase().includes('read')
        const isRunning = st.status === 'running'
        const keep = isRunning ? (isRead ? 60_000 : MAX_TOOL_OUTPUT_KEEP * 6) : (isRead ? 10_000 : MAX_TOOL_OUTPUT_KEEP)
        if (out.length <= keep) return p
        // pnpm이 한 번에 6GB를 쏘면 힙이 터지므로 들어오자마자 잘라냄
        const truncated = out.slice(0, keep) + TOOL_TRUNCATE_NOTICE + ` (${out.length - keep} chars omitted)`
        if (st.output != null) return { ...p, state: { ...st, output: truncated } }
        return { ...p, state: { ...st, metadata: { ...(st.metadata ?? {}), output: truncated } } }
      }
      const sseMergePart = (part: MessageWithParts["parts"][number], delta?: string) => {
        part = capIncomingToolPart(part as any) as MessageWithParts["parts"][number]
        const key = messagesQueryKey(opcodeUrl, sessionID, directory);
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
                  if (partMetaOut === curMeta + delta) nextPart = capIncomingToolPart(part) as typeof part;
                  else {
                    let nextOut: string
                    if (delta.length > MAX_TOOL_OUTPUT_KEEP * 6) {
                      nextOut = `…[delta truncated ${delta.length - MAX_TOOL_OUTPUT_KEEP} chars]\n` + delta.slice(-MAX_TOOL_OUTPUT_KEEP)
                    } else {
                      nextOut = curMeta + delta
                      if (nextOut.length > MAX_TOOL_OUTPUT_KEEP * 6) {
                        nextOut = `…[stream truncated, showing last ${MAX_TOOL_OUTPUT_KEEP} chars]\n` + nextOut.slice(-MAX_TOOL_OUTPUT_KEEP)
                      }
                    }
                    nextPart = { ...existing, state: { ...st, metadata: { ...meta, output: nextOut } } } as unknown as typeof part;
                  }
                } else {
                  const cur = typeof (st as { output?: unknown }).output === 'string' ? (st as { output: string }).output : '';
                  const partOut = (part as unknown as { state?: { output?: string } }).state?.output ?? "";
                  if (partOut === cur + delta) nextPart = capIncomingToolPart(part) as typeof part;
                  else {
                    let nextOut: string
                    if (delta.length > MAX_TOOL_OUTPUT_KEEP) {
                      nextOut = delta.slice(0, MAX_TOOL_OUTPUT_KEEP) + TOOL_TRUNCATE_NOTICE + ` (${delta.length - MAX_TOOL_OUTPUT_KEEP} chars omitted)`
                    } else {
                      nextOut = cur + delta
                      if (nextOut.length > MAX_TOOL_OUTPUT_KEEP) {
                        nextOut = nextOut.slice(0, MAX_TOOL_OUTPUT_KEEP) + TOOL_TRUNCATE_NOTICE + ` (${nextOut.length - MAX_TOOL_OUTPUT_KEEP} chars omitted)`
                      }
                    }
                    nextPart = { ...existing, state: { ...st, output: nextOut } } as unknown as typeof part;
                  }
                }
              }
            }
            nextParts = [...msg.parts]; nextParts[pIdx] = nextPart;
          }
          const next = [...old]; next[idx] = { ...msg, parts: nextParts }; return next;
        });
      };
      const sseMergeMessage = (info: MessageWithParts["info"]) => {
        const key = messagesQueryKey(opcodeUrl, sessionID, directory);
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
            const key = messagesQueryKey(opcodeUrl, sessionID, directory);
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
                nextPart = { ...existing, text: capSseTextPart((existing.text ?? "") + delta) } as MessageWithParts["parts"][number];
              } else if (existing.type === "text") {
                nextPart = { ...existing, text: capSseTextPart((existing.text ?? "") + delta) } as MessageWithParts["parts"][number];
              } else if (existing.type === "tool") {
                const st = (existing as unknown as { state: Record<string, unknown> }).state ?? {} as Record<string, unknown>;
                const isRunning = (st as { status?: string }).status === 'running';
                if (isRunning) {
                  const meta = ((st as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>;
                  const curMeta = typeof (meta as { output?: unknown }).output === 'string' ? (meta as { output: string }).output : '';
                  let nextOut: string
                  if (delta.length > MAX_TOOL_OUTPUT_KEEP * 6) {
                    nextOut = `…[delta truncated ${delta.length - MAX_TOOL_OUTPUT_KEEP} chars]\n` + delta.slice(-MAX_TOOL_OUTPUT_KEEP)
                  } else {
                    nextOut = curMeta + delta
                    if (nextOut.length > MAX_TOOL_OUTPUT_KEEP * 6) {
                      nextOut = `…[stream truncated, showing last ${MAX_TOOL_OUTPUT_KEEP} chars]\n` + nextOut.slice(-MAX_TOOL_OUTPUT_KEEP)
                    }
                  }
                  nextPart = { ...existing, state: { ...st, metadata: { ...meta, output: nextOut } } } as unknown as MessageWithParts["parts"][number];
                } else {
                  const cur = typeof (st as { output?: unknown }).output === 'string' ? (st as { output: string }).output : '';
                  let nextOut: string
                  if (delta.length > MAX_TOOL_OUTPUT_KEEP) {
                    nextOut = delta.slice(0, MAX_TOOL_OUTPUT_KEEP) + TOOL_TRUNCATE_NOTICE + ` (${delta.length - MAX_TOOL_OUTPUT_KEEP} chars omitted)`
                  } else {
                    nextOut = cur + delta
                    if (nextOut.length > MAX_TOOL_OUTPUT_KEEP) {
                      nextOut = nextOut.slice(0, MAX_TOOL_OUTPUT_KEEP) + TOOL_TRUNCATE_NOTICE + ` (${nextOut.length - MAX_TOOL_OUTPUT_KEEP} chars omitted)`
                    }
                  }
                  nextPart = { ...existing, state: { ...st, output: nextOut } } as unknown as MessageWithParts["parts"][number];
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
            queryClient.invalidateQueries({ queryKey: messagesQueryKey(opcodeUrl, sessionID, directory) });
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
      if (sseOn) {
      try {
        es = new EventSource(esUrl);
        activeSSEMap.set(sessionID, es);
        es.onmessage = sseHandle;
        ["message.part.updated","message.updated","message.removed","session.idle"].forEach((tt) => { try { es!.addEventListener(tt, sseHandle as EventListener); } catch {} });
      } catch {}
      }

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
      queryClient.invalidateQueries({ queryKey: messagesQueryKey(opcodeUrl, variables.sessionID, directory) })
      // sending?�??�버???�상 반영?�어 ?�면??뿌려�??�까지 ?��? ??useMessages??realUserArrived?�서 교체
      // ?�패/?�?�아???�비??30�??�에�?강제 ?�리 (?�무 ?�찍 지?��? ?�음)
      setTimeout(() => {
        if (!pendingOptimistic.has(variables.sessionID)) return
        const cur = queryClient.getQueryData<MessageListResponse>(messagesQueryKey(opcodeUrl, variables.sessionID, directory))
        const pending = pendingOptimistic.get(variables.sessionID)
        if (!pending) return
        const real = cur?.find((m) => {
          if (m.info.role !== "user" || m.info.id.startsWith("optimistic_sending_") || m.info.id.startsWith("optimistic_")) return false
          if (Math.abs((m.info.time?.created ?? 0) - (pending.info.time?.created ?? 0)) > 60000) return false
          return true
        })
        if (!real) {
          queryClient.setQueryData<MessageListResponse>(messagesQueryKey(opcodeUrl, variables.sessionID, directory), (old) => old?.filter((m) => !m.info.id.startsWith("optimistic_sending_")) ?? old)
          pendingOptimistic.delete(variables.sessionID)
        }
      }, 30000)
    },
    onError: (error, variables) => {
      const { sessionID } = variables;
      const formatted = formatServerError(error)
      queryClient.setQueryData<MessageListResponse>(
        messagesQueryKey(opcodeUrl, sessionID, directory),
        (old) => old?.filter((msg) => !msg.info.id.startsWith("optimistic_")),
      );
      pendingOptimistic.delete(sessionID)
      // 서버 응답 없음(한 번 전송 후 포기)도 캔슬 배찌 대상 — DB에도 저장
      markCancelledUntilNextSend(sessionID)
      fetch(`${API_BASE_URL}/api/session-status/${encodeURIComponent(sessionID)}/cancelled`, { method: 'POST' }).catch(() => {})
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
    refetchInterval: 1200,
    staleTime: 800,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
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
      const acAtAbort = activeSendControllers.get(sessionID)
      const esAtAbort = activeSSEMap.get(sessionID)
      const pendingAtAbort = pendingOptimistic.get(sessionID)
      abortActiveSend(sessionID)
      recentlyAborted.set(sessionID, Date.now());
      await queryClient.cancelQueries({ queryKey: messagesQueryKey(opcodeUrl, sessionID, directory) })
      await queryClient.cancelQueries({ queryKey: ["opencode", "last-message", opcodeUrl, sessionID, directory] })
      markSessionMessagesCompleted(queryClient, opcodeUrl, directory, sessionID);
      queryClient.setQueryData<MessageListResponse>(messagesQueryKey(opcodeUrl, sessionID, directory), (old) => {
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
      // 백엔드 큐 sending 표시도 즉시 갱신 — 2s 폴링을 기다리면 취소가 안 된 것처럼 보인다.
      queryClient.invalidateQueries({ queryKey: ['chat-queue', sessionID] })
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
      queryClient.invalidateQueries({ queryKey: ['chat-queue', sessionID] })
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
      await queryClient.cancelQueries({ queryKey: messagesQueryKey(opcodeUrl, sessionID, directory) });
      pendingOptimistic.set(sessionID, userMessage);
      queryClient.setQueryData<MessageListResponse>(
        messagesQueryKey(opcodeUrl, sessionID, directory),
        (old) => [...(old || []), userMessage],
      );

      const response = await client.sendShell(sessionID, {
        command,
        agent: agent || "general",
      });

      return { optimisticUserID, response };
    },
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: messagesQueryKey(opcodeUrl, variables.sessionID, directory) })
      setTimeout(() => {
        if (pendingOptimistic.has(variables.sessionID)) {
          const cur = queryClient.getQueryData<MessageListResponse>(messagesQueryKey(opcodeUrl, variables.sessionID, directory))
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
            queryClient.setQueryData<MessageListResponse>(messagesQueryKey(opcodeUrl, variables.sessionID, directory), (old) => {
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
        messagesQueryKey(opcodeUrl, sessionID, directory),
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
      const key = messagesQueryKey(opcodeUrl, sessionID, directory);
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
          // 새로 들어오는 tool 파트도 전체 출력이면 여기서 cap (delta 없는 part.updated 경로)
          nextParts = [...msg.parts, capSseToolPart(part)];
        } else {
          const existing = msg.parts[pIdx] as { type: string; text?: string; state?: { output?: string; metadata?: { output?: string }; status?: string } };
          let nextPart: typeof part = part;
          if (delta) {
            // reasoning은 opencode가 빈 파트 껍데기 + message.part.delta로 스트리밍한다.
            // 분기가 없으면 통째 교체라 라이브 추론이 안 보인다.
            if (existing.type === "reasoning" && typeof existing.text === "string") {
              const pText = (part as { text?: string }).text ?? "";
              if (pText === capSseTextPart(existing.text + delta)) nextPart = part;
              else nextPart = { ...existing, text: capSseTextPart(existing.text + delta) } as unknown as typeof part;
            } else if (existing.type === "text" && typeof existing.text === "string") {
              nextPart = { ...part, text: capSseTextPart(existing.text + delta) } as typeof part;
            } else if (existing.type === "tool") {
              const st = (existing as unknown as { state: Record<string, unknown> }).state ?? {} as Record<string, unknown>;
              const isRunning = (st as { status?: string }).status === 'running';
              if (isRunning) {
                const meta = ((st as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>;
                const curMeta = typeof (meta as { output?: unknown }).output === 'string' ? (meta as { output: string }).output : '';
                const partMetaOut = (part as unknown as { state?: { metadata?: { output?: string } } }).state?.metadata?.output ?? "";
                if (partMetaOut === capRunningStreamOutput(curMeta + delta)) nextPart = part;
                else nextPart = { ...existing, state: { ...st, metadata: { ...meta, output: capRunningStreamOutput(curMeta + delta) } } } as unknown as typeof part;
              } else {
                const cur = typeof (st as { output?: unknown }).output === 'string' ? (st as { output: string }).output : '';
                const partOut = (part as unknown as { state?: { output?: string } }).state?.output ?? "";
                if (partOut === capFinishedStreamOutput(cur + delta)) nextPart = part;
                else nextPart = { ...existing, state: { ...st, output: capFinishedStreamOutput(cur + delta) } } as unknown as typeof part;
              }
            }
          }
          // delta 없이 통째 교체되는 경우(완성된 대용량 출력)도 cap
          if (nextPart === part) nextPart = capSseToolPart(part);
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
      const key = messagesQueryKey(opcodeUrl, sessionID, directory);
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
            const existingKey = messagesQueryKey(opcodeUrl, sessionID, directory);
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
          const key = messagesQueryKey(opcodeUrl, sessionID, directory);
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
            if (existing.type === "reasoning") {
              // delta 전용 이벤트(part 객체 없이 messageID/partID/delta만 옴) — concat해야 라이브로 보인다.
              nextPart = { ...existing, text: capSseTextPart((existing.text ?? "") + delta) } as MessageWithParts["parts"][number];
            } else if (existing.type === "text") {
              nextPart = { ...existing, text: capSseTextPart((existing.text ?? "") + delta) } as MessageWithParts["parts"][number];
            } else if (existing.type === "tool") {
              const st = (existing as unknown as { state: Record<string, unknown> }).state ?? {} as Record<string, unknown>;
              const isRunning = (st as { status?: string }).status === 'running';
              if (isRunning) {
                const meta = ((st as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>;
                const curMeta = typeof (meta as { output?: unknown }).output === 'string' ? (meta as { output: string }).output : '';
                nextPart = { ...existing, state: { ...st, metadata: { ...meta, output: capRunningStreamOutput(curMeta + delta) } } } as unknown as MessageWithParts["parts"][number];
              } else {
                const cur = typeof (st as { output?: unknown }).output === 'string' ? (st as { output: string }).output : '';
                nextPart = { ...existing, state: { ...st, output: capFinishedStreamOutput(cur + delta) } } as unknown as MessageWithParts["parts"][number];
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
          const key = messagesQueryKey(opcodeUrl, sessionID, directory);
          queryClient.setQueryData<MessageListResponse>(key, (old) => old?.filter((m) => m.info.id !== mid) ?? old);
        } else if (t === "session.idle" || t === "session.status") {
          const sid = (p.sessionID as string) ?? (p.sessionId as string);
          if (sid && sid !== sessionID) return;
          if (t === "session.idle") {
            queryClient.invalidateQueries({ queryKey: messagesQueryKey(opcodeUrl, sessionID, directory) });
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

/** 창 최소화·백그라운드 30초 지속 시 대용량 메시지 캐시를 반환한다.
 *  복귀하면 refetch로 다시 채워지므로 UX 손실 없이 힙만 돌려준다. */
export function useReleaseCacheOnHidden(): void {
  const qc = useQueryClient()
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const onVis = () => {
      if (document.hidden) {
        t = setTimeout(() => {
          qc.removeQueries({ queryKey: ['opencode', 'messages'] })
          qc.removeQueries({ queryKey: ['opencode', 'last-message'] })
        }, 30_000)
      } else if (t) { clearTimeout(t); t = null }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => { document.removeEventListener('visibilitychange', onVis); if (t) clearTimeout(t) }
  }, [qc])
}
