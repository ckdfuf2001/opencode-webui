/**
 * D26: 원격 마우스 커서는 게시도 표시도 하지 않는다.
 *
 * 근거 (pptx-react-viewer@4.33.0 / ooxml-ui@1.8.0):
 * - chunk-552NAFTD.js:12570-12590 — 포인터가 움직일 때마다
 *   `broadcastPresence({cursorX, cursorY, activeSlideIndex})`.
 * - chunk-552NAFTD.js:334-368 — BROADCAST_THROTTLE_MS = 50
 *   (chunk-MCHPNO42.mjs:31551)이므로 초당 20회 awareness 갱신이 발생한다.
 * - 갱신 1회마다 상태 전체를 JSON 직렬화해 송신하고, 수신 측에서는
 *   awareness 'change' + 'update' 두 이벤트마다 projector를 돌려
 *   (chunk-552NAFTD.js:388-402) React 리렌더가 일어난다.
 *
 *CollaborationConfig(ooxml-ui/dist/pptx/types.d.ts:181-237)와
 * ViewerDialogId(customization-types.d.ts:166)에 커서를 끄는 옵션이 없어
 * 전송 계층에서 제거한다. lib 패치는 하지 않는다(AGENTS.md C3).
 */

/** lib가 마우스 위치를 담는 awareness 필드 내부 키. */
export const CURSOR_KEYS = ['cursorX', 'cursorY'] as const

/** 신선도 유지용: 이 간격(초)보다 오래 아무것도 안 보냈다면 노이즈 갱신이라도 보낸다. */
export const PRESENCE_STALE_S = 10

/**
 * presence 안에서 매번 바뀌지만 의미 없는 키.
 *
 * lastUpdated까지 넣는 이유: lib의 broadcastPresence flush()는 포인터가 움직일 때마다
 * (chunk-552NAFTD.js:342-353) lastUpdated를 함께 찍는다. 좌표만 뺀 판정으로는
 * 마우스 이동이 "커서만 변경"으로 잡히지 않아 상위 초당 4회 제한에 걸린다.
 * 신선도(freshness)는 갱신 횟수가 아니라 시간 간격으로 따로 지킨다.
 */
export const PRESENCE_NOISE_KEYS = ['cursorX', 'cursorY', 'lastUpdated'] as const

function omitKeys(src: unknown, keys: readonly string[]): unknown {
  if (!src || typeof src !== 'object') return src
  const record = src as Record<string, unknown>
  let changed = false
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    if (keys.includes(key)) {
      changed = true
      continue
    }
    out[key] = record[key]
  }
  return changed ? out : src
}

/**
 * awareness state에서 커서 좌표를 제거한 **사본**을 돌려준다.
 * 원본은 건드리지 않는다(로컬 state/setLocalState 불변 원칙, AGENTS.md C5).
 * presence의 userName·activeSlideIndex·selectedElementId는 남긴다 —
 * 원격 선택 외곽선(E3)이 그 값에 의존한다.
 */
export function stripCursorFields(state: unknown): unknown {
  if (!state || typeof state !== 'object') return state
  const record = state as Record<string, unknown>
  const presence = omitKeys(record.presence, CURSOR_KEYS)
  const top = omitKeys(record, CURSOR_KEYS)
  if (presence === record.presence && top === record) return record
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    if (key === 'presence') {
      if (presence !== undefined) out.presence = presence
      continue
    }
    if ((CURSOR_KEYS as readonly string[]).includes(key)) continue
    out[key] = record[key]
  }
  return out
}

function withoutPresenceNoise(state: unknown): unknown {
  if (!state || typeof state !== 'object') return state
  const record = state as Record<string, unknown>
  const presence = omitKeys(record.presence, PRESENCE_NOISE_KEYS)
  if (presence === record.presence) return record
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    out[key] = key === 'presence' ? presence : record[key]
  }
  return out
}

/**
 * 두 상태가 커서 좌표와 lastUpdated만 놓고 같으면 true.
 * lastUpdated는 포인터 이동마다 함께 바뀌므로 없애야 "마우스만 움직인 경우"가 잡힌다.
 * 신선도 유지를 위한 주기적 재게시는 호출부가 시간으로 판단한다(PRESENCE_STALE_S).
 */
export function onlyPresenceNoiseChanged(prev: unknown, next: unknown): boolean {
  return JSON.stringify(withoutPresenceNoise(prev)) === JSON.stringify(withoutPresenceNoise(next))
}

export interface AwarenessThrottle {
  /** 지금 보낼 수 있으면 true. 아니면 false이고 호출자가 trailing을 예약한다. */
  request(): boolean
}

/**
 * 초당 maxPerSecond회로 제한한다. 막히면 false를 돌려주고, 호출자가 trailing을 예약한다.
 * 마지막 값 보장은 호출자가 예약한 trailing 송신이 현재 상태를 읽어서 처리한다.
 */
export function createAwarenessThrottle(maxPerSecond: number, now: () => number = Date.now): AwarenessThrottle {
  const minInterval = Math.max(1, Math.floor(1000 / Math.max(1, maxPerSecond)))
  let lastSentAt = Number.NEGATIVE_INFINITY
  return {
    request(): boolean {
      const t = now()
      if (t - lastSentAt >= minInterval) {
        lastSentAt = t
        return true
      }
      return false
    },
  }
}
