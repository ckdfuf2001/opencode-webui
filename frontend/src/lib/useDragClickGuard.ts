import { useRef } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'

/**
 * "클릭하면 닫힘" 영역에서 드래그를 클릭으로 오인하지 않게 하는 가드.
 *
 * 툴 출력·reasoning 본문처럼 넓은 텍스트 영역을 클릭하면 접히게 해두면,
 * 텍스트를 드래그해 선택한 뒤 손을 떼는 pointerup 이 click 으로 올라와
 * 읽던 내용이 그대로 닫혀버린다. pointerdown 위치와 비교해 일정 픽셀 이상
 * 움직였거나 선택된 텍스트가 있으면 클릭으로 치지 않는다.
 *
 * 반드시 컴포넌트 최상단(early return 이전)에서 호출한다.
 */
export function useDragClickGuard(thresholdPx = 6) {
  const down = useRef<{ x: number; y: number } | null>(null)

  return {
    onPointerDown: (e: ReactPointerEvent) => {
      down.current = { x: e.clientX, y: e.clientY }
    },
    /** 드래그/텍스트 선택이 아니면 fn() 실행, 아니면 무시. */
    clickUnlessDrag: (e: ReactMouseEvent, fn: () => void) => {
      const start = down.current
      down.current = null
      if (start) {
        const moved = Math.abs(e.clientX - start.x) > thresholdPx
          || Math.abs(e.clientY - start.y) > thresholdPx
        if (moved) return
      }
      // 같은 자리에서 눌렀다 떼도 드래그 선택이 남아 있으면 닫지 않는다.
      if (typeof window !== 'undefined' && (window.getSelection()?.toString() ?? '') !== '') return
      fn()
    },
  }
}
