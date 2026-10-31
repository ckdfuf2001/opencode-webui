import { useEffect, useRef, useState } from 'react'
import JSZip from 'jszip'
import { Paperclip } from 'lucide-react'
import { extractOleAttachment } from '@/lib/oleExtract'
import { listOleEmbeddings, looksLikeCfb, type OleEmbeddingRef } from '@/lib/oleAttachments'

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

/**
 * C5-1: 기존 OLE 첨부 오버레이 (XLSX/DOCX/PPTX 공통).
 * - embeddings/가 있을 때만 첫 항목 아이콘 1개를 렌더한다 (spec: 1개).
 * - 더블클릭 → 원본 파일명·바이트로 다운로드 (package 그대로 / oleObject는 Ole10Native 풀기).
 * - XLSX 이동·삭제 시도 → 읽기전용 가드 토스트 1회 (드래그·Delete).
 */
export default function OleAttachmentOverlay({
  data,
  guard = false,
}: {
  data: ArrayBuffer | Uint8Array
  guard?: boolean
}) {
  const [entries, setEntries] = useState<OleEmbeddingRef[]>([])
  const [guardShown, setGuardShown] = useState(false)
  const dragFrom = useRef<{ x: number; y: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    let dead = false
    setEntries([])
    setGuardShown(false)
    void listOleEmbeddings(data).then((list) => {
      if (!dead) setEntries(list.slice(0, 1))
    })
    return () => {
      dead = true
    }
  }, [data])

  // 드래그 가드: mouseup이 버튼 밖에서 일어나도 window에서 잡는다.
  // mousedown 시점에 좌표를 기록하고, window mouseup에서 거리를 잰다.
  useEffect(() => {
    if (!guard || entries.length === 0) return
    const onUp = (e: MouseEvent): void => {
      const s = dragFrom.current
      dragFrom.current = null
      if (!s) return
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 8) {
        setGuardShown((v) => (v ? v : true))
      }
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [guard, entries.length])
  useEffect(() => {
    if (!guard || entries.length === 0) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const t = e.target as HTMLElement | null
      const onIcon = !!t?.closest?.('[data-testid="ole-icon"]')
      if (!onIcon) return
      e.preventDefault()
      e.stopPropagation()
      setGuardShown((v) => (v ? v : true))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [guard, entries.length])

  if (entries.length === 0) return null
  const entry = entries[0]!

  const download = async (): Promise<void> => {
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

  const showGuard = (): void => {
    if (!guard) return
    setGuardShown((v) => (v ? v : true))
  }

  return (
    <div className="absolute left-2 top-2 z-20 flex flex-col items-start gap-1">
      <button
        ref={btnRef}
        type="button"
        data-testid="ole-icon"
        title={entry.fallbackName}
        aria-label={`첨부 ${entry.fallbackName}`}
        draggable={false}
        onDoubleClick={() => void download()}
        onMouseDown={(e) => {
          dragFrom.current = { x: e.clientX, y: e.clientY }
        }}
        onMouseUp={(e) => {
          const s = dragFrom.current
          dragFrom.current = null
          if (!s) return
          const dx = e.clientX - s.x
          const dy = e.clientY - s.y
          if (Math.hypot(dx, dy) > 8) showGuard()
        }}
        onDragStart={(e) => {
          e.preventDefault()
          showGuard()
        }}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/95 px-2 py-1 text-xs text-foreground shadow-sm hover:bg-muted"
      >
        <Paperclip className="h-3.5 w-3.5" />
        <span className="max-w-44 truncate">{entry.fallbackName}</span>
      </button>
      {guard && guardShown && (
        <div
          data-testid="ole-guard-toast"
          role="status"
          className="rounded-md border border-border bg-background/95 px-2 py-1 text-[11px] text-muted-foreground shadow-sm"
        >
          임베디드 개체는 이동·삭제할 수 없습니다 (읽기전용)
        </div>
      )}
    </div>
  )
}
