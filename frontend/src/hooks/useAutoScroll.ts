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
  // 콜백 ref로 추적한 실제 노드 (로딩 후 마운트/리마운트 시 재부착용)
  containerNode?: HTMLDivElement | null
  messages?: T[]
  sessionId?: string
  enabled?: boolean
  onScrollStateChange?: (isScrolledUp: boolean) => void
}

interface UseAutoScrollReturn {
  scrollToBottom: () => void
  markDisengaged: () => void
  isDisengaged: () => boolean
}

export function useAutoScroll<T extends Message>({
  containerRef,
  containerNode,
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

  // 히스토리 열람(Load more·검색 이동 등) 시 자동 추종이 하단으로
  // 끌어당기지 않도록 사용자가 위를 본 것으로 표시한다.
  const markDisengaged = useCallback(() => {
    userScrolledAtRef.current = Date.now()
    userDisengagedRef.current = true
    onScrollStateChange?.(true)
  }, [onScrollStateChange])

  // 진단용: 현재 추종 해제 여부 (리렌더 없이 읽는다)
  const isDisengaged = useCallback(() => userDisengagedRef.current, [])

  useEffect(() => {
    lastMessageCountRef.current = 0
    hasInitialScrolledRef.current = false
    userScrolledAtRef.current = 0
    userDisengagedRef.current = false
  }, [sessionId])

  useEffect(() => {
    const container = containerNode ?? containerRef?.current
    if (!container) return
    
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

    // 추종 여부는 제스처가 아니라 위치로 판단한다 — 휠/드래그/키보드/터치
    // 어떤 수단으로든 아래를 벗어나면 추종 해제, 맨 아래면 추종 재개.
    // (기존 제스처 감지로는 스크롤바 드래그·스페이스·터치가 빠져 다음 폴링에 끌려내려갔다)
    const handleScroll = () => {
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 40) {
        userScrolledAtRef.current = 0
        userDisengagedRef.current = false
        onScrollStateChange?.(false)
      } else if (!userDisengagedRef.current) {
        userDisengagedRef.current = true
        onScrollStateChange?.(true)
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
    // 컨테이너가 key={sessionId}로 리마운트 + 로딩 후 마운트되므로
    // 실제 노드 기준으로 리스너 재부착
  }, [containerRef, containerNode, onScrollStateChange, sessionId])

  // ResizeObserver + MutationObserver: streaming 중 카드가 길어질 때(allow 버튼 등)도 하단까지 따라가게 한다
  // permission/question 카드가 길어져도 버튼이 보이도록 모든 자식의 크기 변화를 감지한다
  useEffect(() => {
    const container = containerNode ?? containerRef?.current
    if (!container || !enabled) return
    let raf = 0
    const maybeScroll = () => {
      if (userDisengagedRef.current) return
      if (Date.now() - userScrolledAtRef.current < SCROLL_LOCK_MS) return
      const nearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 120
      if (!nearBottom) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight
      })
    }
    const ro = new ResizeObserver(maybeScroll)
    ro.observe(container)
    for (const child of Array.from(container.children)) ro.observe(child as Element)
    const mo = new MutationObserver(() => {
      for (const child of Array.from(container.children)) {
        try { ro.observe(child as Element) } catch {}
      }
      maybeScroll()
    })
    mo.observe(container, { childList: true, subtree: true, characterData: true })
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      mo.disconnect()
    }
  }, [containerRef, containerNode, enabled, sessionId])

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

  return { scrollToBottom, markDisengaged, isDisengaged }
}
