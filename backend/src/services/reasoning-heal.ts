import { ensureServerAuth } from './opencode-auth'
import { logger } from '../utils/logger'

interface LoosePart {
  type?: string
  text?: string
}

interface LooseMessage {
  info?: {
    id?: string
    role?: string
    time?: { created?: number }
  }
  parts?: LoosePart[]
}

export interface ReasoningHealResult {
  healed: boolean
  reason?: string
  truncatedMessageId?: string
}

const MESSAGE_LIST_TIMEOUT_MS = 20_000
/** 마지막 user 메시지가 이보다 오래됐으면 남의 턴으로 보고 자르지 않는다. */
const HEAL_FRESHNESS_MS = 10 * 60_000

function userTextOf(msg: LooseMessage): string {
  const parts = Array.isArray(msg.parts) ? msg.parts : []
  return parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string' && p.text.trim())
    .map((p) => p.text as string)
    .join('\n')
    .trim()
}

/**
 * reasoning 암호문 불일치로 거부된 턴의 꼬리를 잘라낸다 (마지막 user 메시지부터 끝까지).
 * "그뒤로 그세션 활용을 못해" 먹통 세션의 자동 복구용. 안전장치:
 * - 저장된 마지막 user 메시지 텍스트가 방금 보낸 텍스트와 일치할 때만 자른다
 *   (recall/run-context 주입은 앞에 붙으므로, 주입 후 본문과 정확히 일치하거나
 *   원문으로 끝나는 경우만 인정 → 엉뚱한 과거 턴 삭제 방지).
 * - 10분 이내 생성된 메시지가 아니면 자르지 않는다.
 * - 최대 1개 턴만 자른다. 오염이 더 앞 히스토리에 있으면 재시도가 다시 실패하고
 *   enriched error 안내(더 앞 가위질·원래 모델 복귀)로 넘어간다. 자동 반복 없음.
 * - opencode-db는 bun:sqlite를 값 import하므로 동적 import (node/vitest 호환).
 */
export async function healReasoningTail(
  base: string,
  sessionID: string,
  directory: string | undefined,
  candidates: string[],
): Promise<ReasoningHealResult> {
  const texts = candidates.map((t) => (t ?? '').trim()).filter((t) => t.length > 0)
  if (texts.length === 0) return { healed: false, reason: 'empty expected text' }

  const dirQs = directory ? `?directory=${encodeURIComponent(directory)}` : ''
  let listRes: Response
  try {
    listRes = await fetch(`${base}/session/${sessionID}/message${dirQs}`, {
      headers: ensureServerAuth({}),
      signal: AbortSignal.timeout(MESSAGE_LIST_TIMEOUT_MS),
    })
  } catch (e) {
    return { healed: false, reason: `message list fetch failed: ${(e as Error)?.message ?? e}` }
  }
  if (!listRes.ok) return { healed: false, reason: `message list HTTP ${listRes.status}` }
  let messages: LooseMessage[]
  try {
    messages = (await listRes.json()) as LooseMessage[]
  } catch {
    return { healed: false, reason: 'message list parse failed' }
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { healed: false, reason: 'no messages' }
  }

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
  if (!created || Date.now() - created > HEAL_FRESHNESS_MS) {
    return { healed: false, reason: 'last user message too old' }
  }

  const stored = userTextOf(lastUser)
  const matched = texts.some((t) => stored === t || stored.endsWith(t))
  if (!matched) {
    return { healed: false, reason: 'text mismatch (not our turn?)' }
  }

  try {
    const { truncateSessionMessages } = await import('./opencode-db')
    const result = await truncateSessionMessages(sessionID, cursorId)
    if (!result) return { healed: false, reason: 'truncate failed' }
    logger.warn(
      `Healed reasoning mismatch for session ${sessionID}: truncated from user message ${cursorId} (removed ${result.messagesRemoved} messages, ${result.partsRemoved} parts)`,
    )
    return { healed: true, truncatedMessageId: cursorId }
  } catch (e) {
    return { healed: false, reason: `truncate threw: ${(e as Error)?.message ?? e}` }
  }
}
