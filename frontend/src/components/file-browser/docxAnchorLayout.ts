import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'

/**
 * 떠있는 텍스트상자(`w:drawing/wp:anchor` + `wps:txbx`)를 앵커 좌표에
 * 절대 배치한다. docx-react-viewer 파서가 placement를 버려 인라인으로
 * 쌓아버리는 것을 우리 쪽에서 바로잡는다. 읽기 전용 미리보기용.
 */

const EMU_TO_PX = 1 / 9525
const TWIP_TO_PX = 1 / 15

type AnchorBox = {
  text: string
  xFrom: string
  xAlign?: string
  xOff: number
  yFrom: string
  yAlign?: string
  yOff: number
  w: number
  h: number
  /** 첫 런 글자 크기(px). 뷰어 기본 12px 대신 원본 크기로. */
  fontPx?: number
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
})

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

function collectText(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node !== 'object' || node === null) return ''
  const obj = node as Record<string, unknown>
  let s = ''
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('@_')) continue
    if (k === 'w:instrText' || k === 'w:delText') continue
    // 런 사이 공백은 w:t가 xml:space로 보존하므로 여기서 붙이지 않는다.
    s += collectText(v)
  }
  return s
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

function num(v: unknown): number {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN
  return Number.isFinite(n) ? n : 0
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
}

function firstFontPx(node: unknown): number | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = firstFontPx(v)
      if (r !== undefined) return r
    }
    return undefined
  }
  const obj = node as Record<string, unknown>
  if ('w:sz' in obj) {
    const sz = obj['w:sz'] as Record<string, unknown>
    const half = num(sz['@_w:val'])
    if (half > 0) return (half / 2) * (96 / 72)
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('@_')) continue
    const r = firstFontPx(v)
    if (r !== undefined) return r
  }
  return undefined
}

function parseAnchor(a: Record<string, unknown>): AnchorBox | null {
  const graphic = (a['a:graphic'] ?? {}) as Record<string, unknown>
  const graphicData = graphic['a:graphicData'] as Record<string, unknown> | undefined
  if (!graphicData) return null
  const hasTextBox = 'wps:txbx' in graphicData || 'wps:wsp' in graphicData
  if (!hasTextBox) return null
  const extent = (a['wp:extent'] ?? {}) as Record<string, unknown>
  const posH = (a['wp:positionH'] ?? {}) as Record<string, unknown>
  const posV = (a['wp:positionV'] ?? {}) as Record<string, unknown>
  const text = norm(collectText(graphicData['wps:txbx'] ?? graphicData['wps:wsp']))
  if (!text) return null
  const fontPx = firstFontPx(graphicData['wps:txbx'] ?? graphicData['wps:wsp'])
  return {
    text,
    xFrom: str(posH['@_relativeFrom']) || 'column',
    xAlign: str(posH['wp:align']) || undefined,
    xOff: num(posH['wp:posOffset']) * EMU_TO_PX,
    yFrom: str(posV['@_relativeFrom']) || 'paragraph',
    yAlign: str(posV['wp:align']) || undefined,
    yOff: num(posV['wp:posOffset']) * EMU_TO_PX,
    w: num(extent['@_cx']) * EMU_TO_PX,
    h: num(extent['@_cy']) * EMU_TO_PX,
    ...(fontPx !== undefined ? { fontPx } : {}),
  }
}

type PageGeom = { pageW: number; marL: number; marR: number; marT: number }

function pageGeometry(body: Record<string, unknown>, fallbackW: number): PageGeom {
  const sect = (body['w:sectPr'] ?? {}) as Record<string, unknown>
  const pgSz = (sect['w:pgSz'] ?? {}) as Record<string, unknown>
  const pgMar = (sect['w:pgMar'] ?? {}) as Record<string, unknown>
  const pageW = num(pgSz['@_w']) * TWIP_TO_PX || fallbackW
  return {
    pageW,
    marL: num(pgMar['@_l']) * TWIP_TO_PX || 72,
    marR: num(pgMar['@_r']) * TWIP_TO_PX || 72,
    marT: num(pgMar['@_t']) * TWIP_TO_PX || 72,
  }
}

function walkDrawings(node: unknown, out: AnchorBox[]): void {
  if (typeof node !== 'object' || node === null) return
  if (Array.isArray(node)) {
    for (const v of node) walkDrawings(v, out)
    return
  }
  const obj = node as Record<string, unknown>
  for (const [k, v] of Object.entries(obj)) {
    // wp:anchor는 w:drawing 바로 아래가 아니라
    // mc:AlternateContent/mc:Choice 안에 싸여 있는 경우가 흔하다.
    if (k === 'wp:anchor') {
      for (const a of asArray(v)) {
        const box = parseAnchor(a as Record<string, unknown>)
        if (box) out.push(box)
      }
    } else if (!k.startsWith('@_')) {
      walkDrawings(v, out)
    }
  }
}

function resolveX(box: AnchorBox, geom: PageGeom, phLocalX: number): number | null {
  const contentL = geom.marL
  const contentW = geom.pageW - geom.marL - geom.marR
  if (box.xAlign === 'left' || box.xAlign === 'inside') return box.xFrom === 'page' ? 0 : contentL
  if (box.xAlign === 'right' || box.xAlign === 'outside') {
    const base = box.xFrom === 'page' ? 0 : contentL
    const baseW = box.xFrom === 'page' ? geom.pageW : contentW
    return base + baseW - box.w
  }
  if (box.xAlign === 'center') {
    const base = box.xFrom === 'page' ? 0 : contentL
    const baseW = box.xFrom === 'page' ? geom.pageW : contentW
    return base + (baseW - box.w) / 2
  }
  switch (box.xFrom) {
    case 'page': return box.xOff
    case 'margin': return geom.marL + box.xOff
    case 'column': return contentL + box.xOff
    case 'character': return phLocalX + box.xOff
    default: return null
  }
}

function resolveY(box: AnchorBox, geom: PageGeom, phLocalY: number, pageLocalH: number): number | null {
  if (box.yAlign === 'top') return box.yFrom === 'page' ? 0 : geom.marT
  if (box.yAlign === 'bottom') {
    const base = box.yFrom === 'page' ? 0 : geom.marT
    const baseH = box.yFrom === 'page' ? pageLocalH : pageLocalH - geom.marT * 2
    return base + baseH - box.h
  }
  if (box.yAlign === 'center') {
    const base = box.yFrom === 'page' ? 0 : geom.marT
    const baseH = box.yFrom === 'page' ? pageLocalH : pageLocalH - geom.marT * 2
    return base + (baseH - box.h) / 2
  }
  switch (box.yFrom) {
    case 'page': return box.yOff
    case 'margin': return geom.marT + box.yOff
    case 'paragraph':
    case 'line': return phLocalY + box.yOff
    default: return null
  }
}

/** 문서에 코멘트 파트가 있으면 true. */
export async function hasDocxComments(bytes: Uint8Array): Promise<boolean> {
  try {
    const zip = await JSZip.loadAsync(bytes)
    return Object.keys(zip.files).some((n) => /(^|\/)word\/comments\d*\.xml$/.test(n))
  } catch {
    return false
  }
}

/** docx-editor의 코멘트 패널을 토글한다. */
export function toggleDocxComments(root: HTMLElement): boolean {
  const editor = root.querySelector('docx-editor')
  if (!editor) return false
  const target =
    (editor.shadowRoot?.querySelector('office-ui-ribbon-actions') as HTMLElement | null) ?? editor
  target.dispatchEvent(new CustomEvent('office-ribbon-comments', { bubbles: true, composed: true }))
  return true
}

/**
 * 앵커 텍스트상자를 절대 배치하고 배치한 개수를 반환한다.
 * flow 측정은 전부 먼저 하고 적용은 나중에 해서 서로 영향 없게 한다.
 */
export async function layoutAnchoredTextBoxes(bytes: Uint8Array, root: HTMLElement): Promise<number> {
  let xml: string
  try {
    const zip = await JSZip.loadAsync(bytes)
    const file = zip.file('word/document.xml')
    if (!file) return 0
    xml = await file.async('string')
  } catch {
    return 0
  }
  let doc: Record<string, unknown>
  try {
    doc = parser.parse(xml) as Record<string, unknown>
  } catch {
    return 0
  }
  const body = ((doc['w:document'] as Record<string, unknown> | undefined)?.['w:body'] ?? {}) as Record<
    string,
    unknown
  >
  const boxes: AnchorBox[] = []
  walkDrawings(body, boxes)
  if (!boxes.length) return 0

  // 렌더 결과는 docx-editor 섀도우 DOM 안에 있다.
  const editor = root.querySelector('docx-editor')
  const scope = (editor?.shadowRoot as unknown as ParentNode | null) ?? (root as ParentNode)
  const qsa = (sel: string) => Array.from(scope.querySelectorAll(sel)) as HTMLElement[]

  const placeholders = qsa('span[data-docx-image-placeholder]').filter((el) =>
    el.querySelector('.dve-textbox-line'),
  )
  if (!placeholders.length) return 0

  // 텍스트 매칭: 뷰어가 앞에 붙이는 "Text box" 라벨을 제외하고 비교한다.
  // 정확히 일치 우선, 나머지는 순서대로.
  const keyOf = (el: HTMLElement) =>
    norm(el.textContent ?? '').replace(/^text box\s*/i, '')
  const byText = new Map<string, HTMLElement[]>()
  for (const el of placeholders) {
    const t = keyOf(el)
    if (!t) continue
    const list = byText.get(t) ?? []
    list.push(el)
    byText.set(t, list)
  }
  const pairs: Array<{ box: AnchorBox; el: HTMLElement }> = []
  const used = new Set<HTMLElement>()
  const leftovers: AnchorBox[] = []
  for (const box of boxes) {
    const list = (byText.get(box.text) ?? []).filter((el) => !used.has(el))
    if (list.length) {
      used.add(list[0])
      pairs.push({ box, el: list[0] })
    } else {
      leftovers.push(box)
    }
  }
  const freeEls = placeholders.filter((el) => !used.has(el))
  for (let i = 0; i < leftovers.length && i < freeEls.length; i++) {
    pairs.push({ box: leftovers[i], el: freeEls[i] })
  }
  if (!pairs.length) return 0

  // 측정 (적용 전 일괄). paragraph 기준 V는 앵커 문단 top을 쓴다.
  const measured: Array<{ box: AnchorBox; el: HTMLElement; page: HTMLElement; lx: number; ly: number; paraY: number; pw: number; ph: number; zoom: number }> = []
  for (const { box, el } of pairs) {
    const page = el.closest('.dve-paper') as HTMLElement | null
    if (!page) continue
    const r = el.getBoundingClientRect()
    const pr = page.getBoundingClientRect()
    if (!pr.width || !pr.height) continue
    const zoom = Number((getComputedStyle(page) as CSSStyleDeclaration & { zoom?: string }).zoom) || 1
    const para = el.closest('p')
    const paraTop = para ? (para.getBoundingClientRect().top - pr.top) / zoom : (r.top - pr.top) / zoom
    measured.push({
      box, el, page,
      lx: (r.left - pr.left) / zoom,
      ly: (r.top - pr.top) / zoom,
      paraY: paraTop,
      pw: pr.width / zoom,
      ph: pr.height / zoom,
      zoom,
    })
  }
  if (!measured.length) return 0

  const geom = pageGeometry(body, measured[0].pw)
  let applied = 0
  for (const m of measured) {
    // 뷰어가 앞에 붙이는 "Text box" 라벨 텍스트 노드는 내용이 아니면 표시에서 뺀다.
    const first = m.el.firstChild
    if (first && first.nodeType === 3 && norm(first.textContent ?? '').toLowerCase() === 'text box') {
      const rest = norm(
        Array.from(m.el.childNodes)
          .slice(1)
          .map((n) => n.textContent ?? '')
          .join(''),
      )
      if (rest === m.box.text) first.remove()
    }
    const x = resolveX(m.box, geom, m.lx)
    const yBase = m.box.yFrom === 'paragraph' ? m.paraY : m.ly
    const y = resolveY(m.box, geom, yBase, m.ph)
    if (x === null || y === null) continue
    const st = m.el.style
    st.position = 'absolute'
    st.left = `${Math.round(x)}px`
    st.top = `${Math.round(y)}px`
    if (m.box.w > 0) st.width = `${Math.round(m.box.w)}px`
    if (m.box.h > 0) {
      st.height = `${Math.round(m.box.h)}px`
      st.minHeight = '0'
    }
    st.margin = '0'
    st.zIndex = '2'
    if (m.box.fontPx && m.box.fontPx > 0) {
      const fs = `${Math.round(m.box.fontPx * 10) / 10}px`
      st.fontSize = fs
      m.el.querySelectorAll('.dve-textbox-line').forEach((l) => {
        ;(l as HTMLElement).style.fontSize = fs
      })
    }
    applied++
  }
  return applied
}
