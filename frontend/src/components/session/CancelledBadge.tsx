import { Circle, Square } from 'lucide-react'

/**
 * 취소 배지 — lucide StopCircle(원은 무채색·내부 정지 네모가 작음) 대체용.
 * 원은 amber, 내부 네모는 크게 + 채움으로 그린다.
 */
export function CancelledBadge({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const outer = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'
  const inner = size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2'
  return (
    <span title="Cancelled" className={`relative inline-flex shrink-0 ${outer}`}>
      <Circle className={`${outer} text-amber-500`} strokeWidth={2.25} />
      <Square className={`absolute inset-0 m-auto ${inner} fill-amber-500 text-amber-600`} strokeWidth={1.5} />
    </span>
  )
}
