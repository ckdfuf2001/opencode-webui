import {
  textPartsLength,
  toolInputPresence,
  toolOutputLength,
  toolTimeEndSignature,
} from './messageListEquality'

interface PartLike {
  type?: string
  text?: string
  state?: {
    status?: string
    output?: string
    metadata?: { output?: string }
    time?: { end?: number }
    input?: unknown
  }
}

interface MsgLike {
  info: { id: string; time?: { completed?: number } }
  parts: PartLike[]
}

function isCompleted(info: MsgLike['info']): boolean {
  return Boolean((info.time as { completed?: number } | undefined)?.completed)
}

/**
 * B0-5 확장 + P2: usePollLastMessage 병합 가드(useOpenCode.ts)의 판정 함수.
 * 길이·완료가 같아도 part 상태·종료시각·input 유무가 다르면 교체한다.
 * 단, 상태 역행(completed → running 같은 뒤집힘)은 교체하지 않는다 —
 * SSE가 앞서 completed가 된 뒤 늦게 온 폴링 응답이 running으로 되돌리는 것을 막는다.
 * 순방향(pending → running → completed/error)일 때만 상태로 교체한다.
 */
const STATUS_RANK: Record<string, number> = { pending: 0, running: 1, completed: 2, error: 2 }

function statusRanks(parts: MsgLike['parts']): number[] {
  return parts
    .filter((p) => p.type === 'tool')
    .map((p) => {
      const s = p.state?.status
      return typeof s === 'string' && s in STATUS_RANK ? STATUS_RANK[s]! : -1
    })
}

export function shouldReplaceLastMessage(curLast: MsgLike, capped: MsgLike): boolean {
  const curCompleted = isCompleted(curLast.info)
  const nextCompleted = isCompleted(capped.info)
  const curTextLen = textPartsLength(curLast.parts as never)
  const nextTextLen = textPartsLength(capped.parts as never)
  const curToolLen = toolOutputLength(curLast.parts as never)
  const nextToolLen = toolOutputLength(capped.parts as never)
  if (
    curLast.parts.length === capped.parts.length &&
    curCompleted === nextCompleted &&
    curTextLen === nextTextLen &&
    curToolLen === nextToolLen
  ) {
    // B0-5 확장: 문자열이 같아도 상태가 앞으로 갔으면 교체한다.
    // P2: 역행(completed → running)은 교체하지 않는다. time.end가 달라도
    // 역행이면 유지한다(늦은 폴링이 화면을 되돌리지 않게).
    const curRanks = statusRanks(curLast.parts)
    const nextRanks = statusRanks(capped.parts)
    if (curRanks.length === nextRanks.length) {
      let forward = false
      let comparable = true
      for (let i = 0; i < curRanks.length; i++) {
        const c = curRanks[i]!
        const n = nextRanks[i]!
        if (c < 0 || n < 0) {
          comparable = false
          break
        }
        if (n < c) return false
        if (n > c) forward = true
      }
      if (comparable && forward) return true
      if (!comparable) return true
      // 순서는 같거나(상태 동일) 뒤로 갔다 — 상태로는 교체하지 않는다.
      // time.end/input/문자열 비교로 넘어간다.
    }
    if (toolTimeEndSignature(curLast.parts as never) !== toolTimeEndSignature(capped.parts as never)) return true
    if (toolInputPresence(curLast.parts as never) !== toolInputPresence(capped.parts as never)) return true
    const curText = curLast.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('')
    const nextText = capped.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('')
    const curTool = curLast.parts
      .filter((p) => p.type === 'tool')
      .map((p) => p.state?.output ?? p.state?.metadata?.output ?? '')
      .join('')
    const nextTool = capped.parts
      .filter((p) => p.type === 'tool')
      .map((p) => p.state?.output ?? p.state?.metadata?.output ?? '')
      .join('')
    if (curText === nextText && curTool === nextTool) return false
  }
  if (curTextLen > nextTextLen || curToolLen > nextToolLen) return false
  return true
}
