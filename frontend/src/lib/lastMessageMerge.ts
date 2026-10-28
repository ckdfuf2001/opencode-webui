import {
  textPartsLength,
  toolInputPresence,
  toolOutputLength,
  toolStatusSignature,
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
 * B0-5 확장: usePollLastMessage 병합 가드(useOpenCode.ts)의 판정 함수.
 * 길이·완료가 같아도 part 상태·종료시각·input 유무가 다르면 교체한다.
 * 상태 뒤집힘(running→completed)이 같은 출력에 묻혀 "변경 없음"으로
 * 걸러지던 누락을 막는다. 캐시가 앞설 때(lagging)는 유지한다(D35).
 */
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
    // B0-5 확장: 문자열이 같아도 상태가 뒤집혔으면 교체한다.
    if (toolStatusSignature(curLast.parts as never) !== toolStatusSignature(capped.parts as never)) return true
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
