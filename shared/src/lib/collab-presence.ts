/**
 * lib presence wire format (단일 진실 통로).
 * 근거: ooxml-ui dist/pptx/chunk-MCHPNO42.mjs createPresencePublisher —
 *   awareness.setLocalStateField("presence", {
 *     userName, userColor, userAvatar?, role?,
 *     activeSlideIndex, cursorX, cursorY, selectedElementId?, lastUpdated })
 * 서버(roomParticipants)와 클라이언트(usePeers)가 같은 키로 읽는다.
 */
export const LIB_PRESENCE_KEY = 'presence' as const

export type LibPresenceRole = 'owner' | 'collaborator' | 'viewer'

export interface LibPresence {
  userName?: unknown
  userColor?: unknown
  userAvatar?: unknown
  role?: unknown
  activeSlideIndex?: unknown
  cursorX?: unknown
  cursorY?: unknown
  selectedElementId?: unknown
  lastUpdated?: unknown
  /** X2a: 브라우저별 사용자 id(collab-user). lib 기본 presence 에는 없고 앱이 실어 보낸다. */
  userId?: unknown
}

export interface ParsedPresence {
  name: string
  color: string
  role?: LibPresenceRole
  slide?: number
  cursor?: { x: number; y: number }
  selectedId?: string
  updatedAt?: number
  /** X2a: 없으면 undefined(하위 호환). 있으면 같은 사람의 탭을 하나로 묶는 키. */
  userId?: string
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** awareness state map의 한 항목에서 lib presence를 읽는다. 없으면 null. */
export function readLibPresence(state: Record<string, unknown> | null | undefined): ParsedPresence | null {
  const raw = (state?.[LIB_PRESENCE_KEY] ?? null) as LibPresence | null
  if (!raw || typeof raw !== 'object') return null
  const name = asString(raw.userName)
  if (!name) return null
  const slide = asNumber(raw.activeSlideIndex)
  const cx = asNumber(raw.cursorX)
  const cy = asNumber(raw.cursorY)
  const updatedRaw = asString(raw.lastUpdated)
  let updatedAt: number | undefined
  if (updatedRaw) {
    const t = Date.parse(updatedRaw)
    if (!Number.isNaN(t)) updatedAt = t
  }
  const role = asString(raw.role)
  return {
    name,
    color: asString(raw.userColor) ?? '#6366f1',
    role: role === 'owner' || role === 'collaborator' || role === 'viewer' ? role : undefined,
    slide: slide !== undefined && slide >= 0 ? slide : undefined,
    cursor: cx !== undefined && cy !== undefined ? { x: cx, y: cy } : undefined,
    selectedId: asString(raw.selectedElementId),
    updatedAt,
    userId: asString(raw.userId),
  }
}
