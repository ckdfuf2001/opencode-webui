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

function isVis(e: Element): boolean {
  try {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  } catch {
    return false
  }
}

function stemOf(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,8}$/, '')
}

/**
 * 컨테이너 안에서 lib가 그린 첨부 도형을 찾는다 (없으면 null).
 * - xlsx: ole pic (img alt = cNvPr 이름) 우선, 없으면 구형 sp 박스.
 * - pptx: data-element-id "...-frame-N" + Download 문구.
 * - docx: span[data-docx-ole].
 */
function findAnchorEl(container: HTMLElement, kind: OleAnchorKind, entry: OleEmbeddingRef): Element | null {
  try {
    const all = deepCollect(container)
    if (kind === 'xlsx') {
      const names = new Set([entry.fallbackName, stemOf(entry.fallbackName)])
      for (const el of all) {
        try {
          if (!(el.className?.toString?.() ?? '').includes('xg-obj')) continue
          if (!isVis(el)) continue
          const img = el.tagName === 'IMG' ? el : el.querySelector?.('img')
          const alt = img?.getAttribute?.('alt') ?? ''
          if (alt && names.has(alt)) return el
        } catch {
          /* 무시 */
        }
      }
      // 구형 sp 박스 (네이티브 ole sp / 게이트 파일).
      for (const el of all) {
        try {
          if ((el.className?.toString?.() ?? '').includes('xg-obj-unsupported') && isVis(el)) return el
        } catch {
          /* 무시 */
        }
      }
      return null
    }
    if (kind === 'pptx') {
      for (const el of all) {
        try {
          const eid = el.getAttribute?.('data-element-id') ?? ''
          if (eid.includes('-frame-') && /download/i.test(el.textContent ?? '') && isVis(el)) return el
        } catch {
          /* 무시 */
        }
      }
      return null
    }
    for (const el of all) {
      try {
        if (el.hasAttribute?.('data-docx-ole') && isVis(el)) return el
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
 * - 항목마다 도형 위에 작은 아이콘 (hover → 파일명, dblclick → 다운로드).
 * - 앵커가 없으면 좌상단 이름 칩 (폴백).
 * - 아이콘 드래그는 무시한다 (도형 이동은 lib 도형에서).
 */
export default function OleAttachmentOverlay({
  data,
  anchor,
}: {
  data: ArrayBuffer | Uint8Array
  anchor?: OleAnchorKind
}) {
  const [entries, setEntries] = useState<OleEmbeddingRef[]>([])
  const [posMap, setPosMap] = useState<Record<string, { x: number; y: number }>>({})
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let dead = false
    setEntries([])
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
      setPosMap({})
      return
    }
    const root = rootRef.current
    const container = root?.parentElement as HTMLElement | null
    if (!container) return
    let dead = false
    const update = (): void => {
      if (dead) return
      try {
        const c = container.getBoundingClientRect()
        const next: Record<string, { x: number; y: number }> = {}
        for (const entry of entries) {
          const target = findAnchorEl(container, anchor, entry)
          if (!target) continue
          const r = target.getBoundingClientRect()
          next[entry.partName] = { x: Math.max(0, Math.round(r.left - c.left)), y: Math.max(0, Math.round(r.top - c.top)) }
        }
        setPosMap((prev) => {
          const a = JSON.stringify(prev)
          const b = JSON.stringify(next)
          return a === b ? prev : next
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
  }, [anchor, entries, data])

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

  const chip = (entry: OleEmbeddingRef, anchored: boolean, pos?: { x: number; y: number }): React.ReactNode => (
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
      style={anchored && pos ? { left: pos.x, top: pos.y, position: 'absolute' } : undefined}
      className={
        anchored
          ? 'z-20 inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background/95 text-foreground shadow-sm hover:bg-muted'
          : 'inline-flex items-center gap-1.5 rounded-md border border-border bg-background/95 px-2 py-1 text-xs text-foreground shadow-sm hover:bg-muted'
      }
    >
      <Paperclip className="h-3.5 w-3.5" />
      {!anchored && <span className="max-w-44 truncate">{entry.fallbackName}</span>}
    </button>
  )

  const anchored = entries.filter((e) => anchor != null && posMap[e.partName] != null)
  const fallback = entries.filter((e) => !(anchor != null && posMap[e.partName] != null))
  return (
    <>
      {/* 앵커 탐색용 기준점 (위치는 잡지 않는다). */}
      <div ref={rootRef} className="pointer-events-none absolute left-2 top-2" aria-hidden="true" />
      {anchored.map((e) => chip(e, true, posMap[e.partName]))}
      {fallback.length > 0 && (
        <div className="absolute left-2 top-2 z-20 flex flex-col items-start gap-1">
          {fallback.map((e) => chip(e, false))}
        </div>
      )}
    </>
  )
}
