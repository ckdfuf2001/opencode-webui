import { useEffect, useRef, useState } from 'react'

/**
 * G2: lib 타이틀바 actions 슬롯에 앱 UI를 꽂는다.
 *
 * - host: 에디터 custom element (예: xlsx-editor, docx-editor).
 * - 타이틀바 element(office-ui-title-bar 계열)를 host의 shadowRoot 안에서 찾아
 *   `<div slot="actions" style="display:contents">` 래퍼를 붙인다.
 * - React createPortal 대상으로 반환. 타이틀바가 늦게 생기거나 다시 만들어지면
 *   MutationObserver로 따라간다 (폴링 없음).
 * - PPT는 래퍼의 titleBarSlot prop을 쓰므로 이 훅이 필요 없다.
 */
export function useTitlebarSlot(
  getHost: () => Element | null,
  titlebarSelector: string,
  resetKey: unknown,
): HTMLDivElement | null {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  const getHostRef = useRef(getHost)
  getHostRef.current = getHost

  useEffect(() => {
    let dead = false
    let wrap: HTMLDivElement | null = null
    let mo: MutationObserver | null = null
    let raf = 0

    const attached = (): boolean => {
      try {
        return !!wrap && !!wrap.isConnected && wrap.parentNode instanceof Element && wrap.getAttribute('slot') === 'actions'
      } catch {
        return false
      }
    }

    const ensure = (): void => {
      if (dead) return
      if (attached()) return
      let host: Element | null = null
      try {
        host = getHostRef.current()
      } catch {
        host = null
      }
      let root: ShadowRoot | null = null
      try {
        root = (host as unknown as { shadowRoot?: ShadowRoot | null } | null)?.shadowRoot ?? null
      } catch {
        root = null
      }
      if (!root) return
      let bar: Element | null = null
      try {
        bar = root.querySelector(titlebarSelector)
      } catch {
        bar = null
      }
      if (!(bar instanceof Element)) return
      try {
        if (!wrap) {
          wrap = document.createElement('div')
          wrap.setAttribute('slot', 'actions')
          wrap.style.display = 'contents'
          wrap.setAttribute('data-testid', 'app-titlebar-slot')
        }
        bar.appendChild(wrap)
        if (!dead) setSlot(wrap)
      } catch {
        /* 무시 */
      }
    }

    ensure()
    // 타이틀바가 늦게 생기거나 다시 만들어지면 따라간다.
    try {
      let host: Element | null = null
      try {
        host = getHostRef.current()
      } catch {
        host = null
      }
      const root = (host as unknown as { shadowRoot?: ShadowRoot | null } | null)?.shadowRoot ?? null
      if (root) {
        mo = new MutationObserver(() => {
          if (dead) return
          if (raf) return
          raf = requestAnimationFrame(() => {
            raf = 0
            ensure()
          })
        })
        mo.observe(root, { childList: true, subtree: true })
      }
    } catch {
      /* 무시 */
    }
    return () => {
      dead = true
      try {
        mo?.disconnect()
      } catch {
        /* 무시 */
      }
      try {
        if (raf) cancelAnimationFrame(raf)
      } catch {
        /* 무시 */
      }
      raf = 0
      mo = null
      try {
        wrap?.remove()
      } catch {
        /* 무시 */
      }
      wrap = null
      setSlot(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- resetKey로만 재실행한다.
  }, [titlebarSelector, resetKey])

  return slot
}
