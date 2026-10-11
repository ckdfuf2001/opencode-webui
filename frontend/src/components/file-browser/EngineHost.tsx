import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

const MIN_H = 480

export default function EngineHost({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [h, setH] = useState(MIN_H)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((es) => {
      const v = Math.max(MIN_H, Math.round(es[0].contentRect.height))
      setH((prev) => (prev === v ? prev : v))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={ref} className={className} style={{ '--xvh': `${h}px` } as CSSProperties}>
      {children}
    </div>
  )
}
