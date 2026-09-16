import { logger } from '../utils/logger'
import { truncateSessionMessages, deleteSingleChildlessMessage, stripReasoningParts, stripAllReasoningParts } from './opencode-db'
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
  /** cross-model strip으로 제거한 reasoning part 수 (메시지는 보존) */
  strippedParts?: number
  strippedMessages?: number
  /** 동일모델 stale 대응 strip-all로 제거한 reasoning part 수 (keep 무관) */
  strippedAllParts?: number
  strippedAllMessages?: number
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

/** mismatch 에러 턴 판별 — 발송 전후 꼬리 검사에서 공유한다 (export). */
export function isMismatchError(msg: LooseMessage): boolean {
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
 * 크로스모델 오염이다. 과거 턴의 외국 reasoning은 strip으로 벗겨낸 뒤 실패 턴
 * 제거·재시도로 이어간다 (strip할 keep을 못 정하면 안내만 돌려준다).
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

/** 보내려는 모델. strip keep의 유일한 1순위 소스다. */
export interface OutgoingModel {
  providerID: string
  modelID: string
}

/**
 * unknown 입력을 OutgoingModel로 정규화. 허용 형태:
 * - { providerID, modelID } 객체 (큐·프론트·opencode body)
 * - "providerID/modelID" 문자열
 * 그 외(빈 문자열·필드 누락 등)는 undefined — 호출자는 폴백/스킵으로 처리.
 */
export function asOutgoingModel(v: unknown): OutgoingModel | undefined {
  if (typeof v === 'string') {
    const slash = v.indexOf('/')
    if (slash <= 0 || slash >= v.length - 1) return undefined
    const providerID = v.slice(0, slash).trim()
    const modelID = v.slice(slash + 1).trim()
    if (!providerID || !modelID) return undefined
    return { providerID, modelID }
  }
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>
    // opencode 세션 모델은 id 필드명을 쓴다 ({providerID, id}).
    const providerID = o.providerID
    const modelID = o.modelID ?? o.id
    if (typeof providerID === 'string' && providerID.trim() && typeof modelID === 'string' && modelID.trim()) {
      return { providerID: providerID.trim(), modelID: modelID.trim() }
    }
  }
  return undefined
}

/** 세션의 현재 모델 조회 (strip keep 폴백 — 실패하면 undefined). */
async function getSessionModel(
  base: string,
  sessionID: string,
  directory: string | undefined,
): Promise<{ providerID: string; modelID: string } | undefined> {
  try {
    const dirQs = directory ? `?directory=${encodeURIComponent(directory)}` : ''
    const res = await fetch(`${base}/session/${sessionID}${dirQs}`, {
      headers: ensureServerAuth({}),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return undefined
    const data = (await res.json()) as { model?: unknown }
    return asOutgoingModel(data?.model)
  } catch {
    return undefined
  }
}

/** opencode 세션 상태 조회 — sweep이 진행 중 턴을 지우지 않게 heal 진입 가드. */
async function isSessionBusy(base: string, sessionID: string, directory: string | undefined): Promise<boolean> {
  try {
    const dirQs = directory ? `?directory=${encodeURIComponent(directory)}` : ''
    const res = await fetch(`${base}/session/status${dirQs}`, {
      headers: ensureServerAuth({}),
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) {
      logger.warn(`Session busy check for ${sessionID}: status HTTP ${res.status} — fail-open, heal proceeds`)
      return false // fail-open: 상태 불명확이면 heal을 막지 않는다
    }
    const map = (await res.json()) as Record<string, { type?: string }>
    return map[sessionID]?.type === 'busy'
  } catch (e) {
    logger.warn(`Session busy check threw for ${sessionID} — fail-open, heal proceeds:`, e)
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
 *     단건 삭제 (최대 2개, 스캔 20개).
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
  opts?: { force?: boolean; outgoingModel?: OutgoingModel },
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
  // 해결되지 않는다 — 과거 턴의 외국 reasoning part를 벗겨낸 뒤(truncate 아님)
  // 실패 턴 제거·재시도로 이어간다. strip이 0건이면 안내만 돌려준다.
  const diag = await diagnoseMismatch(sessionID)
  let strippedParts = 0
  let strippedMessages = 0
  if (diag.crossModel) {
    const names = diag.models.map((m) => `${m.providerID}/${m.modelID}`).join(', ')
    // keep은 보내려는 모델이 유일한 1순위다. suggestedModel(마지막 성공 턴의
    // 모델)은 keep 소스에서 제외한다 — 모델을 바꾼 직후에는 둘 다 값이 있어도
    // 서로 다르고, 그때 suggested를 쓰면 정확히 반대를 지운다.
    // 둘 다 없으면 strip 없이 안내로 빠진다 (반대로 지우는 것보다 안전).
    const target = opts?.outgoingModel ?? (await getSessionModel(base, sessionID, directory))
    if (!target) {
      logger.warn(`Reasoning heal: session ${sessionID} has cross-model reasoning [${names}] but current model unknown — truncate skipped, needs model choice`)
      return {
        healed: false,
        reason: `cross-model reasoning history [${names}] — truncating the last turn cannot help`,
        kind: 'cross-model',
        healable: false,
        models: diag.models,
        suggestedModel: diag.suggestedModel,
      }
    }
    try {
      const strip = await stripReasoningParts(sessionID, target)
      strippedParts = strip?.partsRemoved ?? 0
      strippedMessages = strip?.messagesAffected ?? 0
    } catch (e) {
      return { healed: false, reason: `strip threw: ${(e as Error)?.message ?? e}`, kind: 'cross-model', healable: false, models: diag.models, suggestedModel: diag.suggestedModel }
    }
    if (strippedParts === 0) {
      logger.warn(`Reasoning heal: session ${sessionID} cross-model [${names}] but nothing to strip — needs model choice, not cleanup`)
      return {
        healed: false,
        reason: `cross-model reasoning history [${names}] — truncating the last turn cannot help`,
        kind: 'cross-model',
        healable: false,
        models: diag.models,
        suggestedModel: diag.suggestedModel,
      }
    }
    logger.warn(`Reasoning heal: session ${sessionID} stripped ${strippedParts} foreign reasoning part(s) in ${strippedMessages} message(s), keeping ${target.providerID}/${target.modelID} — continuing to truncate the failed turn`)
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

  return { healed: true, truncatedMessageId, stubsRemoved: sweep.removed, stubsPending: sweep.pending, strippedParts, strippedMessages, kind: diag.crossModel ? 'cross-model' : 'mismatch', healable: true, models: diag.models, suggestedModel: diag.suggestedModel }
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
          if (!isSettledIncomplete(m, now)) {
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

export interface PreSendStripResult {
  checked: boolean
  strippedParts: number
  strippedMessages: number
  /** 동일모델 stale 폴백(strip-all) 제거 수 — keep 없이도 동작한다 */
  strippedAllParts: number
  strippedAllMessages: number
  stubsRemoved: number
  stubsPending: string[]
  /** 발송 전 꼬리 20개의 메시지 id — 발송 후 fresh 판별용(knownIds). */
  tailIds: string[]
  keep?: OutgoingModel
  reason?: string
}

/** pre-send 발동 탐색 폭. 마지막 메시지가 user여도 그 앞 mismatch를 찾는다. */
const PRE_SEND_SCAN = 20

/**
 * strip-all 재발동 방지: 발동한 stub id를 세션별 집합으로 기억해 같은 stub에는
 * 1회만 발동한다. 자식 때문에 sweep이 못 지운 stub이 꼬리에 남으면 매 발송마다
 * strip-all이 돌아 정상 reasoning까지 벗겨지므로, 세션당 총 발동 횟수에도
 * 상한을 둔다 (실패 반복마다 새 stub이 생겨 집합만으로는 제한이 실효되지 않는다).
 */
const stripAllFiredStubs = new Map<string, Set<string>>()
const stripAllFireCounts = new Map<string, number>()
const MAX_STRIP_ALL_MARKS = 500
const MAX_STRIP_ALL_FIRES_PER_SESSION = 3
/** 테스트용 리셋 */
export function clearStripAllMarks(): void {
  stripAllFiredStubs.clear()
  stripAllFireCounts.clear()
}
function stripAllAlreadyFired(sessionID: string, hitId: string | undefined): boolean {
  if (!hitId) return false
  if ((stripAllFireCounts.get(sessionID) ?? 0) >= MAX_STRIP_ALL_FIRES_PER_SESSION) return true
  return stripAllFiredStubs.get(sessionID)?.has(hitId) ?? false
}
function markStripAllFired(sessionID: string, hitId: string | undefined): void {
  stripAllFireCounts.set(sessionID, (stripAllFireCounts.get(sessionID) ?? 0) + 1)
  if (!hitId) return
  let set = stripAllFiredStubs.get(sessionID)
  if (!set) {
    set = new Set()
    stripAllFiredStubs.set(sessionID, set)
  }
  set.add(hitId)
  while (stripAllFiredStubs.size > MAX_STRIP_ALL_MARKS) {
    const oldest = stripAllFiredStubs.keys().next()
    if (oldest.done) break
    const key = oldest.value
    stripAllFiredStubs.delete(key)
    stripAllFireCounts.delete(key)
  }
}

/**
  * 발송 직전 안전 클렌징: 최근 꼬리(PRE_SEND_SCAN개) 안에 mismatch 에러가 있을
  * 때만 외국 reasoning strip + 자식 없는 stub sweep을 한다. 메시지 truncate는
  * 절대 하지 않는다 — 아직 보내지 않은 이번 텍스트와 무관한 과거 user를
  * 지우면 안 되기 때문이다. 세션이 busy면 strip/sweep 전부 건너뛴다
  * (cutoff가 최신 user 기준이라 동시 전송 중 스트리밍 턴이 strip 대상이 된다).
 *
 * keep은 outgoing(보내려는 모델)만 쓴다. 세션 조회 폴백은 여기서 제외한다 —
 * UI에서 모델을 바꾼 직후 세션 기록이 아직 이전 모델이면 keep이 반대로 잡혀
 * 정상 전송을 깨뜨린다 (자동 경로는 실패 뒤라 폴백이 틀려도 재시도 한 번
 * 손해지만, pre-send는 정상 전송을 깨뜨리는 위치다). outgoing이 없으면
 * sweep만 한다.
 *
 * 외국 strip이 0건이면 strip-all 폴백이 돈다: 동일모델 stale(오래된 암호문
 * 전체가 무효화된 경우)은 외국 strip으로 1건도 안 지워지는데, 꼬리 mismatch
 * stub이 있다는 건 히스토리가 이미 거부된 상태라는 증거라 keep 없이
 * 지워도 반대를 지울 위험이 없다. 최신 턴은 양쪽 모두 보존한다
 * (interleaved thinking 보호 — 최신 턴 오염은 발송 후 단계에서 처리).
 *
 * 왜 필요한가: opencode가 provider 400을 HTTP 200 + 메시지 error로 저장하는
 * 경로가 있다 (실측: 큐에서 Flushed됐는데 400 메시지가 쌓임). 응답-기준 heal만
 * 있으면 이 경우 heal이 영원히 발동하지 않아, 다음 전송이 같은 400을 맞는다.
 * 발송 전에 꼬리를 직접 보고 strip해 두면 다음 전송이 깨끗한 히스토리에서
 * 시작한다. 호출자는 strippedParts/stubsRemoved > 0이면 인스턴스 reload 후
 * 전송한다 (opencode 메모리 캐시 무효화).
 */
export async function preSendStripIfMismatch(
  base: string,
  sessionID: string,
  directory: string | undefined,
  outgoing?: OutgoingModel,
): Promise<PreSendStripResult> {
  const empty = (reason: string, tailIds: string[] = []): PreSendStripResult => ({
    checked: true, strippedParts: 0, strippedMessages: 0, strippedAllParts: 0, strippedAllMessages: 0,
    stubsRemoved: 0, stubsPending: [], tailIds, reason,
  })
  const { messages, reason } = await fetchMessageList(sessionID)
  if (!messages || messages.length === 0) {
    return { checked: false, strippedParts: 0, strippedMessages: 0, strippedAllParts: 0, strippedAllMessages: 0, stubsRemoved: 0, stubsPending: [], tailIds: [], reason: reason ?? 'no messages' }
  }
  const tailIds = messages
    .slice(-PRE_SEND_SCAN)
    .map((m) => m?.info?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  // 마지막 메시지가 user여도 그 앞 mismatch를 찾는다 — stub 뒤에 새 전송이
  // 얹히거나 자식 때문에 sweep이 못 지운 오염이 그대로 남을 수 있다.
  const hit = [...messages].slice(-PRE_SEND_SCAN).reverse().find((m) => m && isMismatchError(m))
  if (!hit) return empty('no mismatch in recent tail', tailIds)
  // busy면 strip/sweep 전부 건너뛴다. cutoff가 "최신 user 이전"이라 동시 전송
  // 중이면 스트리밍 턴의 reasoning이 strip 대상에 들어가 live 턴이 깨진다.
  // pre-send는 발송 직전이라 별도 게이트가 없으므로 여기서 직접 확인한다
  // (퀴 모드·프록시 직접 경로는 busy 판정을 우회한다).
  if (await isSessionBusy(base, sessionID, directory)) {
    logger.warn(`Pre-send strip: session ${sessionID} busy — cleanup skipped`)
    return {
      checked: true, strippedParts: 0, strippedMessages: 0, strippedAllParts: 0, strippedAllMessages: 0,
      stubsRemoved: 0, stubsPending: [], tailIds,
      reason: 'session busy — pre-send cleanup skipped',
    }
  }
  // keep은 outgoing만. 세션 조회 폴백 없음 (위 docstring).
  const keep = outgoing
  let strippedParts = 0
  let strippedMessages = 0
  let strippedAllParts = 0
  let strippedAllMessages = 0
  if (keep) {
    try {
      const strip = await stripReasoningParts(sessionID, keep)
      strippedParts = strip?.partsRemoved ?? 0
      strippedMessages = strip?.messagesAffected ?? 0
    } catch (e) {
      return { checked: true, strippedParts: 0, strippedMessages: 0, strippedAllParts: 0, strippedAllMessages: 0, stubsRemoved: 0, stubsPending: [], tailIds, reason: `strip threw: ${(e as Error)?.message ?? e}` }
    }
  }
  // 동일모델 stale 폴백: 외국 strip이 0건이면 cutoff 이전 reasoning 전체를
  // 모델 무관하게 제거한다. mismatch stub이 꼬리에 있다는 건 이미 거부된
  // 히스토리라는 증거라 keep 유무와 무관하게 안전하다.
  // 단 같은 stub에는 1회만 발동한다 — 자식 때문에 stub이 남으면 매 발송마다
  // strip-all이 돌아 새로 쌓인 정상 reasoning까지 벗겨진다.
  const hitId = typeof hit.info?.id === 'string' && hit.info.id.length > 0 ? hit.info.id : undefined
  const stripAllDone = stripAllAlreadyFired(sessionID, hitId)
  if (strippedParts === 0 && !stripAllDone) {
    try {
      const stripAll = await stripAllReasoningParts(sessionID)
      strippedAllParts = stripAll?.partsRemoved ?? 0
      strippedAllMessages = stripAll?.messagesAffected ?? 0
      markStripAllFired(sessionID, hitId)
      if (strippedAllParts > 0) {
        logger.warn(`Pre-send strip-all for session ${sessionID}: removed ${strippedAllParts} stale reasoning part(s) in ${strippedAllMessages} message(s) (foreign strip 0 — same-model stale history suspected)`)
      }
    } catch (e) {
      logger.warn(`Pre-send strip-all threw for session ${sessionID}:`, e)
    }
  } else if (strippedParts === 0 && stripAllDone) {
    logger.info(`Pre-send strip-all skipped for session ${sessionID}: already fired (stub ${hitId ?? 'unknown'})`)
  }
  const sweep = await sweepPollutedStubs(sessionID)
  const acted = strippedParts > 0 || strippedAllParts > 0
  return {
    checked: true, strippedParts, strippedMessages, strippedAllParts, strippedAllMessages,
    stubsRemoved: sweep.removed, stubsPending: sweep.pending, tailIds,
    ...(keep ? { keep } : {}),
    reason: acted ? undefined : (keep ? 'foreign strip 0, strip-all 0 — sweep only' : 'keep unknown, strip-all 0 — sweep only'),
  }
}

/**
 * 방금 보낸 턴이 provider mismatch로 저장됐는지 판별한다.
 * opencode가 HTTP 200으로 응답해도 메시지 error로 400이 남을 수 있어,
 * 발송 성공으로 단정하지 않고 꼬리를 한 번 더 본다. sinceTs(발송 시작)보다
 * 먼저 생긴 오래된 stub은 이번 턴과 무관하므로 제외한다.
 */
export function findFreshMismatch(
  messages: LooseMessage[],
  sinceTs: number,
): LooseMessage | undefined {
  const SKEW_MS = 10_000
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || !isMismatchError(m)) continue
    const created = m.info?.time?.created ?? 0
    if (created >= sinceTs - SKEW_MS) return m
  }
  return undefined
}

/**
 * 발송 전 꼬리 id 집합에 없던 mismatch를 찾는다. 시계 비교가 아니라 존재
 * 비교라 created 오차·SKEW 방향 문제에서 자유롭다. id 없는 메시지는
 * 이번 턴 산물로 보고 fresh로 취급한다 (DB 메시지는 항상 id가 주입된다).
 */
export function findNewMismatch(
  messages: LooseMessage[],
  knownIds: Set<string>,
): LooseMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || !isMismatchError(m)) continue
    const id = m.info?.id
    if (typeof id !== 'string' || id.length === 0 || !knownIds.has(id)) return m
  }
  return undefined
}

/** 마지막 user 메시지를 찾아 그 지점부터 잘라낸다 (수동 endpoint용 — 텍스트 대조 없음). */
export async function truncateFromLastUser(
  sessionID: string,
): Promise<{ truncatedMessageId: string; messagesRemoved: number } | { reason: string }> {
  return truncateFromNthLastUser(sessionID, 1)
}

/**
 * 끝에서 n번째 user 메시지부터 잘라낸다 (n=1이면 마지막 user와 동일).
 * stage3 deep-truncate용: 재시도에도 같은 400이 나면 최신 턴 통째가 오염된
 * 것으로 보고 한 턴 더 뒤로 잘라낸다. 손실 범위를 1턴으로 묶기 위해 n>2는
 * 받지 않는다 (그 이상은 사용자 가위·새 세션 영역).
 */
export async function truncateFromNthLastUser(
  sessionID: string,
  n: number,
): Promise<{ truncatedMessageId: string; messagesRemoved: number } | { reason: string }> {
  if (!Number.isInteger(n) || n < 1 || n > 2) return { reason: `unsupported depth n=${n} (max 2)` }
  const { messages, reason } = await fetchMessageList(sessionID)
  if (!messages) return { reason: reason ?? 'no messages' }
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.info?.role === 'user' && m.info.id) {
      seen++
      if (seen === n) {
        try {
          const result = await truncateSessionMessages(sessionID, m.info.id)
          if (!result) return { reason: 'truncate failed' }
          logger.warn(`Deep truncate for session ${sessionID}: cut from ${n}-th last user ${m.info.id} (removed ${result.messagesRemoved} messages)`)
          return { truncatedMessageId: m.info.id, messagesRemoved: result.messagesRemoved }
        } catch (e) {
          return { reason: `truncate threw: ${(e as Error)?.message ?? e}` }
        }
      }
    }
  }
  return { reason: seen === 0 ? 'no user to truncate from' : `only ${seen} user message(s), depth ${n} unavailable` }
}

export interface StaleHistoryHealResult {
  truncatedMessageId?: string
  messagesRemoved?: number
  strippedAllParts: number
  strippedAllMessages: number
  stubsRemoved: number
  stubsPending: string[]
  reason?: string
}

/**
 * stage2 DB 작업: 실패 턴 제거(마지막 user부터 절단) + cutoff 이전 reasoning
 * 전체 strip-all + stub sweep.
 * 참고: 자동 전송 경로(proxy/chat-queue)는 retry storm 이후 단일 정리+1회
 * 정책을 쓰므로 이 헬퍼를 호출하지 않는다. 수동 복구용으로 유지한다.
 */
export async function healStaleHistoryBeyondLastTurn(sessionID: string): Promise<StaleHistoryHealResult> {
  const trunc = await truncateFromNthLastUser(sessionID, 1)
  if ('reason' in trunc) {
    return { strippedAllParts: 0, strippedAllMessages: 0, stubsRemoved: 0, stubsPending: [], reason: trunc.reason }
  }
  let strippedAllParts = 0
  let strippedAllMessages = 0
  try {
    const stripAll = await stripAllReasoningParts(sessionID)
    strippedAllParts = stripAll?.partsRemoved ?? 0
    strippedAllMessages = stripAll?.messagesAffected ?? 0
  } catch (e) {
    logger.warn(`Stage2 strip-all threw for session ${sessionID}:`, e)
  }
  const sweep = await sweepPollutedStubs(sessionID)
  logger.warn(`Stage2 stale-history heal for session ${sessionID}: truncated ${trunc.truncatedMessageId} (removed ${trunc.messagesRemoved}), strip-all ${strippedAllParts} part(s) in ${strippedAllMessages} message(s), stubs removed ${sweep.removed}, pending ${sweep.pending.length}`)
  return {
    truncatedMessageId: trunc.truncatedMessageId,
    messagesRemoved: trunc.messagesRemoved,
    strippedAllParts, strippedAllMessages,
    stubsRemoved: sweep.removed, stubsPending: sweep.pending,
  }
}

/**
 * 수동 백업용 narrow 정리: 꼬리가 mismatch(암호문 거부)일 때만 동작한다.
 * 크로스모델이면 외국 reasoning strip → 마지막 user truncate → sweep 순으로,
 * 단일 모델이면 마지막 user truncate → sweep 순으로 처리한다.
 * 결제·쿼터 등 non-healable이나 clean이면 손대지 않는다.
 * 자동 복구가 실패했을 때의 비상 출구 — 프론트 버튼 없음, API 직접 호출용.
 */
export async function healMismatchTailManual(
  base: string,
  sessionID: string,
  directory: string | undefined,
  outgoingModel?: OutgoingModel,
): Promise<ReasoningHealResult> {
  const { messages, reason } = await fetchMessageList(sessionID)
  if (!messages || messages.length === 0) return { healed: false, reason: reason ?? 'no messages' }
  const { kind, healable } = classifyTail(messages)
  if (kind !== 'mismatch' || !healable) {
    return { healed: false, reason: kind === 'clean' ? 'history clean' : `not a reasoning-mismatch tail (${kind}) — manual cleanup refused`, kind, healable }
  }
  let strippedParts = 0
  let strippedMessages = 0
  let strippedAllParts = 0
  let strippedAllMessages = 0
  let models: ReasoningModelStat[] | undefined
  let suggestedModel: { providerID: string; modelID: string } | undefined
  let finalKind: TailKind = kind
  const diag = await diagnoseMismatch(sessionID)
  if (diag.crossModel) {
    models = diag.models
    suggestedModel = diag.suggestedModel
    finalKind = 'cross-model'
    const names = diag.models.map((m) => `${m.providerID}/${m.modelID}`).join(', ')
    // keep은 outgoing만 쓴다 — 세션 조회 폴백은 자동 경로와 동일하게 제외한다.
    // (UI에서 모델을 바꾼 직후 세션 기록이 아직 이전 모델이면 keep이 반대로 잡혀
    // 정상 전송을 깨뜨린다.) 둘 다 없으면 strip 없이 안내로 빠진다.
    const target = outgoingModel
    if (!target) {
      return {
        healed: false,
        reason: `cross-model reasoning history [${names}] — truncating the last turn cannot help`,
        kind: finalKind, healable, models, suggestedModel,
      }
    }
    try {
      const strip = await stripReasoningParts(sessionID, target)
      strippedParts = strip?.partsRemoved ?? 0
      strippedMessages = strip?.messagesAffected ?? 0
    } catch (e) {
      return { healed: false, reason: `strip threw: ${(e as Error)?.message ?? e}`, kind: finalKind, healable, models, suggestedModel }
    }
  }
  // 동일모델 stale(또는 keep 미상) 폴백: 외국 strip이 0건이면 cutoff 이전
  // reasoning 전체를 모델 무관하게 제거한다. 꼬리가 mismatch라는 건 이미
  // 거부된 히스토리라는 증거라 안전하다.
  if (strippedParts === 0) {
    try {
      const stripAll = await stripAllReasoningParts(sessionID)
      strippedAllParts = stripAll?.partsRemoved ?? 0
      strippedAllMessages = stripAll?.messagesAffected ?? 0
    } catch (e) {
      return { healed: false, reason: `strip-all threw: ${(e as Error)?.message ?? e}`, kind: finalKind, healable, models, suggestedModel }
    }
  }
  // 크로스모델인데 아무것도 벗겨지지 않았으면 truncate해도 사용자 프롬프트만
  // 날리고 오염은 남는다 — 자동 경로와 동일하게 안내로 반환한다.
  if (diag.crossModel && strippedParts === 0 && strippedAllParts === 0) {
    const names = (models ?? []).map((m) => `${m.providerID}/${m.modelID}`).join(', ')
    return {
      healed: false,
      reason: `cross-model reasoning history [${names}] — truncating the last turn cannot help`,
      kind: finalKind, healable, models, suggestedModel,
    }
  }
  const trunc = await truncateFromLastUser(sessionID)
  if ('reason' in trunc) return { healed: false, reason: trunc.reason, kind: finalKind, healable, models, suggestedModel }
  logger.warn(`Manual mismatch heal for session ${sessionID}: stripped ${strippedParts} reasoning part(s), strip-all ${strippedAllParts} part(s), truncated from user ${trunc.truncatedMessageId} (removed ${trunc.messagesRemoved} messages)`)
  const sweep = await sweepPollutedStubs(sessionID)
  return { healed: true, truncatedMessageId: trunc.truncatedMessageId, stubsRemoved: sweep.removed, stubsPending: sweep.pending, strippedParts, strippedMessages, strippedAllParts, strippedAllMessages, kind: finalKind, healable: true, models, suggestedModel }
}
