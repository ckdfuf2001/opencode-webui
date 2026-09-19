/**
 * 전송 직후 커맨드 칩(`/이름`)을 즉시 보여주기 위한 낙관적 인텐트 저장소.
 * 백엔드 run 기록 + messageId 부착(턴 종료 후)까지 기다리면 칩이 새로고침 전에는
 * 안 보이는 문제가 있어, 전송 시점에 인식된 커맨드명을 기억해 뒀다가
 * SessionDetail의 invocationByMessage가 텍스트 매칭으로 먼저 칩을 붙인다.
 * 백엔드 매칭이 되면 그쪽이 우선(taken)이라 자연스럽게 교체된다.
 */

interface CommandIntent {
  name: string
  at: number
}

const INTENT_TTL_MS = 10 * 60_000
const INTENT_MAX_PER_SESSION = 20

const intents = new Map<string, CommandIntent[]>()

/** 커맨드 전송 시점에 기록한다. 인식된 커맨드(known command)에만 호출할 것. */
export function recordCommandIntent(sessionID: string, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  const list = intents.get(sessionID) ?? []
  list.push({ name: trimmed, at: Date.now() })
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
