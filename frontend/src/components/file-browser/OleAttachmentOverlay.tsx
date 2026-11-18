import { useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import {
  Download,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
} from 'lucide-react'
import { extractOleAttachment } from '@/lib/oleExtract'
import { listOleEmbeddings, looksLikeCfb, type OleEmbeddingRef } from '@/lib/oleAttachments'
import { findOleEntryAtPoint } from '@/lib/oleHitTest'
import { frameFileNames, entryNameHit, textContainsName, progIdOfText, extOf, OLE_PROG_EXT } from '@/lib/oleMatch'
import { SWAP_FAILED_ATTR, SWAPPED_ATTR, shouldSwapOleImg, mergePosMap } from '@/lib/oleSwapGuard'
import { deepCollect, observeDeep } from '@/lib/domDeep'
import { API_BASE_URL } from '@/config'
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

/** 첨부 종류별 색 (pptx 임베딩 미리보기와 동일: docx 파랑, xlsx 초록, pptx 주황). */
function kindColorForFile(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  if (['doc', 'docx', 'rtf', 'odt', 'hwp', 'hwpx', 'txt', 'md', 'pdf'].includes(ext)) return '#2563eb'
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return '#16a34a'
  if (['ppt', 'pptx', 'odp', 'key'].includes(ext)) return '#ea580c'
  return '#64748b'
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

/** C7: 백그라운드 삽입 칩 (리로드 없이 명시 위치에 표시). */
export interface OleExtraAttachment {
  part: string
  name: string
  kind: OleAnchorKind
  pos: {
    slide?: number
    x?: number
    y?: number
    w?: number
    h?: number
    sheet?: number
    col?: number
    row?: number
    block?: number
    text?: string
  }
}

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

/** lib 도형 텍스트에서 progId를 읽는다. */
function progIdOf(el: Element): string {
  const t = `${el.getAttribute?.('alt') ?? ''} ${el.getAttribute?.('title') ?? ''} ${el.textContent ?? ''}`
  return progIdOfText(t)
}

/**
 * 컨테이너 안에서 lib가 그린 첨부 도형을 찾는다 (없으면 null).
 * - xlsx: ole pic (img alt = cNvPr 이름) 우선, 없으면 구형 sp 박스.
 * - pptx: data-element-id "...-frame-N" + Download 문구 + 항목 파일명 매칭
 *   (매칭 실패 때만 첫 프레임 폴백 — 여러 임베딩 대응, C6d).
 * - docx: span[data-docx-ole] 또는 span.dve-ole-placeholder + 파일명/progId 매칭.
 * unsupported=true면 lib가 렌더를 포기한 자리 표시자다.
 */
export function findAnchorEl(
  container: HTMLElement,
  kind: OleAnchorKind,
  entry: OleEmbeddingRef,
  claimed?: Set<Element>,
  exactOnly?: boolean,
): { el: Element; unsupported: boolean } | null {
  const taken = (el: Element): boolean => {
    try {
      return !!claimed?.has(el)
    } catch {
      return false
    }
  }
  try {
    const all = deepCollect(container)
    if (kind === 'xlsx') {
      const names = new Set([entry.fallbackName, stemOf(entry.fallbackName)])
      for (const el of all) {
        try {
          if (!(el.className?.toString?.() ?? '').includes('xg-obj')) continue
          if (!isVis(el) || taken(el)) continue
          const img = el.tagName === 'IMG' ? el : el.querySelector?.('img')
          const alt = img?.getAttribute?.('alt') ?? ''
          if (alt && names.has(alt)) return { el, unsupported: false }
        } catch {
          /* 무시 */
        }
      }
      // 구형 sp 박스 (네이티브 ole sp / 게이트 파일). exact 모드에서는 건너뛴다.
      if (!exactOnly) {
        for (const el of all) {
          try {
            if ((el.className?.toString?.() ?? '').includes('xg-obj-unsupported') && isVis(el) && !taken(el))
              return { el, unsupported: true }
          } catch {
            /* 무시 */
          }
        }
      }
      return null
    }
    if (kind === 'pptx') {
      // 1차: 파일명이 들어간 Download 프레임 (항목별 매칭).
      // frameFileNames 추출 + 전체 텍스트 포함 매칭 (WORD 접두사 등 변형 대응).
      for (const el of all) {
        try {
          const eid = el.getAttribute?.('data-element-id') ?? ''
          if (!eid.includes('-frame-') || !isVis(el) || taken(el)) continue
          const text = el.textContent ?? ''
          if (!/download/i.test(text)) continue
          if (frameFileNames(text).some((ff) => entryNameHit(ff, entry, exactOnly)) || textContainsName(text, entry)) return { el, unsupported: false }
        } catch {
          /* 무시 */
        }
      }
      // 2차: Download 프레임이 정확히 1개일 때만 (여러 개면 엉뚱한 도형에 붙는다).
      // exact 모드에서는 건너뛴다 (퍼지 패스에서 처리).
      if (!exactOnly) {
        try {
          const frames: Element[] = []
          for (const el of all) {
            try {
              const eid = el.getAttribute?.('data-element-id') ?? ''
              if (eid.includes('-frame-') && /download/i.test(el.textContent ?? '') && isVis(el) && !taken(el)) frames.push(el)
            } catch {
              /* 무시 */
            }
          }
          if (frames.length === 1 && frames[0]) return { el: frames[0], unsupported: false }
        } catch {
          /* 무시 */
        }
      }
      return null
    }
    const oleSel = (el: Element): boolean => {
      try {
        const c = el.className?.toString?.() ?? ''
        return el.hasAttribute?.('data-docx-ole') === true || (el.tagName === 'SPAN' && c.includes('dve-ole-placeholder'))
      } catch {
        return false
      }
    }
    // 1차: 파일명이 들어간 ole 자리 (에디터/뷰어 렌더 공통).
    for (const el of all) {
      try {
        if (!oleSel(el) || !isVis(el) || taken(el)) continue
        const hay = `${el.getAttribute?.('alt') ?? ''} ${el.getAttribute?.('title') ?? ''} ${el.textContent ?? ''}`
        if (frameFileNames(hay).some((ff) => entryNameHit(ff, entry, exactOnly)) || textContainsName(hay, entry)) return { el, unsupported: false }
      } catch {
        /* 무시 */
      }
    }
    if (exactOnly) return null
    // 2차: progId 확장자가 항목 확장자와 같은 자리.
    const wantExt = extOf(entry.displayName ?? entry.fallbackName)
    if (wantExt && wantExt !== 'bin') {
      for (const el of all) {
        try {
          if (!oleSel(el) || !isVis(el) || taken(el)) continue
          if (OLE_PROG_EXT[progIdOf(el)] === wantExt) return { el, unsupported: false }
        } catch {
          /* 무시 */
        }
      }
    }
    // 3차: data-docx-ole 자리가 정확히 1개일 때만 (여러 개면 엉뚱한 곳에 붙는다).
    try {
      const oles: Element[] = []
      for (const el of all) {
        try {
          if (el.hasAttribute?.('data-docx-ole') && isVis(el) && !taken(el)) oles.push(el)
        } catch {
          /* 무시 */
        }
      }
      if (oles.length === 1 && oles[0]) return { el: oles[0], unsupported: false }
    } catch {
      /* 무시 */
    }
    return null
  } catch {
    return null
  }
}

/**
 * lib OLE 도형 안의 아이콘 <img>를 우리 미리보기로 바꾼다 (C7j, C7m 유지 결정).
 * - lib 네이티브 렌더(리사이즈·선택 그대로 둠) + 우리 아이콘(종류별 색상).
 * - 큰 아이콘만 교체 (작은 뱃지·인디케이터는 lib 것 유지).
 * - 실패하면 원복 + 실패 표식 (깨진 이미지 방지 + 재swap 루프 방지, D35).
 * - 멱등 (이미 우리 URL이면 스킵, 표식 있으면 스킵).
 */
function swapOleIcon(root: Element, iconUrl: string): void {
  try {
    const all: Element[] = []
    const walk = (node: Element | ShadowRoot): void => {
      let els: Element[] = []
      try {
        els = [...(node as Element).querySelectorAll('*')]
      } catch {
        return
      }
      for (const e of els) {
        all.push(e)
        try {
          const sr = (e as unknown as { shadowRoot?: ShadowRoot | null }).shadowRoot
          if (sr) walk(sr)
        } catch {
          /* 무시 */
        }
      }
    }
    walk(root)
    for (const e of all) {
      try {
        if ((e as HTMLElement).tagName !== 'IMG') continue
        const img = e as unknown as HTMLImageElement
        // C7m 1-a: 실패·교체됨 표식이 있으면 손대지 않는다 (같은 요소 반복 swap 금지).
        // lib이 img를 다시 그리면 새 요소라 표식이 없어 1회 swap된다 (정상 동작).
        let failed = false
        let swapped = false
        try {
          failed = img.hasAttribute(SWAP_FAILED_ATTR)
          swapped = img.hasAttribute(SWAPPED_ATTR)
        } catch {
          continue
        }
        if (!shouldSwapOleImg(img.currentSrc || img.src || '', failed, swapped)) continue
        const r = (e as HTMLElement).getBoundingClientRect()
        if (r.width < 24 || r.height < 24) continue
        const cur = img.currentSrc || img.src || ''
        const orig = img.getAttribute('data-orig-src') ?? cur
        try {
          img.setAttribute('data-orig-src', orig)
        } catch {
          /* 무시 */
        }
        try {
          img.onerror = () => {
            try {
              img.setAttribute(SWAP_FAILED_ATTR, '1')
              const back = img.getAttribute('data-orig-src')
              if (back) img.src = back
            } catch {
              /* 무시 */
            }
          }
        } catch {
          /* 무시 */
        }
        try {
          img.setAttribute(SWAPPED_ATTR, '1')
        } catch {
          /* 무시 */
        }
        img.src = iconUrl
      } catch {
        /* 무시 */
      }
    }
  } catch {
    /* 무시 */
  }
}

/**
 * 도형 아래 파일명 캡션(pointer-events:none이라 lib 캔버스로 떨어진다) 위인지
 * 실측 박스로 판정한다. 커버 안 라벨은 도형 rect로 잡히므로 제외한다.
 */
function captionPartAt(container: HTMLElement, entries: OleEmbeddingRef[], x: number, y: number): string | null {
  let labels: NodeListOf<Element>
  try {
    labels = container.querySelectorAll('[data-testid="ole-label"]')
  } catch {
    return null
  }
  const c = container.getBoundingClientRect()
  for (const el of Array.from(labels)) {
    try {
      const e = el as HTMLElement
      if (e.closest('[data-testid="ole-cover"]')) continue
      const r = e.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) continue
      const lx = r.left - c.left
      const ly = r.top - c.top
      if (x < lx || x > lx + r.width || y < ly || y > ly + r.height) continue
      const title = e.getAttribute('title') ?? e.textContent ?? ''
      const name = title.trim()
      if (!name) continue
      const hit = entries.find((en) => {
        const dn = en.displayName ?? en.fallbackName
        return dn === name || dn.includes(name) || name.includes(dn)
      })
      if (hit) return hit.partName
    } catch {
      /* 다음 라벨 */
    }
  }
  return null
}

/**
 * C5-1 후속 S2 + C5-2: 기존 OLE 첨부 오버레이를 lib 도형 위에 앵커한다.
 * - 항목마다 도형 위에 작은 아이콘 (hover → 파일명, dblclick → 열기/다운로드).
 * - C6b: pptx는 lib 도형 본문 dblclick도 컨테이너 캡처에서 연다 (lib no-op).
 * - 앵커가 없으면 좌상단 이름 칩 (폴백).
 * - 아이콘 드래그는 무시한다 (도형 이동은 lib 도형에서).
 */

/** C7: 백그라운드 삽입 칩의 명시 위치 해석 (lib에 아직 없는 파트용). */
/** C7e: lib 슬라이드 rect (16:9/4:3 paper). fractions→px 기준을 viewerRoot가 아니라 슬라이드로 잡는다. */
export function findSlideRect(container: HTMLElement | null): { x: number; y: number; width: number; height: number } | null {
  try {
    if (!container) return null
    const cands = Array.from(container.querySelectorAll('div.shadow-2xl')) as HTMLElement[]
    let best: HTMLElement | null = null
    let bestArea = 0
    for (const el of cands) {
      let r: DOMRect | null = null
      try {
        r = el.getBoundingClientRect()
      } catch {
        continue
      }
      if (!r || r.width < 200 || r.height < 150) continue
      const ar = r.width / Math.max(1, r.height)
      if (ar < 1.2 || ar > 2.0) continue
      const area = r.width * r.height
      if (area > bestArea) {
        bestArea = area
        best = el
      }
    }
    if (!best) return null
    const b = best.getBoundingClientRect()
    const cb = container.getBoundingClientRect()
    return { x: b.left - cb.left, y: b.top - cb.top, width: b.width, height: b.height }
  } catch {
    return null
  }
}

function resolveExtraPos(
  container: HTMLElement,
  anchor: OleAnchorKind,
  ex: OleExtraAttachment,
  ctx: { slide?: number; sheet?: number } | undefined,
  captionH: number,
): { x: number; y: number; w: number; h: number; cover: boolean; captionAbove?: boolean } | null {
  try {
    const c = container.getBoundingClientRect()
    if (c.width <= 0 || c.height <= 0) return null
    const above = (y: number, h: number): boolean => y + h + captionH > c.height && y - captionH >= 0
    if (anchor === 'pptx') {
      if (ex.pos.slide == null || ctx?.slide == null || ex.pos.slide !== ctx.slide) return null
      if (typeof ex.pos.x !== 'number' || typeof ex.pos.y !== 'number') return null
      // C7e: 실제 도형 크기 (fractions). 없으면 표준 슬라이드 기준 기본값 (서버가 준 w/h 우선).
      const wFrac = typeof ex.pos.w === 'number' && ex.pos.w > 0 ? ex.pos.w : 1296000 / 12192000
      const hFrac = typeof ex.pos.h === 'number' && ex.pos.h > 0 ? ex.pos.h : 648000 / 6858000
      // C7f: fractions→px 기준은 슬라이드 rect (viewer 전체가 아님 — 브라우저마다 레이아웃이 달라도 같은 자리).
      const sr = findSlideRect(container)
      const bx = sr ? sr.x : 0
      const by = sr ? sr.y : 0
      const bw = sr && sr.width > 0 ? sr.width : c.width
      const bh = sr && sr.height > 0 ? sr.height : c.height
      const w = Math.max(8, Math.round(wFrac * bw))
      const h = Math.max(8, Math.round(hFrac * bh))
      const x = Math.round(bx + ex.pos.x * bw)
      const y = Math.round(by + ex.pos.y * bh)
      return { x, y, w, h, cover: false, captionAbove: above(y, h) }
    }
    if (anchor === 'xlsx') {
      if (ex.pos.sheet == null || ctx?.sheet == null || ex.pos.sheet !== ctx.sheet) return null
      if (typeof ex.pos.col !== 'number' || typeof ex.pos.row !== 'number') return null
      const ed = container.querySelector('xlsx-editor') as unknown as { shadowRoot?: ShadowRoot | null } | null
      const sr = ed?.shadowRoot
      if (!sr) return null
      const cells = (sr as unknown as Element).querySelector('.xg-cells') as unknown as {
        getBoundingClientRect: () => DOMRect
        scrollLeft?: number
        scrollTop?: number
        querySelector: (s: string) => Element | null
      } | null
      if (!cells) return null
      const gr = cells.getBoundingClientRect()
      let cellW = 64
      let cellH = 20
      try {
        const sample = cells.querySelector('.xg-c') as unknown as { getBoundingClientRect: () => DOMRect } | null
        if (sample) {
          const r = sample.getBoundingClientRect()
          if (r.width > 4 && r.height > 4) {
            cellW = r.width
            cellH = r.height
          }
        }
      } catch {
        /* 무시 */
      }
      const sl = typeof cells.scrollLeft === 'number' ? cells.scrollLeft : 0
      const st = typeof cells.scrollTop === 'number' ? cells.scrollTop : 0
      const x = Math.round(gr.left - c.left + ex.pos.col * cellW - sl)
      const y = Math.round(gr.top - c.top + ex.pos.row * cellH - st)
      const w = Math.round(cellW * 1.5)
      const h = Math.round(cellH * 2.5)
      if (x + w < 0 || y + h < 0 || x > c.width || y > c.height) return null
      return { x, y, w, h, cover: false, captionAbove: above(y, h) }
    }
    // docx: 문단 텍스트 힌트 우선, 없으면 블록 인덱스.
    const ed = container.querySelector('docx-editor') as unknown as { shadowRoot?: ShadowRoot | null } | null
    const sr = ed?.shadowRoot
    if (!sr) return null
    const paras = Array.from((sr as unknown as Element).querySelectorAll('p')) as HTMLElement[]
    // innerText에 lib 렌더 잔재가 섞이므로 정규화 후 서로 포함이면 같은 문단.
    const norm = (t: string): string => t.replace(/\s+/g, ' ').trim()
    const matches = (a: string, b: string): boolean => {
      const na = norm(a)
      const nb = norm(b)
      if (na.length < 8 || nb.length < 8) return false
      return na.includes(nb) || nb.includes(na)
    }
    let target: HTMLElement | null = null
    if (typeof ex.pos.text === 'string' && ex.pos.text.length > 0) {
      target = paras.find((p) => matches(p.innerText ?? '', ex.pos.text!)) ?? null
    }
    if (!target && typeof ex.pos.block === 'number') {
      target = paras[ex.pos.block] ?? null
    }
    if (!target) return null
    const r = target.getBoundingClientRect()
    if (r.width <= 0 && r.height <= 0) return null
    return {
      x: Math.max(0, Math.round(r.left - c.left)),
      y: Math.max(0, Math.round(r.top - c.top)),
      w: 96,
      h: 48,
      cover: false,
      captionAbove: above(Math.max(0, Math.round(r.top - c.top)), 48),
    }
  } catch {
    return null
  }
}
/** C7e: pptx 실제 아이콘 (<img> 오버레이).
 * - 클릭(클립존): 다운로드 / 클릭(그 외): 선택(리사이즈 가능) / 더블클릭: 열기 / 드래그: 이동.
 * - 클립존 = 좌상단 (우리 PNG의 클립 배지 자리, x<0.3 && y<0.45). */
function PptxImgEntry({
  entry,
  pos,
  iconUrl,
  onMove,
  onResize,
  onDownloadFile,
  onOpen,
  selected,
  onSelect,
}: {
  entry: OleEmbeddingRef
  pos: { x: number; y: number; w: number; h: number }
  iconUrl: string
  onMove?: (part: string, p: { x: number; y: number }) => void
  onResize?: (part: string, s: { w: number; h: number }) => void
  onDownloadFile: (entry: OleEmbeddingRef) => void
  onOpen: (entry: OleEmbeddingRef) => void
  selected: boolean
  onSelect: (part: string | null) => void
}): React.ReactNode {
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)
  const resizeRef = useRef<{ sx: number; sy: number; ow: number; oh: number; moved: boolean } | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const containerOf = (el: Element | null): HTMLElement | null => {
    try {
      const r = (el as HTMLElement | null)?.closest?.('[data-testid="pptx-viewer-root"]') as HTMLElement | null
      return r
    } catch {
      return null
    }
  }
  useEffect(() => {
    const onUp = (e: PointerEvent): void => {
      const d = dragRef.current
      const r = resizeRef.current
      const box = boxRef.current
      const cont = containerOf(box)
      // C7f: fractions 변환 기준은 슬라이드 rect (없으면 컨테이너 폴백).
      const sr = cont ? findSlideRect(cont) : null
      const cb = cont ? cont.getBoundingClientRect() : null
      const baseX = sr ? sr.x : 0
      const baseY = sr ? sr.y : 0
      const baseW = sr && sr.width > 0 ? sr.width : cb?.width ?? 1
      const baseH = sr && sr.height > 0 ? sr.height : cb?.height ?? 1
      if (d && cont) {
        const dx = e.clientX - d.sx
        const dy = e.clientY - d.sy
        if (Math.hypot(dx, dy) < 5 && !d.moved) {
          // C7g-3: 한 번 클릭은 선택만 (즉시, 타이머 없음). 더블클릭은 열기.
          onSelect(entry.partName)
        } else if (onMove && baseW > 0 && baseH > 0) {
          // d.ox/oy는 컨테이너 기준 px → 슬라이드 기준 fractions로 변환.
          const nx = (d.ox - baseX + dx) / Math.max(1, baseW)
          const ny = (d.oy - baseY + dy) / Math.max(1, baseH)
          onMove(entry.partName, { x: Math.min(1, Math.max(0, nx)), y: Math.min(1, Math.max(0, ny)) })
        }
        setDrag(null)
      }
      if (r && box && cont) {
        const dx = e.clientX - r.sx
        const dy = e.clientY - r.sy
        if ((r.moved || Math.hypot(dx, dy) >= 5) && onResize && baseW > 0 && baseH > 0) {
          onResize(entry.partName, {
            w: Math.min(1, Math.max(0.02, (r.ow + dx) / baseW)),
            h: Math.min(1, Math.max(0.02, (r.oh + dy) / baseH)),
          })
        }
        setSize(null)
      }
      dragRef.current = null
      resizeRef.current = null
    }
    const onMoveWin = (e: PointerEvent): void => {
      if (dragRef.current) {
        const dx = e.clientX - dragRef.current.sx
        const dy = e.clientY - dragRef.current.sy
        if (Math.hypot(dx, dy) >= 5) dragRef.current.moved = true
        setDrag({ dx, dy })
      }
      if (resizeRef.current) {
        const dx = e.clientX - resizeRef.current.sx
        const dy = e.clientY - resizeRef.current.sy
        if (Math.hypot(dx, dy) >= 5) resizeRef.current.moved = true
        setSize({ w: Math.max(8, resizeRef.current.ow + dx), h: Math.max(8, resizeRef.current.oh + dy) })
      }
    }
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointermove', onMoveWin)
    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointermove', onMoveWin)
    }
  }, [entry, onMove, onResize, onOpen, onSelect])
  const w = size?.w ?? pos.w
  const h = size?.h ?? pos.h
  const x = pos.x + (drag?.dx ?? 0)
  const y = pos.y + (drag?.dy ?? 0)
  return (
    <div
      ref={boxRef}
      data-testid="ole-icon"
      title={entry.displayName ?? entry.fallbackName}
      aria-label={`첨부 ${entry.displayName ?? entry.fallbackName}`}
      style={{ position: 'absolute', left: x, top: y, width: Math.max(8, w), height: Math.max(8, h), transform: 'translate(-50%, -50%)', zIndex: 30, touchAction: 'none', cursor: 'move', outline: selected ? '2px solid #2563eb' : 'none', outlineOffset: 2 }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false }
      }}
      onDoubleClick={(e) => {
        // 한 번 클릭은 선택(무해) 후 열기. 타이머 없음.
        e.preventDefault()
        e.stopPropagation()
        try { onOpen(entry) } catch { /* 무시 */ }
      }}
    >
      <img
        data-testid="ole-img"
        src={iconUrl}
        alt=""
        draggable={false}
        style={{ width: '100%', height: '100%', display: 'block', pointerEvents: 'none', userSelect: 'none' }}
      />
      {selected && (
        <button
          type="button"
          data-testid="ole-download"
          title={`다운로드: ${entry.displayName ?? entry.fallbackName}`}
          aria-label={`다운로드 ${entry.displayName ?? entry.fallbackName}`}
          style={{ position: 'absolute', left: -6, top: -6, width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: '#fff', border: '1px solid #94a3b8', borderRadius: 4, zIndex: 32 }}
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            try { onDownloadFile(entry) } catch { /* 무시 */ }
          }}
          onDoubleClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      )}
      {selected && onResize && (
        <div
          data-testid="ole-resize"
          title="크기 조절"
          style={{ position: 'absolute', right: -6, bottom: -6, width: 14, height: 14, cursor: 'nwse-resize', background: '#fff', border: '1px solid #94a3b8', borderRadius: 3 }}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.preventDefault()
            e.stopPropagation()
            resizeRef.current = { sx: e.clientX, sy: e.clientY, ow: w, oh: h, moved: false }
          }}
        />
      )}
      {/* C7e: 파일명 라벨 (img와 한 덩이 — 절대 따로 안 떨어진다). */}
      <div
        data-testid="ole-label"
        title={entry.displayName ?? entry.fallbackName}
        style={{
          position: 'absolute',
          left: '50%',
          top: '100%',
          marginTop: 4,
          transform: 'translateX(-50%)',
          maxWidth: 240,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          pointerEvents: 'none',
          userSelect: 'none',
          background: 'rgba(255,255,255,0.95)',
          border: '1px solid #e2e8f0',
          borderRadius: 4,
          padding: '1px 6px',
          fontSize: 11,
          lineHeight: '20px',
          color: '#0f172a',
        }}
      >
        {entry.displayName ?? entry.fallbackName}
      </div>
    </div>
  )
}

export default function OleAttachmentOverlay({
  data,
  anchor,
  parentPath,
  extras,
  getExtraContext,
  onMoveEmbed,
  onResizeEmbed,
  selectedPart: selectedPartProp,
  onSelectPart: onSelectPartProp,
  peerSelections: peerSelectionsProp,
}: {
  data: ArrayBuffer | Uint8Array
  anchor?: OleAnchorKind
  /** C5-4: 첨부 편집 URL에 필요한 부모 식별자 (없으면 다운로드만). */
  parentPath?: string
  /** C7: 백그라운드 삽입 칩 (리로드 없이 명시 위치에 표시). */
  extras?: OleExtraAttachment[]
  /** C7: extras 해석용 현재 위치 (슬라이드/시트). */
  getExtraContext?: () => { slide?: number; sheet?: number }
  /** C7e: pptx 도형 이동/리사이즈 (fractions). */
  onMoveEmbed?: (part: string, pos: { x: number; y: number }) => void
  onResizeEmbed?: (part: string, size: { w: number; h: number }) => void
  /** C7f: 선택 상태 (PptxViewer 제어; 없으면 내부 상태). */
  selectedPart?: string | null
  onSelectPart?: (part: string | null) => void
  /** C7f: 다른 탭의 선택 표시. */
  peerSelections?: Array<{ part: string; name: string; color: string }>
}) {
  const [parsed, setParsed] = useState<OleEmbeddingRef[]>([])
  // C7: 파싱분 + 백그라운드분 합집합 (칩·캡션·열기 모두 동일 처리).
  const entries = useMemo(() => {
    const out = [...parsed]
    for (const ex of extras ?? []) {
      if (out.some((e) => e.partName === ex.part)) continue
      out.push({ partName: ex.part, relType: 'package', fallbackName: ex.name, displayName: ex.name })
    }
    return out
  }, [parsed, extras])
  // 앵커 사각형 + lib placeholder 여부 (placeholder면 미리보기 카드로 덮는다).
  // captionAbove: 아래에 캡션이 안 들어가면 위로 뒤집는다 (컨테이너 밖으로 나가면
  // 캡처 리스너가 못 받는다).
  const [posMap, setPosMap] = useState<
    Record<string, { x: number; y: number; w: number; h: number; cover: boolean; captionAbove?: boolean; libClaimed?: boolean }>
  >({})
  // C7e: 선택된 첨부 (클릭 선택 → 리사이즈 핸들 표시, 배경 클릭 시 해제).
  // PptxViewer가 제어하면 그 값을 쓰고, 아니면 내부 상태 (xlsx/docx).
  const [internalSel, setInternalSel] = useState<string | null>(null)
  const selectedPart = selectedPartProp !== undefined ? selectedPartProp : internalSel
  const setSelectedPart = onSelectPartProp ?? setInternalSel
  // C7f: 다른 탭의 선택.
  const peerSels = peerSelectionsProp ?? []
  useEffect(() => {
    const onDown = (e: Event): void => {
      try {
        const t = e.target as HTMLElement | null
        // C7j: 다운로드 버튼 클릭은 선택 해제가 아니다 (capture 단계에서 먹히면
        // 버튼이 언마운트돼 클릭이 유실된다 — ole-icon 안이 아니어도 유지).
        if (t && typeof t.closest === 'function' && t.closest('[data-testid="ole-icon"],[data-testid="ole-resize"],[data-testid="ole-download"]')) return
        setSelectedPart(null)
      } catch {
        /* 무시 */
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [])
  const rootRef = useRef<HTMLDivElement | null>(null)
  // P0-3: 팝업 차단 시 대체 링크를 보여준다 (조용한 무응답 금지).
  const [popupBlockedUrl, setPopupBlockedUrl] = useState<string | null>(null)
  // C6b: 컨테이너 캡처 dblclick이 최신 값을 보도록 ref 거울 (리스너 재등록 없음).
  const posMapRef = useRef(posMap)
  posMapRef.current = posMap
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  // C6b: 최신 openOrDownload 거울 (아래 early return보다 먼저 선언해야 한다 —
  // 조건부 훅이 되면 React #310으로 깨진다).
  const openRef = useRef<((entry: OleEmbeddingRef) => void) | null>(null)

  useEffect(() => {
    let dead = false
    setParsed([])
    // 표시명까지 한 번에 해석된다 (zip 단일 로드 — 대용량 이중 로드 방지).
    void listOleEmbeddings(data).then((list) => {
      if (!dead) setParsed(list.slice(0, 8))
    })
    return () => {
      dead = true
    }
  }, [data])

  // 앵커 추적: 스크롤·리사이즈·DOM 변경 때 재계산 (폴링 없음).
  // CAPTION_PAD: 컨테이너 캡처 hit-test가 도형 rect 아래로 넓히는 폭 (캡션 영역).
  const CAPTION_PAD = 32
  // CAPTION_H: 캡션 박스 높이+간격. 아래에 안 들어가면 위로 뒤집는다
  // (컨테이너 밖으로 나가면 캡처 리스너가 못 받는다).
  const CAPTION_H = 30
  // C7: extras 해석용 컨텍스트 콜백 거울 (인라인 prop이어도 리스너 재등록 없음).
  const extraCtxRef = useRef(getExtraContext)
  extraCtxRef.current = getExtraContext
  const extrasRef = useRef(extras)
  extrasRef.current = extras
  useEffect(() => {
    if (!anchor || (entries.length === 0 && (extrasRef.current ?? []).length === 0)) {
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
        type PosEntry = { x: number; y: number; w: number; h: number; cover: boolean; captionAbove?: boolean; libClaimed?: boolean }
        const next: Record<string, PosEntry> = {}
        // 파싱분: lib 도형 위치.
        // C7: 백그라운드분은 여기서 건너뛰고 아래 명시 위치로만 둔다
        // (findAnchorEl의 첫 프레임 폴백이 엉뚱한 도형을 잡는 것을 방지).
        // C7j: 한 도형에 한 항목만 — exact 패스로 먼저 확정하고 남은 것만 fuzzy.
        // (report가 report-final 도형을 가로채는 오매칭 방지.)
        const extraParts = new Set((extrasRef.current ?? []).map((ex) => ex.part))
        const claimed = new Set<Element>()
        const assign = (entry: OleEmbeddingRef, hit: { el: Element; unsupported: boolean }): void => {
          claimed.add(hit.el)
          // C7j-2: lib 네이티브 아이콘을 우리 미리보기로 교체 (리사이즈·선택은 lib 그대로).
          if (parentPath) {
            try {
              const iconUrl = `${API_BASE_URL}/api/collab/embed/icon?path=${encodeURIComponent(parentPath)}&part=${encodeURIComponent(entry.partName)}`
              swapOleIcon(hit.el, iconUrl)
            } catch {
              /* 무시 */
            }
          }
          const r = hit.el.getBoundingClientRect()
          const y = Math.max(0, Math.round(r.top - c.top))
          const h = Math.max(0, Math.round(r.height))
          next[entry.partName] = {
            x: Math.max(0, Math.round(r.left - c.left)),
            y,
            w: Math.max(0, Math.round(r.width)),
            h,
            // lib가 렌더를 포기한 자리(xg-obj-unsupported)는 카드로 덮는다.
            cover: hit.unsupported,
            captionAbove: y + h + CAPTION_H > c.height && y - CAPTION_H >= 0,
            // C7m: lib 도형에서 위치를 잡았으면 lib-only 표시 대상이다.
            libClaimed: true,
          }
        }
        const pending: OleEmbeddingRef[] = []
        for (const entry of entries) {
          if (extraParts.has(entry.partName)) {
            // C7m: extras도 exact 매칭만 시도한다 (lib 도형이 있으면 lib-only로 전환).
            // 폴백은 쓰지 않는다 (엉뚱한 도형 포획 방지 — C7 유지).
            const exHit = findAnchorEl(container, anchor, entry, claimed, true)
            if (exHit) assign(entry, exHit)
            continue
          }
          const hit = findAnchorEl(container, anchor, entry, claimed, true)
          if (!hit) {
            pending.push(entry)
            continue
          }
          assign(entry, hit)
        }
        for (const entry of pending) {
          const hit = findAnchorEl(container, anchor, entry, claimed, false)
          if (!hit) continue
          assign(entry, hit)
        }
        // C7: 백그라운드분: 명시 위치 해석 (lib에 아직 없음).
        const ctx = (() => {
          try {
            return extraCtxRef.current?.()
          } catch {
            return undefined
          }
        })()
        for (const ex of extrasRef.current ?? []) {
          // 명시 위치가 있으면 lib 결과보다 우선한다 (최신 삽입 의도).
          // 단 lib claim이 성공했으면 lib 위치를 유지한다 (lib-only 표시).
          const p = resolveExtraPos(container, anchor, ex, ctx, CAPTION_H)
          if (p && !next[ex.part]?.libClaimed) next[ex.part] = { ...p, libClaimed: false }
        }
        // C7k: fully overlapping chips hide the lower one, so offset display only
        // (file position unchanged).
        // C7l-fix: applies to ALL incl. lib-anchored - real files can have
        // overlapping lib shapes (user screenshot). Singletons never move (n==0),
        // so no lib label drift.
        {
          const seenPos = new Map<string, number>()
          for (const key of Object.keys(next)) {
            const p = next[key]
            if (!p) continue
            const k = `${Math.round(p.x / 4) * 4},${Math.round(p.y / 4) * 4}`
            const n = seenPos.get(k) ?? 0
            seenPos.set(k, n + 1)
            if (n > 0) {
              p.x += n * 22
              p.y += n * 22
              p.captionAbove = p.y + p.h + CAPTION_H > c.height && p.y - CAPTION_H >= 0
            }
          }
        }

        // C7m 1-b: 동일값이면 이전 객체 유지 (D35 유휴 렌더 0회).
        setPosMap((prev) => mergePosMap(prev, next))
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

  /**
   * C6b: lib 캔버스의 OLE 도형 dblclick은 lib이 편집으로 연결하지 않으므로
   * 컨테이너 캡처에서 연다 (pptx 확인, xlsx/docx는 K-dbl에서 검증 — lib이
   * dblclick을 삼키면 여기서 열리지 않는다).
   * - 우리 칩은 자기 핸들러가 연다. lib 푸터 버튼/링크/입력/다이얼로그는 lib 동작 유지.
   * - posMap rect 안(도형 본문)일 때만 열고, 버블을 끊는다 (lib 텍스트 편집 방지).
   * - early return보다 앞에 둔다 (조건부 훅 React #310 방지).
   */
  useEffect(() => {
    if (!anchor) return
    const root = rootRef.current
    const container = root?.parentElement as HTMLElement | null
    if (!container) return
    const onDbl = (e: MouseEvent): void => {
      try {
        const t = e.target as HTMLElement | null
        if (!t || typeof t.closest !== 'function') return
        // C7m: 캡션 다운로드 버튼은 캡처 대상에서 뺀다 (버튼 dblclick으로 열리지 않게).
        // matches()는 svg 자식에 안 먹히므로 closest로 판정한다.
        try {
          if (t.closest('[data-testid="ole-download"]')) return
        } catch {
          /* 무시 */
        }
        const entries = entriesRef.current
        if (entries.length === 0) return
        const c = container.getBoundingClientRect()
        const px = e.clientX - c.left
        const py = e.clientY - c.top
        const directHit = typeof t.matches === 'function'
          && t.matches('button,a,input,select,textarea,[role="button"],[role="dialog"],[data-testid="ole-icon"]')
        const cap = !directHit ? captionPartAt(container, entries, px, py) : null
        // 캡션 위면 lib 동작보다 먼저 연다 (직접 interactive 요소를 두드린 경우 제외).
        if (cap && !directHit) {
          const capEntry = entries.find((en) => en.partName === cap)
          const capOpen = openRef.current
          if (capEntry && capOpen) {
            e.stopPropagation()
            e.preventDefault()
            capOpen(capEntry)
            return
          }
        }
        // lib 푸터 버튼/링크/입력/다이얼로그 + 우리 칩은 lib 동작을 유지한다.
        if (
          t.closest(
            '[data-testid="ole-icon"],button,a,input,select,textarea,[role="button"],[role="dialog"]'
          )
        )
          return
        // 도형 본문 dblclick → lib이 no-op이므로 여기서 연다.
        // rect 아래쪽에 캡션 높이만큼 패딩을 둔다 (근접 허용치).
        const part = findOleEntryAtPoint(posMapRef.current, px, py, CAPTION_PAD)
        if (!part) return
        const entry = entries.find((en) => en.partName === part)
        const open = openRef.current
        if (!entry || !open) return
        e.stopPropagation()
        e.preventDefault()
        open(entry)
      } catch {
        /* 무시 (lib 렌더는 그대로) */
      }
    }
    container.addEventListener('dblclick', onDbl, true)
    return () => {
      try {
        container.removeEventListener('dblclick', onDbl, true)
      } catch {
        /* 무시 */
      }
    }
    // entries가 비어 있으면 root가 렌더되지 않아 container를 못 찾으므로
    // entries 로드 뒤에도 다시 시도한다 (마운트 1회면 리스너가 안 붙는다).
  }, [anchor, entries])

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
    // C7e: 서버에서 최신 바이트로 받는다 (방금 삽입분은 로컬 zip에 없을 수 있음).
    if (parentPath) {
      try {
        const u = `${API_BASE_URL}/api/collab/embed?path=${encodeURIComponent(parentPath)}&part=${encodeURIComponent(entry.partName)}`
        const r = await fetch(u)
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; name?: string; data?: string }
        if (r.ok && j.ok && j.data) {
          const bin = Uint8Array.from(atob(j.data), (c) => c.charCodeAt(0))
          saveBlob(j.name ?? displayName(entry), bin)
          return
        }
      } catch {
        /* 폴백: 로컬 zip */
      }
    }
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

  // C6b: 최신 openOrDownload 거울 (컨테이너 캡처 리스너에서 쓴다).
  // openOrDownload는 아래 early return 뒤에 정의되므로 여기서 대입한다.
  openRef.current = openOrDownload

  const chip = (
    entry: OleEmbeddingRef,
    anchored: boolean,
    pos: { x: number; y: number } | undefined,
    opts?: { selected?: boolean; onSelect?: (part: string | null) => void },
  ): React.ReactNode => {
    const Icon = iconForFile(displayName(entry))
    const badgeColor = kindColorForFile(displayName(entry))
    const isSel = !!opts?.selected
    return (
    <span
      // C7m: key는 바깥 span이 partName으로 이미 단다. 여기서 같은 key를 또 달면
      // 형제 중복 key가 돼 자식이 복제/누락된다 (React 경고 + 중복 표시).
      style={anchored && pos ? { left: pos.x, top: pos.y, position: 'absolute', zIndex: 30, transform: 'translate(-50%, -50%)' } : undefined}
      className="inline-flex items-center gap-1"
    >
    <button
      type="button"
      data-testid="ole-icon"
      title={displayName(entry)}
      aria-label={`첨부 ${displayName(entry)}`}
      draggable={false}
      // C7g-3: 한 번 클릭은 선택만 (즉시, 타이머 없음). 더블클릭은 열기.
      onClick={() => {
        try { opts?.onSelect?.(entry.partName) } catch { /* 무시 */ }
      }}
      onDoubleClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        try { void openOrDownload(entry) } catch { /* 무시 */ }
      }}
      onDragStart={(e) => {
        // 아이콘 드래그는 무시한다 (도형 이동은 lib 도형에서).
        e.preventDefault()
      }}
      style={isSel ? { outline: '2px solid #2563eb', outlineOffset: 2 } : undefined}
      className={
        anchored
          ? 'z-20 inline-flex select-none items-center gap-1 rounded-md border border-border bg-background/95 p-1.5 text-foreground shadow-sm hover:bg-muted'
          : 'z-30 inline-flex select-none items-center gap-1.5 rounded-md border border-border bg-background/95 px-2 py-1 text-xs text-foreground shadow-sm hover:bg-muted'
      }
    >
      {/* 종류별 컬러 뱃지 (pptx 미리보기와 동일 색: docx 파랑/xlsx 초록/pptx 주황) */}
      <span
        aria-hidden="true"
        style={{ backgroundColor: badgeColor }}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded"
      >
        <Icon className="h-3.5 w-3.5 text-white" />
      </span>
      {!anchored && <span className="max-w-44 truncate select-none">{displayName(entry)}</span>}
    </button>
    {isSel && (
      <button
        type="button"
        data-testid="ole-download"
        title={`다운로드: ${displayName(entry)}`}
        aria-label={`다운로드 ${displayName(entry)}`}
        draggable={false}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          try { void download(entry) } catch { /* 무시 */ }
        }}
        onDoubleClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
        onDragStart={(e) => {
          e.preventDefault()
        }}
        className="z-30 inline-flex select-none items-center rounded-md border border-border bg-background/95 p-1.5 text-foreground shadow-sm hover:bg-muted"
      >
        <Download className="h-4 w-4 shrink-0" />
      </button>
    )}
    </span>
    )
  }

  const anchored = entries.filter((e) => anchor != null && posMap[e.partName] != null)
  // C7: extras는 명시 위치가 있을 때만 보인다 (폴백 없음 — 다른 슬라이드/시트에서
  // 좌상단 칩으로 새는 것을 막는다).
  // 파싱분 폴백도 파일 기준 슬라이드/시트가 현재 화면과 다르면 숨긴다
  // (다른 페이지의 첨부가 좌상단에 뜨지 않게). 슬라이드 정보가 없으면 보여준다.
  const extraParts = new Set((extras ?? []).map((ex) => ex.part))
  const curCtx = (() => {
    try {
      return getExtraContext?.()
    } catch {
      return undefined
    }
  })()
  const onCurrentSheet = (e: OleEmbeddingRef): boolean => {
    if (anchor === 'pptx' || anchor === 'xlsx') {
      const want = anchor === 'pptx' ? curCtx?.slide : curCtx?.sheet
      if (typeof want !== 'number' || !e.slides || e.slides.length === 0) return true
      return e.slides.includes(want)
    }
    return true
  }
  // C7c: 앵커된 파싱분도 현재 슬라이드/시트가 아니면 숨긴다
  // (다른 페이지 도형에 잘못 붙은 라벨이 엉뚱한 곳에 뜨지 않게).
  // extras는 resolveExtraPos에서 이미 슬라이드를 확인했으므로 항상 true다.
  const anchoredVisible = anchored.filter((e) => extraParts.has(e.partName) || onCurrentSheet(e))
  // C7d-1: 위치 미상은 슬라이드에 그리지 않는다 (fallback 변수 자체를 두지 않는다).
  // C7f: peer별 선택 lookup.
  const peerSelByPart = new Map<string, Array<{ name: string; color: string }>>()
  for (const ps of peerSels) {
    const arr = peerSelByPart.get(ps.part) ?? []
    arr.push({ name: ps.name, color: ps.color })
    peerSelByPart.set(ps.part, arr)
  }
  const displayName = (entry: OleEmbeddingRef): string => entry.displayName || entry.fallbackName || entry.partName.split('/').pop() || '첨부파일';

  // 아이콘 바로 아래 가운데 정렬 파일명 라벨 (표시 전용 — 클릭을 막지 않는다).
  // dblclick은 컨테이너 캡처가 잡는다: rect 아래쪽 패딩 + 실측 박스.
  // 아래에 안 들어가면 위로 뒤집는다 (컨테이너 밖으로 나가면 캡처가 못 받는다).
  // (C7m: pptx 파싱분은 lib-only라 캡션을 그리지 않는다. xlsx/docx 전용으로 남는다.)
  const caption = (entry: OleEmbeddingRef, pos: { x: number; y: number; w: number; h: number; captionAbove?: boolean }): React.ReactNode => {
    const name = displayName(entry)
    const above = !!pos.captionAbove
    return (
      <div
        data-testid="ole-label"
        title={name}
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: pos.x + pos.w / 2,
          top: above ? pos.y - 30 : pos.y + pos.h + 4,
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
      {anchoredVisible.map((e) => {
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
        // C7m lib-only: lib 도형과 짝지어진 파싱분은 lib 네이티브만 보인다
        // (우리 img·라벨·버튼 없음 — 파일명 hover·다운로드는 lib 것).
        // extras 중 lib 도형이 없는 것만 PptxImgEntry를 유지한다 (106 백그라운드 삽입분).
        if (anchor === 'pptx' && parentPath) {
          const iconUrl = `${API_BASE_URL}/api/collab/embed/icon?path=${encodeURIComponent(parentPath)}&part=${encodeURIComponent(e.partName)}`
          const peers = peerSelByPart.get(e.partName) ?? []
          if (pos.libClaimed === true) {
            // 피어가 없으면 그릴 것이 없다 (dblclick 라우팅은 posMap 기준이라 유지된다).
            if (peers.length === 0) return null
            return (
              <span key={e.partName}>
                {peers.map((p, i) => (
                  <span
                    key={`peer-${i}-${p.name}`}
                    data-testid="ole-peer"
                    data-peer-part={e.partName}
                    style={{
                      position: 'absolute',
                      left: pos.x,
                      top: pos.y - pos.h / 2 - 4,
                      transform: 'translate(-50%, -100%)',
                      zIndex: 31,
                      pointerEvents: 'none',
                      userSelect: 'none',
                      whiteSpace: 'nowrap',
                      background: p.color,
                      color: '#fff',
                      borderRadius: 4,
                      padding: '0 6px',
                      fontSize: 11,
                      lineHeight: '20px',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
                      maxWidth: 200,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {p.name}
                  </span>
                ))}
              </span>
            )
          }
          return (
            <span key={e.partName}>
              <PptxImgEntry
                entry={e}
                pos={pos}
                iconUrl={iconUrl}
                onMove={onMoveEmbed ? (part, p) => onMoveEmbed(part, p) : undefined}
                onResize={onResizeEmbed ? (part, s) => onResizeEmbed(part, s) : undefined}
                onDownloadFile={(en) => void download(en)}
                onOpen={(en) => void openOrDownload(en)}
                selected={selectedPart === e.partName}
                onSelect={(p) => setSelectedPart(p)}
              />
              {/* C7e: 라벨은 img 안에 있어서 별도 캡션 불필요 (중복 방지). */}
              {peers.map((p, i) => (
                <span
                  key={`peer-${i}-${p.name}`}
                  data-testid="ole-peer"
                  data-peer-part={e.partName}
                  style={{
                    position: 'absolute',
                    left: pos.x,
                    top: pos.y - pos.h / 2 - 4,
                    transform: 'translate(-50%, -100%)',
                    zIndex: 31,
                    pointerEvents: 'none',
                    userSelect: 'none',
                    whiteSpace: 'nowrap',
                    background: p.color,
                    color: '#fff',
                    borderRadius: 4,
                    padding: '0 6px',
                    fontSize: 11,
                    lineHeight: '20px',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
                    maxWidth: 200,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {p.name}
                </span>
              ))}
            </span>
          )
        }
        // C7c-1/C7e: xlsx/docx는 lib이 네이티브 렌더하므로 작은 아이콘 칩(클릭·선택용) + 캡션을 둔다.
        // (pptx는 위 PptxImgEntry 분기에서 처리 — 여기 오지 않음.)
        const peers = peerSelByPart.get(e.partName) ?? []
        return (
          <span key={e.partName}>
            {chip(e, true, { x: pos.x, y: pos.y }, { selected: selectedPart === e.partName, onSelect: (p) => setSelectedPart(p) })}
            {peers.map((p, i) => (
              <span
                key={`peer-${i}-${p.name}`}
                data-testid="ole-peer"
                data-peer-part={e.partName}
                style={{
                  position: 'absolute',
                  left: pos.x,
                  top: pos.y - pos.h / 2 - 4,
                  transform: 'translate(-50%, -100%)',
                  zIndex: 31,
                  pointerEvents: 'none',
                  userSelect: 'none',
                  whiteSpace: 'nowrap',
                  background: p.color,
                  color: '#fff',
                  borderRadius: 4,
                  padding: '0 6px',
                  fontSize: 11,
                  lineHeight: '20px',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
                  maxWidth: 200,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {p.name}
              </span>
            ))}
            {caption(e, pos)}
          </span>
        )
      })}
      {/* C7d-1: 위치를 모르는 첨부는 슬라이드 위에 그리지 않는다 (좌상단 폴백 폐지).
          고아 파트는 첨부 패널 목록에서 다룬다 (후속). */}
    </>
  )
}
