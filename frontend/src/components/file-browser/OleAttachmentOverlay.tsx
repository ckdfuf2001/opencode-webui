import { useEffect, useRef, useState } from 'react'
import JSZip from 'jszip'
import {
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Paperclip,
  Presentation,
} from 'lucide-react'
import { extractOleAttachment } from '@/lib/oleExtract'
import { listOleEmbeddings, looksLikeCfb, type OleEmbeddingRef } from '@/lib/oleAttachments'
import { deepCollect, observeDeep } from '@/lib/domDeep'
import { attachmentKindOf } from './embedEdit'
import { editUrlForAttachment, openInNewTab } from '@/lib/editUrls'
import { showToast } from '@/lib/toast'

/** lib가 렌더를 포기한 자리 표시자 (xg-obj-unsupported — 텍스트 판정 금지). */

/** 확장자별 카드 아이콘. */
function iconForFile(name: string): typeof FileIcon {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return FileSpreadsheet
  if (['ppt', 'pptx', 'odp', 'key'].includes(ext)) return Presentation
  if (['pdf', 'txt', 'md', 'doc', 'docx', 'rtf', 'odt', 'hwp', 'hwpx'].includes(ext)) return FileText
  if (['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) return FileArchive
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'tif', 'tiff', 'ico'].includes(ext)) return FileImage
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return FileVideo
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a'].includes(ext)) return FileAudio
  return FileIcon
}

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
 * unsupported=true면 lib가 렌더를 포기한 자리 표시자다.
 */
function findAnchorEl(
  container: HTMLElement,
  kind: OleAnchorKind,
  entry: OleEmbeddingRef,
): { el: Element; unsupported: boolean } | null {
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
          if (alt && names.has(alt)) return { el, unsupported: false }
        } catch {
          /* 무시 */
        }
      }
      // 구형 sp 박스 (네이티브 ole sp / 게이트 파일).
      for (const el of all) {
        try {
          if ((el.className?.toString?.() ?? '').includes('xg-obj-unsupported') && isVis(el))
            return { el, unsupported: true }
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
          if (eid.includes('-frame-') && /download/i.test(el.textContent ?? '') && isVis(el))
            return { el, unsupported: false }
        } catch {
          /* 무시 */
        }
      }
      return null
    }
    for (const el of all) {
      try {
        if (el.hasAttribute?.('data-docx-ole') && isVis(el)) return { el, unsupported: false }
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
  parentPath,
}: {
  data: ArrayBuffer | Uint8Array
  anchor?: OleAnchorKind
  /** C5-4: 첨부 편집 URL에 필요한 부모 식별자 (없으면 다운로드만). */
  parentPath?: string
}) {
  const [entries, setEntries] = useState<OleEmbeddingRef[]>([])
  // 앵커 사각형 + lib placeholder 여부 (placeholder면 미리보기 카드로 덮는다).
  const [posMap, setPosMap] = useState<
    Record<string, { x: number; y: number; w: number; h: number; cover: boolean }>
  >({})
  const rootRef = useRef<HTMLDivElement | null>(null)
  // P0-3: 팝업 차단 시 대체 링크를 보여준다 (조용한 무응답 금지).
  const [popupBlockedUrl, setPopupBlockedUrl] = useState<string | null>(null)

  useEffect(() => {
    let dead = false
    setEntries([])
    // 표시명까지 한 번에 해석된다 (zip 단일 로드 — 대용량 이중 로드 방지).
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
        const next: Record<string, { x: number; y: number; w: number; h: number; cover: boolean }> = {}
        for (const entry of entries) {
          const hit = findAnchorEl(container, anchor, entry)
          if (!hit) continue
          const r = hit.el.getBoundingClientRect()
          next[entry.partName] = {
            x: Math.max(0, Math.round(r.left - c.left)),
            y: Math.max(0, Math.round(r.top - c.top)),
            w: Math.max(0, Math.round(r.width)),
            h: Math.max(0, Math.round(r.height)),
            // lib가 렌더를 포기한 자리(xg-obj-unsupported)는 카드로 덮는다.
            cover: hit.unsupported,
          }
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

  /**
   * C5-3: 더블클릭 동작 — package 오피스면 편집기, pdf면 새 탭 미리보기, 나머지는 다운로드.
   * (앵커/폴백 구분 없음 — C5-2 INSERT분도 package면 편집기로 열린다. P2-1/P2-3의
   * 다운로드 단언은 바이트 보존 단언으로 전환한다.)
   */
  const openKind = (entry: OleEmbeddingRef): 'edit' | 'preview' | 'download' => {
    if (!parentPath || entry.relType !== 'package') return 'download'
    const name = displayName(entry)
    if (attachmentKindOf(name)) return 'edit'
    if (/\.pdf$/i.test(name)) return 'preview'
    return 'download'
  }

  const previewPdf = (entry: OleEmbeddingRef): void => {
    let win: Window | null = null
    // P0-3: 팝업 차단을 먼저 감지하려고 빈 탭을 동기로 연다 (openInNewTab이 opener를 끊는다).
    win = openInNewTab('about:blank')
    if (!win) {
      void download(entry)
      return
    }
    void (async () => {
      try {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
        const zip = await JSZip.loadAsync(bytes)
        const file = zip.files[entry.partName]
        if (!file) throw new Error('missing part')
        const raw = new Uint8Array(await file.async('uint8array'))
        const url = URL.createObjectURL(new Blob([raw as unknown as BlobPart], { type: 'application/pdf' }))
        if (win && !win.closed) {
          win.location.href = url
          window.setTimeout(() => {
            try {
              URL.revokeObjectURL(url)
            } catch {
              /* 무시 */
            }
          }, 60000)
          return
        }
        // 팝업 차단 → 다운로드로 폴백.
        saveBlob(displayName(entry), raw)
      } catch {
        try {
          if (win && !win.closed) win.close()
        } catch {
          /* 무시 */
        }
        await download(entry)
      }
    })()
  }

  const openOrDownload = (entry: OleEmbeddingRef): void => {
    const kind = openKind(entry)
    if (kind === 'download' || !parentPath) {
      void download(entry)
      return
    }
    if (kind === 'preview') {
      previewPdf(entry)
      return
    }
    const name = displayName(entry)
    const attachKind = attachmentKindOf(name)
    if (!attachKind) {
      void download(entry)
      return
    }
    // C5-4 (D64) + P0-3: 첨부 편집은 /edit/<부모>/-/<파트> 새 탭에서.
    // 팝업 차단을 피하려고 클릭 핸들러 안에서 동기로 연다.
    const url = editUrlForAttachment(parentPath, entry.partName)
    const w = openInNewTab(url)
    if (w) {
      setPopupBlockedUrl(null)
    } else {
      setPopupBlockedUrl(url)
      showToast.error('새 탭이 차단되었습니다 — 링크로 직접 열어주세요')
    }
  }

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
      title={displayName(entry)}
      aria-label={`첨부 ${displayName(entry)}`}
      draggable={false}
      onDoubleClick={() => void openOrDownload(entry)}
      onDragStart={(e) => {
        // 아이콘 드래그는 무시한다 (도형 이동은 lib 도형에서).
        e.preventDefault()
      }}
      style={anchored && pos ? { left: pos.x, top: pos.y, position: 'absolute' } : undefined}
      className={
        anchored
          ? 'z-20 inline-flex h-7 w-7 select-none items-center justify-center rounded-md border border-border bg-background/95 text-foreground shadow-sm hover:bg-muted'
          : 'inline-flex select-none items-center gap-1.5 rounded-md border border-border bg-background/95 px-2 py-1 text-xs text-foreground shadow-sm hover:bg-muted'
      }
    >
      <Paperclip className="h-3.5 w-3.5" />
      {!anchored && <span className="max-w-44 truncate select-none">{displayName(entry)}</span>}
    </button>
  )

  const anchored = entries.filter((e) => anchor != null && posMap[e.partName] != null)
  const fallback = entries.filter((e) => !(anchor != null && posMap[e.partName] != null))
  const displayName = (entry: OleEmbeddingRef): string => entry.displayName ?? entry.fallbackName

  // 아이콘 바로 아래 가운데 정렬 파일명 라벨 (표시 전용 — 클릭을 막지 않는다).
  const caption = (entry: OleEmbeddingRef, pos: { x: number; y: number; w: number; h: number }): React.ReactNode => {
    const name = displayName(entry)
    return (
      <div
        key={entry.partName}
        data-testid="ole-label"
        title={name}
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: pos.x + pos.w / 2,
          top: pos.y + pos.h + 4,
          transform: 'translateX(-50%)',
          maxWidth: 240,
        }}
        className="pointer-events-none z-10 select-none whitespace-nowrap overflow-hidden text-ellipsis rounded border border-border bg-background px-1.5 py-0.5 text-[11px] leading-5 text-foreground shadow-sm"
      >
        {name}
      </div>
    )
  }

  // lib placeholder를 덮는 세로형 카드 (표시 전용 — 영역을 벗어나지 않는다).
  // pointer-events-none: lib 도형 드래그(S1)를 막지 않는다. 다운로드는 모서리 아이콘으로.
  const coverCard = (
    entry: OleEmbeddingRef,
    pos: { x: number; y: number; w: number; h: number },
  ): React.ReactNode => {
    const name = displayName(entry)
    const Icon = iconForFile(name)
    return (
      <div
        key={entry.partName}
        data-testid="ole-cover"
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: pos.x,
          top: pos.y,
          width: Math.max(pos.w, 1),
          minHeight: Math.max(pos.h, 1),
        }}
        className="pointer-events-none z-10 flex select-none flex-col items-center justify-center gap-0.5 rounded-md border border-border bg-background px-1 py-1 shadow-sm"
      >
        <Icon className="h-6 w-6 shrink-0 text-muted-foreground" />
        <span data-testid="ole-label" title={name} className="max-w-full truncate text-center text-[11px] font-medium leading-4 text-foreground">
          {name}
        </span>
      </div>
    )
  }

  return (
    <>
      {/* 앵커 탐색용 기준점 (위치는 잡지 않는다). */}
      <div ref={rootRef} className="pointer-events-none absolute left-2 top-2" aria-hidden="true" />
      {popupBlockedUrl && (
        <div
          data-testid="edit-popup-blocked"
          className="absolute left-2 top-2 z-30 flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-foreground shadow-sm"
        >
          새 탭이 차단됨
          <a data-testid="edit-popup-blocked-link" href={popupBlockedUrl} target="_blank" rel="noopener" className="underline font-medium">
            직접 열기
          </a>
        </div>
      )}
      {anchored.map((e) => {
        const pos = posMap[e.partName]
        if (!pos) return null
        // placeholder는 카드로 가리고 모서리 아이콘으로 조작한다 (드래그 차단 방지).
        if (pos.cover) {
          return (
            <span key={e.partName}>
              {coverCard(e, pos)}
              {chip(e, true, { x: pos.x, y: pos.y })}
            </span>
          )
        }
        return (
          <span key={e.partName}>
            {chip(e, true, { x: pos.x, y: pos.y })}
            {caption(e, pos)}
          </span>
        )
      })}
      {fallback.length > 0 && (
        <div className="absolute left-2 top-2 z-20 flex flex-col items-start gap-1">
          {fallback.map((e) => chip(e, false))}
        </div>
      )}
    </>
  )
}
