import { textPartsLength, toolOutputLength } from './messageListEquality'

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
 * B0-5 확장: usePollLastMessage 병합 가드(useOpenCode.ts)의 현재 동작을 옮긴 판정 함수.
 * 길이·완료·문자열이 같으면 캐시를 유지한다 — part 상태 뒤집힘도 "같음"으로
 * 걸러져 running 타일이 남는다(수정 전 동작, 테스트 red).
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
