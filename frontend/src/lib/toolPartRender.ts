type ToolPartLike = {
  type?: string
  state?: { status?: string }
} | null

/**
 * B0-5: SSE off여도 bash 타일을 SSE on과 같은 컴포넌트·모양으로 그린다.
 * 미완료 tool도 full 타일로 렌더한다(compact 행 금지).
 * placeholder는 툴이 아직 하나도 없을 때(순수 텍스트 스트리밍)만 쓴다.
 */
export function toolPartRenderMode(opts: {
  sseOn: boolean
  streaming: boolean
  part: ToolPartLike
}): 'full' | 'placeholder' {
  const { streaming, part } = opts
  if (!streaming) return 'full'
  if (!part || part.type !== 'tool') return 'placeholder'
  return 'full'
}
