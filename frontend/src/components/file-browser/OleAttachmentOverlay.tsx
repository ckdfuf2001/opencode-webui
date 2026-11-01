import { useEffect, useRef, useState } from 'react'
import JSZip from 'jszip'
import { Paperclip } from 'lucide-react'
import { extractOleAttachment } from '@/lib/oleExtract'
import { listOleEmbeddings, looksLikeCfb, type OleEmbeddingRef } from '@/lib/oleAttachments'
import { deepCollect, observeDeep } from '@/lib/domDeep'

function saveBlob(name: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export type OleAnchorKind = 'xlsx' | 'pptx' | 'docx'

/** 컨테이너 안에서 lib가 그린 첨부 도형을 찾는다 (없으면 null). */
function findAnchorEl(container: HTMLElement, kind: OleAnchorKind): Element | null {
  const vis = (e: Element): boolean => {
    try {
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    } catch {
      return false
    }
  }
  try {
    if (kind === 'xlsx') {
      for (const el of deepCollect(container)) {
        try {
          if ((el.className?.toString?.() ?? '').includes('xg-obj-unsupported') && vis(el)) return el
        } catch {
          /* 무시 */
        }
      }
      return null
    }
    if (kind === 'pptx') {
      // lib ole 프레임: data-element-id "...-frame-N" + Download 문구.
      for (const el of deepCollect(container)) {
        try {
          const eid = el.getAttribute?.('data-element-id') ?? ''
          if (eid.includes('-frame-') && /download/i.test(el.textContent ?? '') && vis(el)) return el
        } catch {
          /* 무시 */
        }
      }
      return null
    }
    for (const el of deepCollect(container)) {
      try {
        if (el.hasAttribute?.('data-docx-ole') && vis(el)) return el
      } catch {
        /* 무시 */
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * C5-1 후속 S2 + C5-2: 기존 OLE 첨부 오버레이를 lib 도형 위에 앵커한다.
 * - 앵커가 있으면 첫 도형 위에 작은 아이콘 1개 + 나머지는 이름 칩:
 *   hover → 파일명(title), 더블클릭 → 원본 파일명·바이트로 다운로드.
 * - 앵커가 없으면 좌상단 칩들 (폴백).
 * - 아이콘 드래그는 무시한다 (도형 이동은 lib 도형에서 — S1에서 저장됨).
 */
export default function OleAttachmentOverlay({
  data,
  anchor,
}: {
  data: ArrayBuffer | Uint8Array
  anchor?: OleAnchorKind
}) {
  const [entries, setEntries] = useState<OleEmbeddingRef[]>([])
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let dead = false
    setEntries([])
    // C5-2: 첨부가 여러 개면 아이콘도 여러 개 (첫 항목만 도형에 앵커).
    void listOleEmbeddings(data).then((list) => {
      if (!dead) setEntries(list.slice(0, 8))
    })
    return () => {
      dead = true
    }
  }, [data])

  // 앵커 추적: 스크롤·리사이즈·DOM 변경 때 재계산 (폴링 없음).
  useEffect(() => {
    if (!anchor || entries.length === 0) {
      setPos(null)
      return
    }
    const root = rootRef.current
    const container = root?.parentElement as HTMLElement | null
    if (!container) return
    let dead = false
    const update = (): void => {
      if (dead) return
      try {
        const target = findAnchorEl(container, anchor)
        if (!target) {
          setPos(null)
          return
        }
        const c = container.getBoundingClientRect()
        const r = target.getBoundingClientRect()
        setPos((prev) => {
          const x = Math.max(0, Math.round(r.left - c.left))
          const y = Math.max(0, Math.round(r.top - c.top))
          if (prev && prev.x === x && prev.y === y) return prev
          return { x, y }
        })
      } catch {
        /* 무시 */
      }
    }
    update()
    // shadow 안의 삽입까지 본다 (xlsx 도형은 shadow 아래에 렌더된다).
    const stopDeep = observeDeep(container, update)
    const onScroll = (): void => update()
    const onResize = (): void => update()
    try {
      container.addEventListener('scroll', onScroll, { capture: true, passive: true })
    } catch {
      /* 무시 */
    }
    window.addEventListener('resize', onResize)
    return () => {
      dead = true
      stopDeep()
      try {
        container.removeEventListener('scroll', onScroll, { capture: true })
      } catch {
        /* 무시 */
      }
      window.removeEventListener('resize', onResize)
    }
  }, [anchor, entries.length, data])

  if (entries.length === 0) return null

  const download = async (entry: OleEmbeddingRef): Promise<void> => {
    try {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
      const zip = await JSZip.loadAsync(bytes)
      const file = zip.files[entry.partName]
      if (!file) return
      const raw = new Uint8Array(await file.async('uint8array'))
      const relType = looksLikeCfb(raw) ? 'oleObject' : 'package'
      const out = extractOleAttachment(raw, relType, entry.fallbackName)
      saveBlob(out.fileName, out.bytes)
    } catch {
      /* 무시 (lib 렌더는 그대로) */
    }
  }

  const anchored = anchor != null && pos != null
  return (
    <div
      ref={rootRef}
      className="absolute left-2 top-2 z-20 flex flex-col items-start gap-1"
      style={anchored && pos ? { left: pos.x, top: pos.y } : undefined}
    >
      {entries.map((entry, i) => {
        const first = i === 0 && anchored
        return (
          <button
            key={entry.partName}
            type="button"
            data-testid="ole-icon"
            title={entry.fallbackName}
            aria-label={`첨부 ${entry.fallbackName}`}
            draggable={false}
            onDoubleClick={() => void download(entry)}
            onDragStart={(e) => {
              // 아이콘 드래그는 무시한다 (도형 이동은 lib 도형에서).
              e.preventDefault()
            }}
            className={
              first
                ? 'inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background/95 text-foreground shadow-sm hover:bg-muted'
                : 'inline-flex items-center gap-1.5 rounded-md border border-border bg-background/95 px-2 py-1 text-xs text-foreground shadow-sm hover:bg-muted'
            }
          >
            <Paperclip className="h-3.5 w-3.5" />
            {!first && <span className="max-w-44 truncate">{entry.fallbackName}</span>}
          </button>
        )
      })}
    </div>
  )
}
