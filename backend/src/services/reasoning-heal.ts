import { logger } from '../utils/logger'
import { truncateSessionMessages, deleteSingleChildlessMessage } from './opencode-db'
import { recentSessionMessages } from './session-message-db'

interface LoosePart {
  type?: string
  text?: string
}

interface LooseMessage {
  info?: {
    id?: string
    role?: string
    time?: { created?: number; completed?: number }
    error?: unknown
    finish?: string
    modelID?: string
    providerID?: string
  }
  parts?: LoosePart[]
}

export type TailKind = 'clean' | 'mismatch' | 'aborted' | 'ghost' | 'empty' | 'non-healable'

export interface ReasoningHealResult {
  healed: boolean
  reason?: string
  truncatedMessageId?: string
  /** trailing mismatch stub 단건 삭제 수 */
  stubsRemoved?: number
  /** 꼬리 상태 분류 */
  kind?: TailKind
  /** truncate 대상이 아닌 에러(결제·쿼터·권한 등)면 false — 사용자 프롬프트를 지우지 않는다 */
  healable?: boolean
  /** 마지막 성공 assistant 턴의 모델 (모델 교체 오염 시 원래 모델 복귀용) */
  suggestedModel?: { providerID: string; modelID: string }
}

/** 마지막 user 메시지가 이보다 오래됐으면 남의 턴으로 보고 자르지 않는다. */
const HEAL_FRESHNESS_MS = 10 * 60_000
/** trailing stub 삭제 상한 (연쇄 삭제 폭주 방지) */
const MAX_STUB_DELETIONS = 5
/** 뒤쪽 스캔 상한 (성공 턴을 찾을 때까지 최대 거슬러 올라가는 깊이) */
const MAX_SWEEP_SCAN = 20

/** mismatch 패턴 판별 (chat-queue·proxy와 동일 조건 — 여기서 export해 공유). */
export function isReasoningMismatchText(bodyText: string): boolean {
  const lower = (bodyText ?? '').toLowerCase()
  return (
    lower.includes('encrypted_content') &&
    (lower.includes('reasoning') || lower.includes('not issued') || lower.includes('invalid_request_error'))
  )
}

/** 잘라내도 소용없고 프롬프트만 날리는 에러 (결제·쿼터·인증·레이트리밋). */
export function isNonHealableErrorText(bodyText: string): boolean {
  const lower = (bodyText ?? '').toLowerCase()
  return (
    lower.includes('quota') ||
    lower.includes('billing') ||
    lower.includes('payment') ||
    lower.includes('insufficient') ||
    lower.includes('freeusagelimit') ||
    lower.includes('subscriptionusagelimit') ||
    lower.includes('add credits') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid_api_key') ||
    lower.includes('authentication') ||
    lower.includes('rate_limit') ||
    lower.includes('rate limit') ||
    lower.includes('429')
  )
}

function errorTextOf(err: unknown): string {
  try {
    return typeof err === 'string' ? err : JSON.stringify(err ?? '')
  } catch {
    return ''
  }
}

/**
 * 꼬리 상태 분류. truncate해도 되는 것(healable)은 딱 4종:
 * mismatch(모델 교체 reasoning 오염) · aborted(중단) · ghost(미완성 빈 응답) · empty(LLM 빈 응답).
 * 그 외 에러(결제·쿼터·레이트리밋·알 수 없는 provider 오류)는 자르면 사용자 프롬프트만
 * 날리고 재발하므로 절대 자르지 않는다 (healable=false).
 */
export function classifyTail(messages: LooseMessage[]): { kind: TailKind; healable: boolean; lastErrorText: string } {
  const last = messages[messages.length - 1]
  if (!last?.info) return { kind: 'clean', healable: false, lastErrorText: '' }
  const lastRole = last.info.role
  const lastError = last.info.error
  const lastFinish = last.info.finish
  const lastCompleted = last.info.time?.completed
  const lastParts = Array.isArray(last.parts) ? last.parts : []

  const errText = errorTextOf(lastError)
  if (isNonHealableErrorText(errText)) {
    return { kind: 'non-healable', healable: false, lastErrorText: errText }
  }
  if (lastError && isReasoningMismatchText(errText)) {
    return { kind: 'mismatch', healable: true, lastErrorText: errText }
  }
  const isAborted =
    lastFinish === 'aborted' ||
    (typeof lastError === 'object' &&
      lastError !== null &&
      String((lastError as { name?: string })?.name ?? '').includes('Aborted'))
  if (isAborted) return { kind: 'aborted', healable: true, lastErrorText: errText }
  const isGhost = lastRole === 'assistant' && !lastCompleted && lastParts.length === 0
  if (isGhost) return { kind: 'ghost', healable: true, lastErrorText: errText }
  const isEmptyResponse = (() => {
    try {
      const txt = errText + JSON.stringify(last.parts ?? '')
      const lower = txt.toLowerCase()
      return lower.includes('llm response was empty') || (lower.includes('empty') && lower.includes('llm'))
    } catch {
      return false
    }
  })()
  if (isEmptyResponse) return { kind: 'empty', healable: true, lastErrorText: errText }
  if (lastError) return { kind: 'non-healable', healable: false, lastErrorText: errText }
  return { kind: 'clean', healable: false, lastErrorText: '' }
}

/** 마지막 성공 assistant 턴의 모델 — 모델 교체 오염 시 원래 모델 복귀용. */
export function findLastGoodModel(messages: LooseMessage[]): { providerID: string; modelID: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info
    if (!info || info.role !== 'assistant' || info.error) continue
    if (info.modelID && info.providerID) {
      return { providerID: info.providerID, modelID: info.modelID }
    }
  }
  return undefined
}

function stripInjectedBlocks(text: string): string {
  let t = text
  // run-context: [run-context] ... [/run-context] or <run-context> ...
  t = t.replace(/\[run-context\][\s\S]*?\[\/run-context\]\n*/gi, '')
  t = t.replace(/<run-context>[\s\S]*?<\/run-context>\n*/gi, '')
  t = t.replace(/<memory-recall>[\s\S]*?<\/memory-recall>\n*/gi, '')
  t = t.replace(/<skill-memory-check>[\s\S]*?<\/skill-memory-check>\n*/gi, '')
  return t.trim()
}

function userTextOf(msg: LooseMessage): string {
  const parts = Array.isArray(msg.parts) ? msg.parts : []
  return parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string' && p.text.trim())
    .map((p) => p.text as string)
    .join('\n')
    .trim()
}

function isMismatchError(msg: LooseMessage): boolean {
  const err = msg.info?.error
  if (!err) return false
  try {
    return isReasoningMismatchText(typeof err === 'string' ? err : JSON.stringify(err))
  } catch {
    return false
  }
}

async function fetchMessageList(
  sessionID: string,
): Promise<{ messages?: LooseMessage[]; reason?: string }> {
  // 꼬리 복구에 필요한 건 끝쪽 최대 20개뿐 — opencode HTTP 목록 API는
  // 페이지네이션이 없어 전체를 불러오므로 DB에서 tail만 읽는다.
  try {
    const result = await recentSessionMessages(sessionID, MAX_SWEEP_SCAN)
    if (!result) return { reason: 'message store unavailable' }
    if (!Array.isArray(result.messages) || result.messages.length === 0) return { reason: 'no messages' }
    return { messages: result.messages as unknown as LooseMessage[] }
  } catch (e) {
    return { reason: `tail read failed: ${(e as Error)?.message ?? e}` }
  }
}

/**
 * reasoning 암호문 불일치로 거부된 턴의 꼬리를 잘라낸다. 2단계:
 *  1. 방금 보낸 user 메시지부터 끝까지 절단 (기존 가드: 텍스트 일치·10분 신선도).
 *     → 이번 전송의 실패 턴 제거.
 *  2. 마지막 성공 턴까지 거슬러 올라가며 mismatch 에러 assistant stub만
 *     자식 없을 때 단건 삭제 (최대 5개, 스캔 20개).
 *     → 이전 실패 턴의 reasoning 찌꺼기(예: 중단 시 남긴 null 암호문)가
 *     그 뒤 모든 전송을 거부하던 문제 대응. 성공한 턴 이전은 provider가
 *     이미 받아들인 히스토리라 손대지 않는다. user 메시지는 절대 삭제 안 함.
 * 단계별 하나라도 건드렸으면 healed=true (호출자는 동일 요청 1회 재전송).
 * NOTE: opencode-db는 정적 import한다. 동적 import는 bun 단일 exe 번들에서
 * 실패할 수 있고, try/catch가 삼켜 heal이 조용히 죽는다 (13:47 장애 교훈).
 * vitest에서는 vi.mock으로 가로채므로 node 호환에 문제없다.
 */
export async function healReasoningTail(
  base: string,
  sessionID: string,
  directory: string | undefined,
  candidates: string[],
  opts?: { force?: boolean },
): Promise<ReasoningHealResult> {
  const texts = candidates.map((t) => (t ?? '').trim()).filter((t) => t.length > 0)
  if (texts.length === 0) return { healed: false, reason: 'empty expected text' }

  const { messages, reason } = await fetchMessageList(sessionID)
  if (!messages) return { healed: false, reason }

  let lastUser: LooseMessage | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.info?.role === 'user') {
      lastUser = messages[i]
      break
    }
  }
  const cursorId = lastUser?.info?.id
  if (!lastUser || !cursorId) return { healed: false, reason: 'no user message' }

  const created = lastUser.info?.time?.created ?? 0
  // 채팅 발송 시점의 명시적 복구는 force로 신선도 가드를 우회한다.
  // 에러 꼬리가 있으면 그 뒤 모든 전송이 400으로 거부돼 수십번 재시도해도
  // 영원히 먹통이 되므로, 사용자가 새로 보내려는 순간에는 오래된 턴이라도 잘라낸다.
  if (!opts?.force && (!created || Date.now() - created > HEAL_FRESHNESS_MS)) {
    return { healed: false, reason: 'last user message too old' }
  }

  const stored = userTextOf(lastUser)
  const strippedStored = stripInjectedBlocks(stored)
  const matched = texts.some((t) => {
    const strippedT = stripInjectedBlocks(t)
    return stored === t || stored.endsWith(t) || strippedStored === strippedT || strippedStored.endsWith(strippedT) || strippedStored.includes(strippedT) || strippedT.includes(strippedStored)
  })
  if (!matched) {
    return { healed: false, reason: `text mismatch (not our turn?) stored=${stored.slice(0,60)}...` }
  }

  let truncatedMessageId: string | undefined
  try {
    const result = await truncateSessionMessages(sessionID, cursorId)
    if (!result) return { healed: false, reason: 'truncate failed' }
    truncatedMessageId = cursorId
    logger.warn(
      `Healed reasoning mismatch for session ${sessionID}: truncated from user message ${cursorId} (removed ${result.messagesRemoved} messages, ${result.partsRemoved} parts)`,
    )
  } catch (e) {
    return { healed: false, reason: `truncate threw: ${(e as Error)?.message ?? e}` }
  }

  // 2단계: 마지막 성공 턴까지 거슬러 올라가며 mismatch stub만 단건 삭제.
  // (이전 실패 턴의 reasoning 찌꺼기가 다음 전송까지 거부하던 케이스.
  //  user 메시지와 다른 종류 에러 stub은 유지하고 건너뛴다.)
  let stubsRemoved = 0
  try {
    const tail = await fetchMessageList(sessionID)
    if (tail.messages) {
      const list = tail.messages
      const targets: string[] = []
      let scanned = 0
      for (let i = list.length - 1; i >= 0 && targets.length < MAX_STUB_DELETIONS && scanned < MAX_SWEEP_SCAN; i--) {
        const m = list[i]
        scanned++
        if (!m || !m.info) break
        if (m.info.role === 'user') continue
        if (m.info.role !== 'assistant') break
        if (isMismatchError(m)) {
          if (m.info.id) targets.push(m.info.id)
          continue
        }
        if (m.info.error) continue // 다른 종류 에러 stub은 유지하고 뒤를 계속 본다
        break // 에러 없는 성공 턴 → 그 앞은 provider가 받아들인 히스토리라 중단
      }
      if (targets.length > 0) {
        const { deleteSingleChildlessMessage } = await import('./opencode-db')
        // 최신 것부터 삭제 (자식 검사는 DB에서 실시간 재확인)
        for (const targetId of targets) {
          const deleted = await deleteSingleChildlessMessage(sessionID, targetId)
          if (!deleted) {
            logger.warn(`Reasoning heal: kept stub ${targetId} (has children or delete failed)`)
            continue
          }
          stubsRemoved++
          logger.warn(`Reasoning heal: removed mismatch stub ${targetId} in session ${sessionID}`)
        }
      }
    }
  } catch (e) {
    logger.warn(`Reasoning heal stub sweep threw for session ${sessionID}:`, e)
  }

  return { healed: true, truncatedMessageId, stubsRemoved }
}

/**
 * 발송 직전 선제 클렌징: healable 꼬리(mismatch·aborted·ghost·empty)만 잘라낸다.
 * 큐에 정상적으로 들어가도 응답 없이 종료되던 케이스 방지.
 * 결제·쿼터·레이트리밋·기타 provider 오류는 프롬프트 보존을 위해 절대 자르지 않는다.
 * candidates 없이 동작하므로 발송 전 항상 호출해도 안전 (대상 아니면 no-op).
 */
export async function healAbnormalTailIfNeeded(
  base: string,
  sessionID: string,
  directory: string | undefined,
  opts?: { force?: boolean; allow?: TailKind[] },
): Promise<ReasoningHealResult> {
  const { messages, reason } = await fetchMessageList(sessionID)
  if (!messages || messages.length === 0) return { healed: false, reason: reason ?? 'no messages' }

  const last = messages[messages.length - 1]
  if (!last?.info) return { healed: false, reason: 'no last info' }

  // 꼬리 분류: healable 4종(mismatch·aborted·ghost·empty)만 자른다.
  // 결제·쿼터·레이트리밋·기타 provider 오류는 자르면 프롬프트만 날리고 재발하므로 손대지 않는다.
  const { kind, healable } = classifyTail(messages)
  const suggestedModel = findLastGoodModel(messages)
  if (kind === 'clean') return { healed: false, reason: 'history clean', kind, healable: false, suggestedModel }
  if (!healable) {
    return { healed: false, reason: `non-healable error (${kind}) — truncate skipped to preserve your prompt`, kind, healable: false, suggestedModel }
  }
  if (opts?.allow && !opts.allow.includes(kind)) {
    return {
      healed: false,
      reason: `tail is ${kind} — auto cleanup skipped (auto-heals only: ${opts.allow.join(', ')})`,
      kind,
      healable,
      suggestedModel,
    }
  }
  const lastRole = last.info.role

  // 마지막 user를 찾아 그 user부터 잘라낸다 — 실패한 턴 전체 제거
  let lastUser: LooseMessage | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.info?.role === 'user') { lastUser = messages[i]; break }
  }
  if (!lastUser?.info?.id) return { healed: false, reason: 'no user to truncate from' }

  const created = lastUser.info?.time?.created ?? 0
  // 발송 직전 선제 클렌징(force)에서는 신선도 무관하게 비정상 꼬리를 잘라낸다.
  // 채팅 기본 동작: 보낼 때 error/aborted/ghost/mismatch 상태면 삭제하고 깨끗한 히스토리로 시작.
  if (!opts?.force && (!created || Date.now() - created > HEAL_FRESHNESS_MS)) {
    return { healed: false, reason: 'abnormal but last user too old' }
  }

  try {
    const result = await truncateSessionMessages(sessionID, lastUser.info.id as string)
    if (!result) return { healed: false, reason: 'truncate failed' }
    logger.warn(`Pre-dispatch abnormal heal for session ${sessionID}: last ${lastRole} was abnormal (${kind}), truncated from user ${lastUser.info.id} (removed ${result.messagesRemoved} messages)`)
    // ghost/mismatch stub도 같이 쓸어냄 (위 healReasoningTail의 2단계와 유사하지만 여기선 더 넓게)
    try {
      const tail = await fetchMessageList(sessionID)
      if (tail.messages) {
        for (let i = tail.messages.length - 1; i >= 0; i--) {
          const m = tail.messages[i]
          if (!m?.info || m.info.role !== 'assistant') break
          if (m.info.error && m.info.id) {
            const deleted = await deleteSingleChildlessMessage(sessionID, m.info.id as string)
            if (deleted) logger.warn(`Pre-dispatch heal: removed abnormal stub ${m.info.id}`)
            else break
          } else if (!m.info.error) break
        }
      }
    } catch {}
    return { healed: true, reason: `abnormal ${lastRole} truncated`, truncatedMessageId: lastUser.info.id as string, kind, healable: true, suggestedModel }
  } catch (e) {
    return { healed: false, reason: `truncate threw: ${(e as Error)?.message ?? e}`, kind, healable: true, suggestedModel }
  }
}
