import { useEffect, useMemo, useRef, useState } from 'react'
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
import { findOleEntryAtPoint } from '@/lib/oleHitTest'
import { frameFileNames, entryNameHit, progIdOfText, extOf, OLE_PROG_EXT } from '@/lib/oleMatch'
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

/** C7: 백그라운드 삽입 칩 (리로드 없이 명시 위치에 표시). */
export interface OleExtraAttachment {
  part: string
  name: string
  kind: OleAnchorKind
  pos: {
    slide?: number
    x?: number
    y?: number
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
      // 1차: 파일명이 들어간 Download 프레임 (항목별 매칭).
      for (const el of all) {
        try {
          const eid = el.getAttribute?.('data-element-id') ?? ''
          if (!eid.includes('-frame-') || !isVis(el)) continue
          const text = el.textContent ?? ''
          if (!/download/i.test(text)) continue
          if (frameFileNames(text).some((ff) => entryNameHit(ff, entry))) return { el, unsupported: false }
        } catch {
          /* 무시 */
        }
      }
      // 2차: Download 프레임이 정확히 1개일 때만 (여러 개면 엉뚱한 도형에 붙는다).
      try {
        const frames: Element[] = []
        for (const el of all) {
          try {
            const eid = el.getAttribute?.('data-element-id') ?? ''
            if (eid.includes('-frame-') && /download/i.test(el.textContent ?? '') && isVis(el)) frames.push(el)
          } catch {
            /* 무시 */
          }
        }
        if (frames.length === 1 && frames[0]) return { el: frames[0], unsupported: false }
      } catch {
        /* 무시 */
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
        if (!oleSel(el) || !isVis(el)) continue
        const hay = `${el.getAttribute?.('alt') ?? ''} ${el.getAttribute?.('title') ?? ''} ${el.textContent ?? ''}`
        if (frameFileNames(hay).some((ff) => entryNameHit(ff, entry))) return { el, unsupported: false }
      } catch {
        /* 무시 */
      }
    }
    // 2차: progId 확장자가 항목 확장자와 같은 자리.
    const wantExt = extOf(entry.displayName ?? entry.fallbackName)
    if (wantExt && wantExt !== 'bin') {
      for (const el of all) {
        try {
          if (!oleSel(el) || !isVis(el)) continue
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
          if (el.hasAttribute?.('data-docx-ole') && isVis(el)) oles.push(el)
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
      const w = 96
      const h = 48
      const x = Math.round(ex.pos.x * c.width)
      const y = Math.round(ex.pos.y * c.height)
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
export default function OleAttachmentOverlay({
  data,
  anchor,
  parentPath,
  extras,
  getExtraContext,
}: {
  data: ArrayBuffer | Uint8Array
  anchor?: OleAnchorKind
  /** C5-4: 첨부 편집 URL에 필요한 부모 식별자 (없으면 다운로드만). */
  parentPath?: string
  /** C7: 백그라운드 삽입 칩 (리로드 없이 명시 위치에 표시). */
  extras?: OleExtraAttachment[]
  /** C7: extras 해석용 현재 위치 (슬라이드/시트). */
  getExtraContext?: () => { slide?: number; sheet?: number }
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
    Record<string, { x: number; y: number; w: number; h: number; cover: boolean; captionAbove?: boolean }>
  >({})
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
        type PosEntry = { x: number; y: number; w: number; h: number; cover: boolean; captionAbove?: boolean }
        const next: Record<string, PosEntry> = {}
        // 파싱분: lib 도형 위치.
        // C7: 백그라운드분은 여기서 건너뛰고 아래 명시 위치로만 둔다
        // (findAnchorEl의 첫 프레임 폴백이 엉뚱한 도형을 잡는 것을 방지).
        const extraParts = new Set((extrasRef.current ?? []).map((ex) => ex.part))
        for (const entry of entries) {
          if (extraParts.has(entry.partName)) continue
          const hit = findAnchorEl(container, anchor, entry)
          if (!hit) continue
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
          }
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
          const p = resolveExtraPos(container, anchor, ex, ctx, CAPTION_H)
          if (p) next[ex.part] = p
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

  const chip = (entry: OleEmbeddingRef, anchored: boolean, pos?: { x: number; y: number }): React.ReactNode => {
    const Icon = iconForFile(displayName(entry))
    return (
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
      style={anchored && pos ? { left: pos.x, top: pos.y, position: 'absolute', zIndex: 30, transform: 'translate(-50%, -50%)' } : undefined}
      className={
        anchored
          ? 'z-20 inline-flex select-none items-center gap-1 rounded-md border border-border bg-background/95 p-1.5 text-foreground shadow-sm hover:bg-muted'
          : 'z-30 inline-flex select-none items-center gap-1.5 rounded-md border border-border bg-background/95 px-2 py-1 text-xs text-foreground shadow-sm hover:bg-muted'
      }
    >
      <Paperclip className="h-3.5 w-3.5 shrink-0" />
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      {!anchored && <span className="max-w-44 truncate select-none">{displayName(entry)}</span>}
    </button>
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
  const fallback = entries.filter(
    (e) => !(anchor != null && posMap[e.partName] != null) && !extraParts.has(e.partName) && onCurrentSheet(e),
  )
  const displayName = (entry: OleEmbeddingRef): string => entry.displayName ?? entry.fallbackName

  // 아이콘 바로 아래 가운데 정렬 파일명 라벨 (표시 전용 — 클릭을 막지 않는다).
  // dblclick은 컨테이너 캡처가 잡는다: rect 아래쪽 패딩 + 실측 박스.
  // 아래에 안 들어가면 위로 뒤집는다 (컨테이너 밖으로 나가면 캡처가 못 받는다).
  const caption = (entry: OleEmbeddingRef, pos: { x: number; y: number; w: number; h: number; captionAbove?: boolean }): React.ReactNode => {
    const name = displayName(entry)
    const above = !!pos.captionAbove
    return (
      <div
        key={entry.partName}
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
      {anchoredVisible.map((e) => {
        const pos = posMap[e.partName]
        if (!pos) return null
        // C7c-1: lib이 실제 도형을 그리는 경우(파싱분+앵커)는 칩을 숨기고 파일명 라벨만 남긴다
        // (lib 플레이스홀더와 우리 칩이 겹쳐 보이는 중복 방지).
        // 백그라운드 삽입 직후(lib 모델에 아직 없음, extras)는 전체 칩을 쓴다.
        const isExtra = extraParts.has(e.partName)
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
            {isExtra ? chip(e, true, { x: pos.x, y: pos.y }) : null}
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
