import { logger } from '../utils/logger'
import { truncateSessionMessages, deleteSingleChildlessMessage } from './opencode-db'
import { recentSessionMessages, historyReasoningModels, type ReasoningModelStat } from './session-message-db'
import { ensureServerAuth } from './opencode-auth'

interface LoosePart {
  type?: string
  text?: string
  time?: { created?: number }
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

export type TailKind = 'clean' | 'mismatch' | 'cross-model' | 'non-healable'

export interface ReasoningHealResult {
  healed: boolean
  reason?: string
  truncatedMessageId?: string
  /** trailing mismatch stub 단건 삭제 수 */
  stubsRemoved?: number
  /** 오염으로 감지됐으나 자식 때문에 못 지운 stub id (재전송 실패 가능 — 로그 추적용) */
  stubsPending?: string[]
  kind?: TailKind
  healable?: boolean
  /** 히스토리에 reasoning을 남긴 모델들 (cross-model 안내용) */
  models?: ReasoningModelStat[]
  /** 마지막 성공 assistant 턴의 모델 (모델 스위치 안내용 — 자동 원복은 하지 않는다) */
  suggestedModel?: { providerID: string; modelID: string }
}

/** 마지막 user 메시지가 이보다 오래됐으면 남의 턴으로 보고 자르지 않는다. */
const HEAL_FRESHNESS_MS = 10 * 60_000
/**
 * trailing stub 삭제 상한. 유발건이 보통 1건이고, 더 지운다고 해결되는 문제가
 * 아니라서(크로스모델은 경계 truncate가 필요) 2로 고정한다.
 * 점진 확장을 안 하는 이유: mismatch 400은 nonRetryable로 즉시 failed 고정돼
 * attempts가 자동으로 오르지 않으므로, 깊이 카운터가 진행할 수단이 없다.
 */
const MAX_STUB_DELETIONS = 2
/** 뒤쪽 스캔 상한 (성공 턴을 찾을 때까지 최대 거슬러 올라가는 깊이) */
const MAX_SWEEP_SCAN = 20
/**
 * 미완성 턴의 최근 활동猶予. created 나이는 소용없다 — 장시간 턴(로그상 9분+)이
 * 내내 completed=null로 존재한다. 대신 part 시각(스트리밍 중 계속 갱신)을 보고,
 * 최근 활동이 있으면 진행 중으로 간주해 건드리지 않는다.
 */
const PART_ACTIVITY_GRACE_MS = 90_000

/** mismatch 패턴 판별 (chat-queue·proxy와 동일 조건 — 여기서 export해 공유). */
export function isReasoningMismatchText(bodyText: string): boolean {
  const lower = (bodyText ?? '').toLowerCase()
  return (
    lower.includes('encrypted_content') &&
    (lower.includes('reasoning') ||
      lower.includes('security') ||
      lower.includes('not issued') ||
      lower.includes('invalid_request_error'))
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
    lower.includes('rate limit')
  )
}

function errorTextOf(err: unknown): string {
  try {
    return typeof err === 'string' ? err : JSON.stringify(err ?? '')
  } catch {
    return ''
  }
}

/** error 객체에서 HTTP 상태 코드를 꺼낸다 (429 오탐 방지용 — 문자열 매칭 대신). */
function errorStatusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const e = err as Record<string, unknown>
  const data = e.data as Record<string, unknown> | undefined
  // 실측 shape: { name:'APIError', data:{ message, statusCode:400, isRetryable:false, ... } }
  const candidates = [e.status, e.statusCode, e.code, data?.status, data?.statusCode]
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c
    if (typeof c === 'string' && /^\d{3}$/.test(c.trim())) return Number(c.trim())
  }
  return undefined
}

/**
 * 꼬리 상태 분류. security/reasoning 암호문 거부(mismatch)만 healable.
 * 그 외 에러(결제·쿼터·레이트리밋·알 수 없는 provider 오류)는 자르면 사용자
 * 프롬프트만 날리고 재발하므로 절대 자르지 않는다 (healable=false).
 * 판정 순서: mismatch를 먼저 본다 — error 본문에 섞인 곁가지 단어
 * (request id·타임스탬프 등)로 진짜 mismatch가 non-healable로 오분류되는 것 방지.
 */
export function classifyTail(messages: LooseMessage[]): { kind: TailKind; healable: boolean; lastErrorText: string } {
  const last = messages[messages.length - 1]
  if (!last?.info) return { kind: 'clean', healable: false, lastErrorText: '' }
  const lastError = last.info.error

  const errText = errorTextOf(lastError)
  if (lastError && isReasoningMismatchText(errText)) {
    return { kind: 'mismatch', healable: true, lastErrorText: errText }
  }
  if (errorStatusOf(lastError) === 429 || isNonHealableErrorText(errText)) {
    return { kind: 'non-healable', healable: false, lastErrorText: errText }
  }
  if (lastError) return { kind: 'non-healable', healable: false, lastErrorText: errText }
  return { kind: 'clean', healable: false, lastErrorText: '' }
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

/** 마지막 성공 assistant 턴의 모델 — 크로스모델 안내용 (자동 원복은 하지 않는다). */
export function findLastGoodModel(messages: LooseMessage[]): { providerID: string; modelID: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info
    if (!info || info.role !== 'assistant' || info.error) continue
    if (info.time?.completed == null) continue
    if (info.modelID && info.providerID) {
      return { providerID: info.providerID, modelID: info.modelID }
    }
  }
  return undefined
}

/**
 * mismatch 400의 전후 맥락 진단: 히스토리에 reasoning을 남긴 모델이 2개 이상이면
 * 크로스모델 오염이다. 이 경우 마지막 턴 truncate+재시도는 구조적으로 무의미해서
 * (오염이 스위치 지점부터 쌓여 있음) 건너뛰고 안내만 돌려준다.
 */
export async function diagnoseMismatch(
  sessionID: string,
): Promise<{ crossModel: boolean; models: ReasoningModelStat[]; suggestedModel?: { providerID: string; modelID: string } }> {
  const models = (await historyReasoningModels(sessionID)) ?? []
  if (models.length < 2) return { crossModel: false, models }
  const { messages } = await fetchMessageList(sessionID)
  const suggestedModel = messages ? findLastGoodModel(messages) : undefined
  return { crossModel: true, models, suggestedModel }
}

/** opencode 세션 상태 조회 — sweep이 진행 중 턴을 지우지 않게 heal 진입 가드. */
async function isSessionBusy(base: string, sessionID: string, directory: string | undefined): Promise<boolean> {
  try {
    const dirQs = directory ? `?directory=${encodeURIComponent(directory)}` : ''
    const res = await fetch(`${base}/session/status${dirQs}`, {
      headers: ensureServerAuth({}),
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return false // fail-open: 상태 불명확이면 heal을 막지 않는다 (로그 남김)
    const map = (await res.json()) as Record<string, { type?: string }>
    return map[sessionID]?.type === 'busy'
  } catch {
    return false
  }
}

/**
 * 메시지의 마지막 활동 시각. info.created는 턴 시작에 고정되지만 part 시각은
 * 스트리밍 중 계속 갱신되므로, 진행 중 턴 판별에는 이쪽이 정확하다.
 */
function lastActivityOf(msg: LooseMessage): number {
  let latest = msg.info?.time?.created ?? 0
  for (const p of (Array.isArray(msg.parts) ? msg.parts : [])) {
    const t = (p as LoosePart)?.time?.created
    if (typeof t === 'number' && t > latest) latest = t
  }
  return latest
}

/** 진행 중일 수 있는 미완성 턴은 sweep 타겟에서 제외 (최근 part 활동 기준). */
function isSettledIncomplete(msg: LooseMessage, now: number): boolean {
  if (!isIncompleteAssistant(msg)) return false
  return now - lastActivityOf(msg) >= PART_ACTIVITY_GRACE_MS
}

/**
 * NW 중단으로 끝까지 생성되지 못한 assistant 턴 (step-finish 없이 저장됨).
 * info.error가 비어 있어 "정상처럼 보이는" 메시지로 남고, 다음 전송 때
 * provider가 이 reasoning을 replay하면서 새 턴에 400이 기록된다.
 * 실DB 실측: reasoning part는 {type,text,time}만 저장되고 서명 필드 자체가
 * 없으므로(11,714건 전수 확인) 서명 유무로는 판별 불가 — 완료 여부로만 본다.
 * heal은 mismatch 400을 관측한 뒤에만 동작하므로, 그 시점에 미완성인 턴은
 * 진행 중이 아니라 중단된 것이다 (발송 전 busy 체크로도 가드됨).
 */
export function isIncompleteAssistant(msg: LooseMessage): boolean {
  return msg.info?.role === 'assistant' && msg.info.time?.completed == null
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
 * security/reasoning 암호문 불일치로 거부된 턴의 꼬리를 잘라낸다. 2단계:
 *  1. 방금 보낸 user 메시지부터 끝까지 절단 (가드: 텍스트 일치·10분 신선도).
 *     → 이번 전송의 실패 턴 제거.
 *  2. 마지막 성공 턴까지 거슬러 올라가며 mismatch 에러 assistant stub과
 *     미완성 assistant 턴(completed 없음 — NW 중단 잔재)을 자식 없을 때
 *     단건 삭제 (최대 5개, 스캔 20개).
 *     → NW 중단으로 error 없이 남은 턴이 다음 전송까지 거부하던 케이스 대응.
 *     완료된 성공 턴 이전은 provider가 이미 받아들인 히스토리라 손대지 않는다.
 *     user 메시지는 절대 삭제 안 함.
 * 단계별 하나라도 건드렸으면 healed=true (호출자는 동일 요청 1회 재전송).
 * 감지됐으나 자식 때문에 못 지운 stub은 stubsPending에 담아 호출자가 로그로
 * 남긴다 — 재전송 실패 시 원인 추적용 (조용한 거짓 성공 방지).
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

  // 진행 중 턴이 있으면 truncate/sweep이 live 턴을 날릴 수 있어 진입 차단.
  // (busy-tracker는 전역 카운터라 세션 가드가 안 되므로 opencode 상태를 직접 본다)
  if (await isSessionBusy(base, sessionID, directory)) {
    return { healed: false, reason: 'session busy — live turn in progress, heal skipped' }
  }

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

  // 크로스모델 오염(히스토리에 2개 이상 모델의 reasoning)은 마지막 턴을 잘라내도
  // 해결되지 않는다 — truncate+재시도를 건너뛰고 안내만 돌려준다.
  const diag = await diagnoseMismatch(sessionID)
  if (diag.crossModel) {
    const names = diag.models.map((m) => `${m.providerID}/${m.modelID}`).join(', ')
    logger.warn(`Reasoning heal: session ${sessionID} has cross-model reasoning [${names}] — truncate skipped, needs model choice, not cleanup`)
    return {
      healed: false,
      reason: `cross-model reasoning history [${names}] — truncating the last turn cannot help`,
      kind: 'cross-model',
      healable: false,
      models: diag.models,
      suggestedModel: diag.suggestedModel,
    }
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

  // 2단계: 마지막 성공 턴까지 거슬러 올라가며 mismatch/미완성 stub만 단건 삭제.
  // 오염 메시지는 info.error가 비어 있을 수 있어 "성공 턴"으로 오인하고 break하면
  // 안 된다 — completed가 없는 assistant 턴은 중단 잔재로 보고 삭제 대상으로 삼는다.
  const sweep = await sweepPollutedStubs(sessionID)
  if (sweep.pending.length > 0) {
    logger.warn(`Reasoning heal: session ${sessionID} truncated ${truncatedMessageId} but ${sweep.pending.length} polluted stub(s) remain [${sweep.pending.join(',')}]`)
  }

  return { healed: true, truncatedMessageId, stubsRemoved: sweep.removed, stubsPending: sweep.pending }
}

/**
 * 꼬리 sweep 공용 헬퍼: mismatch 에러 stub과 미완성 assistant 턴을
 * 마지막 성공 턴까지 거슬러 올라가며 자식 없을 때 단건 삭제.
 * 완료된 성공 턴 이전은 provider가 받아들인 히스토리라 손대지 않는다.
 */
export async function sweepPollutedStubs(sessionID: string): Promise<{ removed: number; pending: string[] }> {
  let removed = 0
  const pending: string[] = []
  try {
    const tail = await fetchMessageList(sessionID)
    if (tail.messages) {
      const list = tail.messages
      const targets: string[] = []
      let scanned = 0
      const now = Date.now()
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
        if (isIncompleteAssistant(m)) {
          // 최근 활동이 있으면 진행 중 턴으로 보고 제외 (NW 잔재만 삭제).
          // 사용자 cancel 턴은 completed=1이라 여기 오지 않는다 (실DB 239건 전수 확인).
          if (now - lastActivityOf(m) < PART_ACTIVITY_GRACE_MS) {
            logger.info(`Reasoning heal: skipping recently-active incomplete turn ${m.info.id} in session ${sessionID} (presumed live)`)
            continue
          }
          if (m.info.id) targets.push(m.info.id)
          continue
        }
        if (m.info.error) continue // 다른 종류 에러 stub은 유지하고 뒤를 계속 본다
        break // 완료된 성공 턴 → 그 앞은 provider가 받아들인 히스토리라 중단
      }
      if (targets.length > 0) {
        // 최신 것부터 삭제 (자식 검사는 DB에서 실시간 재확인)
        for (const targetId of targets) {
          const deleted = await deleteSingleChildlessMessage(sessionID, targetId)
          if (!deleted) {
            pending.push(targetId)
            logger.warn(`Reasoning heal: kept stub ${targetId} in session ${sessionID} (has children or delete failed) — retry may hit the same 400`)
            continue
          }
          removed++
          logger.warn(`Reasoning heal: removed mismatch stub ${targetId} in session ${sessionID}`)
        }
      }
    }
  } catch (e) {
    logger.warn(`Reasoning heal stub sweep threw for session ${sessionID}:`, e)
  }
  return { removed, pending }
}

/** 마지막 user 메시지를 찾아 그 지점부터 잘라낸다 (수동 endpoint용 — 텍스트 대조 없음). */
export async function truncateFromLastUser(
  sessionID: string,
): Promise<{ truncatedMessageId: string; messagesRemoved: number } | { reason: string }> {
  const { messages, reason } = await fetchMessageList(sessionID)
  if (!messages) return { reason: reason ?? 'no messages' }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.info?.role === 'user' && m.info.id) {
      try {
        const result = await truncateSessionMessages(sessionID, m.info.id)
        if (!result) return { reason: 'truncate failed' }
        return { truncatedMessageId: m.info.id, messagesRemoved: result.messagesRemoved }
      } catch (e) {
        return { reason: `truncate threw: ${(e as Error)?.message ?? e}` }
      }
    }
  }
  return { reason: 'no user to truncate from' }
}

/**
 * 수동 백업용 narrow 정리: 꼬리가 mismatch(암호문 거부)일 때만 마지막 user부터
 * 잘라내고 sweep한다. 결제·쿼터 등 non-healable이나 clean이면 손대지 않는다.
 * 자동 복구가 실패했을 때의 비상 출구 — 프론트 버튼 없음, API 직접 호출용.
 */
export async function healMismatchTailManual(
  sessionID: string,
): Promise<ReasoningHealResult> {
  const { messages, reason } = await fetchMessageList(sessionID)
  if (!messages || messages.length === 0) return { healed: false, reason: reason ?? 'no messages' }
  const { kind, healable } = classifyTail(messages)
  if (kind !== 'mismatch' || !healable) {
    return { healed: false, reason: kind === 'clean' ? 'history clean' : `not a reasoning-mismatch tail (${kind}) — manual cleanup refused`, kind, healable }
  }
  const trunc = await truncateFromLastUser(sessionID)
  if ('reason' in trunc) return { healed: false, reason: trunc.reason, kind, healable }
  logger.warn(`Manual mismatch heal for session ${sessionID}: truncated from user ${trunc.truncatedMessageId} (removed ${trunc.messagesRemoved} messages)`)
  const sweep = await sweepPollutedStubs(sessionID)
  return { healed: true, truncatedMessageId: trunc.truncatedMessageId, stubsRemoved: sweep.removed, stubsPending: sweep.pending, kind, healable: true }
}
