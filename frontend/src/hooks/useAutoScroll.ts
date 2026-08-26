import { useRef, useEffect, useCallback } from 'react'

const SCROLL_LOCK_MS = 300

interface MessageInfo {
  role: string
}

interface Message {
  info: MessageInfo
}

interface UseAutoScrollOptions<T extends Message> {
  containerRef?: React.RefObject<HTMLDivElement | null>
  messages?: T[]
  sessionId?: string
  enabled?: boolean
  onScrollStateChange?: (isScrolledUp: boolean) => void
}

interface UseAutoScrollReturn {
  scrollToBottom: () => void
}

export function useAutoScroll<T extends Message>({
  containerRef,
  messages,
  sessionId,
  enabled = true,
  onScrollStateChange
}: UseAutoScrollOptions<T>): UseAutoScrollReturn {
  const lastMessageCountRef = useRef(0)
  const hasInitialScrolledRef = useRef(false)
  const userScrolledAtRef = useRef(0)
  const userDisengagedRef = useRef(false)
  const pointerStartYRef = useRef<number | null>(null)

  const scrollToBottom = useCallback(() => {
    if (!containerRef?.current) return
    userScrolledAtRef.current = 0
    userDisengagedRef.current = false
    containerRef.current.scrollTop = containerRef.current.scrollHeight
    onScrollStateChange?.(false)
  }, [containerRef, onScrollStateChange])

  useEffect(() => {
    lastMessageCountRef.current = 0
    hasInitialScrolledRef.current = false
    userScrolledAtRef.current = 0
    userDisengagedRef.current = false
  }, [sessionId])

  useEffect(() => {
    if (!containerRef?.current) return
    
    const container = containerRef.current
    
    const markDisengaged = () => {
      userScrolledAtRef.current = Date.now()
      userDisengagedRef.current = true
      onScrollStateChange?.(true)
    }

    const handlePointerDown = (e: PointerEvent) => {
      pointerStartYRef.current = e.clientY
    }

    const handlePointerMove = (e: PointerEvent) => {
      if (pointerStartYRef.current === null) return
      if (e.clientY > pointerStartYRef.current) {
        markDisengaged()
      }
    }

    const handlePointerUp = () => {
      pointerStartYRef.current = null
    }

    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        markDisengaged()
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (['PageUp', 'ArrowUp', 'Home'].includes(e.key)) {
        markDisengaged()
      }
    }

    const handleScroll = () => {
      if (container.scrollTop + container.clientHeight >= container.scrollHeight) {
        userScrolledAtRef.current = 0
        userDisengagedRef.current = false
        onScrollStateChange?.(false)
      }
    }
    
    container.addEventListener('pointerdown', handlePointerDown, { passive: true })
    container.addEventListener('pointermove', handlePointerMove, { passive: true })
    container.addEventListener('pointerup', handlePointerUp, { passive: true })
    container.addEventListener('pointercancel', handlePointerUp, { passive: true })
    container.addEventListener('wheel', handleWheel, { passive: true })
    container.addEventListener('keydown', handleKeyDown)
    container.addEventListener('scroll', handleScroll, { passive: true })
    
    return () => {
      container.removeEventListener('pointerdown', handlePointerDown)
      container.removeEventListener('pointermove', handlePointerMove)
      container.removeEventListener('pointerup', handlePointerUp)
      container.removeEventListener('pointercancel', handlePointerUp)
      container.removeEventListener('wheel', handleWheel)
      container.removeEventListener('keydown', handleKeyDown)
      container.removeEventListener('scroll', handleScroll)
    }
  }, [containerRef, onScrollStateChange])

  // ResizeObserver: streaming 중 카드가 길어질 때(allow 버튼 등)도 하단까지 따라가게 한다
  useEffect(() => {
    if (!containerRef?.current || !enabled) return
    const container = containerRef.current
    let raf = 0
    const ro = new ResizeObserver(() => {
      if (userDisengagedRef.current) return
      if (Date.now() - userScrolledAtRef.current < SCROLL_LOCK_MS) return
      // 이미 하단 근처에 있을 때만 자동 추적 — 사용자가 위를 보고 있으면 방해하지 않는다
      const nearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 120
      if (!nearBottom) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight
      })
    })
    ro.observe(container)
    // 자식 높이 변화도 감지 (메시지 스트리밍 중)
    if (container.firstElementChild) ro.observe(container.firstElementChild as Element)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [containerRef, enabled])

  useEffect(() => {
    if (!containerRef?.current || !messages || !enabled) return

    const currentCount = messages.length
    const prevCount = lastMessageCountRef.current
    lastMessageCountRef.current = currentCount

    if (!hasInitialScrolledRef.current && currentCount > 0) {
      hasInitialScrolledRef.current = true
      // 초기 진입도 하단으로
      requestAnimationFrame(() => scrollToBottom())
      return
    }

    if (currentCount > prevCount) {
      const newMessage = messages[currentCount - 1]
      if (newMessage?.info.role === 'user') {
        requestAnimationFrame(() => scrollToBottom())
        return
      }
    }

    const timeSinceUserScroll = Date.now() - userScrolledAtRef.current
    const recentlyScrolled = timeSinceUserScroll < SCROLL_LOCK_MS
    
    if (recentlyScrolled || userDisengagedRef.current) {
      return
    }

    requestAnimationFrame(() => scrollToBottom())
  }, [messages, containerRef, scrollToBottom, enabled])

  return { scrollToBottom }
}
