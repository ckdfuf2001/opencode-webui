import JSZip from 'jszip'
import type { ObjectAnchor } from './xlsxObjects'

/**
 * S1: unsupported 도형(ole 등)의 로컬 이동을 저장 바이트에 반영한다.
 * 근거: lib saveBytes는 알 수 없는 drawing을 원본 OPC 파트 그대로 보존해서
 * 앵커 이동이 디스크에 안 남는다 (probe: move 200 OK + save 200 OK인데도
 * drawing1.xml from/to 불변). 저장 직전 drawing 앵커만 수술식으로 교체한다.
 * - 대상: kind가 unsupported:* 인 도형의 twoCellAnchor (fail-closed).
 * - 앵커 개수·인덱스가 안 맞으면 그 시트는 손대지 않는다.
 * - 패치 실패(예외)는 원본 바이트 그대로 (저장 자체는 막지 않는다).
 */

export interface AnchorUpdate {
  /** 0-based 시트 순서 (workbook.xml sheets 순서). */
  sheet: number
  /** 시트 drawings 배열 순서 = drawing 파트의 앵커 문서 순서. */
  index: number
  anchor: ObjectAnchor
}

interface Num4 {
  col: number
  colOff: number
  row: number
  rowOff: number
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null
}

function markerOf(anchor: ObjectAnchor): { from: Num4; to: Num4 } | null {
  const f = anchor?.from
  const t = anchor?.to
  const from =
    f == null
      ? null
      : { col: num(f.col), colOff: num(f.colOffset), row: num(f.row), rowOff: num(f.rowOffset) }
  const to =
    t == null
      ? null
      : { col: num(t.col), colOff: num(t.colOffset), row: num(t.row), rowOff: num(t.rowOffset) }
  if (!from || !to) return null
  if (from.col == null || from.colOff == null || from.row == null || from.rowOff == null) return null
  if (to.col == null || to.colOff == null || to.row == null || to.rowOff == null) return null
  if (from.col < 0 || from.row < 0 || to.col < 0 || to.row < 0) return null
  if (from.colOff < 0 || from.rowOff < 0 || to.colOff < 0 || to.rowOff < 0) return null
  return {
    from: { col: from.col, colOff: from.colOff, row: from.row, rowOff: from.rowOff },
    to: { col: to.col, colOff: to.colOff, row: to.row, rowOff: to.rowOff },
  }
}

/** `<sheet ... r:id="...">` 를 문서 순서대로. */
function sheetRIds(workbookXml: string): string[] {
  const out: string[] = []
  const re = /<[\w.-]*:?sheet\b[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(workbookXml)) !== null) {
    const tag = m[0]
    const id = /(?:r:id|id)="([^"]+)"/.exec(tag)?.[1]
    if (id) out.push(id)
  }
  return out
}

/** rels xml에서 Type → Target 목록 (문서 순서). */
function relEntries(relsXml: string): Array<{ id: string; type: string; target: string }> {
  const out: Array<{ id: string; type: string; target: string }> = []
  const re = /<[\w.-]*:?Relationship\b[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(relsXml)) !== null) {
    const tag = m[0]
    const id = /\bId="([^"]+)"/.exec(tag)?.[1]
    const type = /\bType="([^"]+)"/.exec(tag)?.[1]
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1]
    if (id && type && target) out.push({ id, type, target })
  }
  return out
}

function resolveZipPath(baseFile: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const baseDir = baseFile.includes('/') ? baseFile.slice(0, baseFile.lastIndexOf('/') + 1) : ''
  const parts: string[] = []
  for (const seg of `${baseDir}${target}`.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

/** drawing 파트에서 앵커 요소(twoCell/oneCell/absolute)를 문서 순서대로. */
function anchorSpans(drawingXml: string): Array<{ kind: string; start: number; end: number; body: string; open: string; close: string }> {
  const out: Array<{ kind: string; start: number; end: number; body: string; open: string; close: string }> = []
  const re = /<([\w.-]*:?)(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[^>]*>([\s\S]*?)<\/\1\2>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(drawingXml)) !== null) {
    const full = m[0]
    const closeStart = full.lastIndexOf('</')
    out.push({
      kind: m[2]!,
      start: m.index,
      end: m.index + full.length,
      body: m[3] ?? '',
      open: full.slice(0, full.indexOf('>') + 1),
      close: full.slice(closeStart),
    })
  }
  return out
}

function markerBlock(prefix: string, name: 'from' | 'to', v: Num4): string {
  const p = prefix || ''
  return `<${p}${name}><${p}col>${v.col}</${p}col><${p}colOff>${v.colOff}</${p}colOff><${p}row>${v.row}</${p}row><${p}rowOff>${v.rowOff}</${p}rowOff></${p}${name}>`
}

/** twoCellAnchor body의 from/to 블록만 교체한다. 없으면 null. */
function patchTwoCell(openTag: string, body: string, m: { from: Num4; to: Num4 }): string | null {
  const prefix = openTag.startsWith('<') ? openTag.slice(1, openTag.indexOf('twoCellAnchor')) : ''
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const fromRe = new RegExp(`<${esc}from\\b[^>]*>[\\s\\S]*?</${esc}from>`)
  const toRe = new RegExp(`<${esc}to\\b[^>]*>[\\s\\S]*?</${esc}to>`)
  if (!fromRe.test(body) || !toRe.test(body)) return null
  return body.replace(fromRe, markerBlock(prefix, 'from', m.from)).replace(toRe, markerBlock(prefix, 'to', m.to))
}

/**
 * unsupported 도형 이동분을 drawing XML에 반영한다. 패치할 게 없으면
 * 원본 바이트를 그대로 돌려준다.
 */
export async function patchUnsupportedAnchors(
  xlsxBytes: Uint8Array,
  updates: AnchorUpdate[],
): Promise<Uint8Array> {
  const wanted = updates.filter((u) => u.anchor != null && markerOf(u.anchor) != null)
  if (wanted.length === 0) return xlsxBytes
  const zip = await JSZip.loadAsync(xlsxBytes)
  const readText = async (name: string): Promise<string | null> => {
    const f = zip.files[name]
    if (!f || f.dir) return null
    try {
      return await f.async('string')
    } catch {
      return null
    }
  }
  const workbookXml = await readText('xl/workbook.xml')
  if (!workbookXml) return xlsxBytes
  const wbRels = await readText('xl/_rels/workbook.xml.rels')
  if (!wbRels) return xlsxBytes
  const sheetIds = sheetRIds(workbookXml)
  const wbEntries = relEntries(wbRels)
  const wbById = new Map(wbEntries.map((e) => [e.id, e.target]))
  // 시트별 drawing 파트 + 해당 시트의 업데이트 묶기.
  const byPart = new Map<string, Array<{ index: number; m: { from: Num4; to: Num4 } }>>()
  for (const u of wanted) {
    const m = markerOf(u.anchor)
    if (!m) continue
    const sheetRel = sheetIds[u.sheet]
    if (!sheetRel) continue
    const sheetTarget = wbById.get(sheetRel)
    if (!sheetTarget) continue
    const sheetFile = resolveZipPath('xl/workbook.xml', sheetTarget)
    const sheetRelsFile =
      sheetFile.replace(/\/([^/]+)$/, '/_rels/$1.rels')
    const sheetRels = await readText(sheetRelsFile)
    if (!sheetRels) continue
    // Type이 /drawing 으로 끝나는 rel만 (vmlDrawing 제외).
    const drawingTarget = relEntries(sheetRels).find((e) => /\/drawing$/.test(e.type))?.target
    if (!drawingTarget) continue
    const drawingFile = resolveZipPath(sheetFile, drawingTarget)
    const arr = byPart.get(drawingFile) ?? []
    arr.push({ index: u.index, m })
    byPart.set(drawingFile, arr)
  }
  if (byPart.size === 0) return xlsxBytes
  let patched = false
  for (const [part, list] of byPart) {
    const xml = await readText(part)
    if (!xml) continue
    const spans = anchorSpans(xml)
    const twoCells = spans.filter((s) => s.kind === 'twoCellAnchor')
    if (twoCells.length === 0) continue
    if (Math.max(...list.map((l) => l.index)) >= twoCells.length) continue
    let next = xml
    // 뒤에서 앞으로 교체 (앞 인덱스가 안 밀린다).
    const jobs = [...list].sort((a, b) => b.index - a.index)
    let ok = true
    for (const j of jobs) {
      // next는 앞에서 이미 바뀐 문자열이므로 span 위치를 다시 찾는다.
      const cur = anchorSpans(next).filter((s) => s.kind === 'twoCellAnchor')[j.index]
      if (!cur) {
        ok = false
        break
      }
      const body = patchTwoCell(cur.open, cur.body, j.m)
      if (body == null) {
        ok = false
        break
      }
      next = `${next.slice(0, cur.start)}${cur.open}${body}${cur.close}${next.slice(cur.end)}`
    }
    if (!ok) continue
    zip.file(part, next)
    patched = true
  }
  if (!patched) return xlsxBytes
  const out = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return out
}
