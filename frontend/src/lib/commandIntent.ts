/**
 * 전송 시점에 인식된 커맨드명을 기억해 칩(`/이름`)을 즉시 붙이기 위한 저장소.
 * 백엔드 run 기록 + messageId 부착(턴 종료 후)까지 기다리면 새로고침 전에는
 * 칩이 안 보인다. 전송 경로(세션 입력창·미니챗·edit 재전송)와 무관하게
 * SessionDetail이 텍스트 매칭으로 먼저 칩을 붙이고,
 * 백엔드 매칭(taken)이 우선이라 턴 종료 후 run 기준으로 교체된다.
 * 입력된 그대로(typed) 저장 — canonical 변환 시 텍스트와 어긋나 매칭이 깨진다.
 */

interface CommandIntent {
  /** 입력된 커맨드명 원문 (소문자 비교용으로 함께 보관) */
  name: string
  at: number
}

const INTENT_TTL_MS = 10 * 60_000
const INTENT_MAX_PER_SESSION = 20

const intents = new Map<string, CommandIntent[]>()

/** 커맨드 전송 시점에 기록한다. text는 `/이름` 으로 시작하는 원문. */
export function recordCommandIntent(sessionID: string, text: string): void {
  const m = text.trim().match(/^\/([^\s/]+)/)
  if (!m) return
  const name = m[1] ?? ''
  if (!name) return
  const list = intents.get(sessionID) ?? []
  list.push({ name, at: Date.now() })
  while (list.length > INTENT_MAX_PER_SESSION) list.shift()
  intents.set(sessionID, list)
}

/** 살아있는 인텐트명 목록 (오래된 것은 정리). */
export function liveCommandIntents(sessionID: string): string[] {
  const list = intents.get(sessionID)
  if (!list || list.length === 0) return []
  const now = Date.now()
  const live = list.filter((i) => now - i.at < INTENT_TTL_MS)
  if (live.length === 0) {
    intents.delete(sessionID)
    return []
  }
  if (live.length !== list.length) intents.set(sessionID, live)
  return live.map((i) => i.name)
}
