type ToolPartLike = {
  type?: string
  state?: { status?: string }
} | null

/**
 * B0-5: SSE off여도 bash 타일을 SSE on과 같은 컴포넌트·모양으로 그린다.
 * 현재 동작(MessageThread.tsx:373-396)을 그대로 옮긴 판정 함수.
 * sseOffStreaming + 미완료 tool이면 compact 행, 아니면 full 타일.
 */
export function toolPartRenderMode(opts: {
  sseOn: boolean
  streaming: boolean
  part: ToolPartLike
}): 'full' | 'compact' | 'placeholder' {
  const { sseOn, streaming, part } = opts
  if (!streaming) return 'full'
  if (!part || part.type !== 'tool') return 'placeholder'
  const status = part.state?.status
  if (!sseOn && status !== 'completed' && status !== 'error') return 'compact'
  return 'full'
}
