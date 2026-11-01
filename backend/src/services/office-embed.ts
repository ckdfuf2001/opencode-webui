/**
 * C5-2: INSERT 문서 첨부 — 서버 조립.
 * 호스트 파일(pptx/xlsx/docx)에 첨부 파일을 네이티브 OLE 형태로 넣는다.
 * lib 패치 없이, 조립 후 방 리셋 → 기존 첨부(C5-1 경로)로 취급된다.
 *
 * 공통 규칙 (가이드):
 * - 첨부 확장자는 docx/xlsx/pptx만, 매직바이트 PK\x03\x04, 20MB 상한.
 * - 미리보기는 제네릭 PNG 아이콘 (EMF 대신).
 * - progId는 영문 네이티브 (docx→Word.Document.12, xlsx→Excel.Sheet.12).
 *   pptx 첨부는 package rel로 둔다 (데스크톱 progId 불확실 → lib는 download 처리).
 * - 실패는 throw { message, statusCode?, code? } (routes/collab errJson 규격).
 */

import { deflateSync } from 'node:zlib'

export type EmbedAttachKind = 'docx' | 'xlsx' | 'pptx'

export const EMBED_MAX_BYTES = 20 * 1024 * 1024

const ATTACH_MIME: Record<EmbedAttachKind, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export function embedError(message: string, statusCode = 400, code?: string): never {
  throw { message, statusCode, code }
}

/** 파일명 살균: 경로 제거, 안전 문자만, 확장자 유지. */
export function sanitizeEmbedName(raw: string, fallbackExt: string): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? ''
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').slice(0, 120)
  const m = clean.match(/^(.*?)\.([A-Za-z0-9]{1,8})$/)
  if (m && m[1]) return `${m[1]}.${m[2]!.toLowerCase()}`
  const stem = clean.replace(/\.+$/, '') || 'attachment'
  return `${stem}.${fallbackExt}`
}

export function attachKindOf(name: string): EmbedAttachKind | null {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') return ext
  return null
}

export function assertAttachBytes(bytes: Uint8Array, kind: EmbedAttachKind | null): void {
  if (!kind) embedError('Only docx/xlsx/pptx attachments are supported', 400, 'bad_kind')
  if (bytes.length > EMBED_MAX_BYTES) embedError('Attachment too large (max 20MB)', 413, 'too_large')
  // PK\x03\x04 (zip/OOXML).
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    embedError('Attachment is not a valid Office document', 400, 'bad_magic')
  }
}

/* ---------- 제네릭 PNG 아이콘 (게이트 스크립트 포팅, 의존성 없음) ---------- */

const CRC_T = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const t = new TextEncoder().encode(type)
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  out.set(t, 4)
  out.set(data, 8)
  const both = new Uint8Array(4 + data.length)
  both.set(t, 0)
  both.set(data, 4)
  dv.setUint32(8 + data.length, crc32(both))
  return out
}

/** 96x96 문서 아이콘 PNG (파랑 테두리 + 흰 바탕 + 줄무늬). */
export function genericIconPng(): Uint8Array {
  const W = 96
  const H = 96
  const px = new Uint8Array(W * H * 3).fill(255)
  const set = (x: number, y: number, r: number, g: number, b: number): void => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const o = (y * W + x) * 3
    px[o] = r
    px[o + 1] = g
    px[o + 2] = b
  }
  const rect = (x0: number, y0: number, x1: number, y1: number, c: [number, number, number]): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c[0], c[1], c[2])
  }
  const BLUE: [number, number, number] = [37, 99, 235]
  const GRAY: [number, number, number] = [148, 163, 184]
  const DARK: [number, number, number] = [51, 65, 85]
  rect(0, 0, W - 1, H - 1, BLUE)
  rect(4, 4, W - 5, H - 5, [255, 255, 255])
  for (let i = 0; i < 19; i++) {
    set(W - 24 + i, 5 + i, ...GRAY)
    set(W - 23 + i, 5 + i, ...GRAY)
  }
  for (let r = 0; r < 4; r++) rect(14, 34 + r * 14, W - 15 - (r === 3 ? 22 : 0), 40 + r * 14, r === 0 ? DARK : GRAY)
  const raw = new Uint8Array((W * 3 + 1) * H)
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0
    raw.set(px.subarray(y * W * 3, (y + 1) * W * 3), y * (W * 3 + 1) + 1)
  }
  const idat = deflateSync(raw)
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, W)
  dv.setUint32(4, H)
  ihdr[8] = 8
  ihdr[9] = 2
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const parts = [sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/* ---------- zip/rels 공통 ---------- */

export interface ZipLike {
  files: Record<string, { dir: boolean; async: (t: 'string' | 'uint8array') => Promise<string | Uint8Array> }>
  file(name: string, data?: string | Uint8Array): unknown
  remove(name: string): void
  generateAsync(opts: { type: 'uint8array'; compression?: string }): Promise<Uint8Array>
}

/** 다음 rId (rId<N> 최대+1). 없으면 rId1. */
export function nextRelId(relsXml: string): string {
  let max = 0
  const re = /\bId="rId(\d+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(relsXml)) !== null) max = Math.max(max, Number(m[1]))
  return `rId${max + 1}`
}

/** rels xml에 Relationship 한 줄 추가 (</Relationships> 앞). */
export function addRel(relsXml: string, id: string, type: string, target: string): string {
  const tag = `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`
  if (relsXml.includes('</Relationships>')) return relsXml.replace('</Relationships>', `${tag}</Relationships>`)
  return `${relsXml}${tag}`
}

export function ensureContentDefault(ct: string, ext: string, mime: string): string {
  if (ct.includes(`Extension="${ext}"`)) return ct
  const tag = `<Default Extension="${ext}" ContentType="${mime}"/>`
  if (ct.includes('</Types>')) return ct.replace('</Types>', `${tag}</Types>`)
  return `${ct}${tag}`
}

export function ensureContentOverride(ct: string, part: string, mime: string): string {
  const needle = `<Override PartName="/${part}"`
  if (ct.includes(needle)) return ct
  const tag = `<Override PartName="/${part}" ContentType="${mime}"/>`
  if (ct.includes('</Types>')) return ct.replace('</Types>', `${tag}</Types>`)
  return `${ct}${tag}`
}

/* ---------- PPTX 조립 ---------- */

const PROG_ID: Record<EmbedAttachKind, string | null> = {
  docx: 'Word.Document.12',
  xlsx: 'Excel.Sheet.12',
  pptx: null, // package rel (progId 불확실)
}

export interface PptxEmbedInput {
  hostBytes: Uint8Array
  attachBytes: Uint8Array
  attachName: string
  attachKind: EmbedAttachKind
  /** 1-based 슬라이드 번호 (기본 1). */
  slide?: number
}

/**
 * PPTX에 OLE 프레임을 추가한다.
 * - ppt/embeddings/<name> + 미리보기 PNG + slide rels 2개(package/image) +
 *   [Content_Types] + graphicFrame 1개 (+VML 있으면 shape 1개).
 */
export async function assemblePptxEmbed(
  zipLoad: (b: Uint8Array) => Promise<ZipLike>,
  input: PptxEmbedInput,
): Promise<Uint8Array> {
  const slideNo = input.slide ?? 1
  if (!Number.isInteger(slideNo) || slideNo < 1 || slideNo > 999) embedError('Bad slide number', 400, 'bad_slide')
  let zip: ZipLike
  try {
    zip = await zipLoad(input.hostBytes)
  } catch {
    embedError('Host is not a valid Office file', 400, 'bad_host')
  }
  const readText = async (name: string): Promise<string | null> => {
    const f = zip.files[name]
    if (!f || f.dir) return null
    try {
      return (await f.async('string')) as string
    } catch {
      return null
    }
  }
  const slideFile = `ppt/slides/slide${slideNo}.xml`
  const slideXml = await readText(slideFile)
  if (!slideXml || !slideXml.includes('<p:sld')) embedError('Slide not found in host', 400, 'bad_slide')
  const slide = slideXml as string
  const slideRelsFile = `ppt/slides/_rels/slide${slideNo}.xml.rels`
  const slideRels = (await readText(slideRelsFile)) ??
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'

  const safeName = sanitizeEmbedName(input.attachName, input.attachKind)
  let embName = safeName
  for (let i = 2; zip.files[`ppt/embeddings/${embName}`]; i++) {
    embName = safeName.replace(/(\.[A-Za-z0-9]{1,8})$/, `-${i}$1`)
  }
  const progId = PROG_ID[input.attachKind]
  const embRelId = nextRelId(slideRels)
  let rels = addRel(
    slideRels,
    embRelId,
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/package',
    `../embeddings/${embName}`,
  )
  // 미리보기 PNG (image<N> 빈 슬롯).
  let imgN = 1
  while (zip.files[`ppt/media/image${imgN}.png`] || zip.files[`ppt/media/image${imgN}.emf`]) imgN++
  const imgName = `image${imgN}.png`
  const imgRelId = nextRelId(rels)
  rels = addRel(rels, imgRelId, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', `../media/${imgName}`)
  zip.file(`ppt/media/${imgName}`, genericIconPng())
  zip.file(`ppt/embeddings/${embName}`, input.attachBytes)
  zip.file(slideRelsFile, rels)

  // 새 cNvPr id / spid.
  let maxId = 0
  for (const m of slide.matchAll(/<p:cNvPr[^>]*\bid="(\d+)"/g)) maxId = Math.max(maxId, Number(m[1]))
  const frameId = maxId + 1
  let maxSp = 1024
  for (const m of slide.matchAll(/spid="_x0000_s(\d+)"/g)) maxSp = Math.max(maxSp, Number(m[1]))
  const spid = `_x0000_s${maxSp + 1}`
  // 고정 배치: 우하단 2x1.4인치.
  const offX = 7315200
  const offY = 5486400
  const extCx = 1828800
  const extCy = 1270000
  const oleName = embName.replace(/\.[A-Za-z0-9]{1,8}$/, '')
  const progAttr = progId ? ` progId="${progId}"` : ''
  const frame =
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${frameId}" name="${oleName}"><a:extLst><a:ext uri="{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}"><a16:creationId xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main" id="{00000000-0000-0000-0000-000000000000}"/></a:ext></a:extLst></p:cNvPr><p:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${offX}" y="${offY}"/><a:ext cx="${extCx}" cy="${extCy}"/></a:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole"><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:v="urn:schemas-microsoft-com:vml" Requires="v"><p:oleObj spid="${spid}" name="${oleName}" showAsIcon="1" r:id="${embRelId}" imgW="${extCx}" imgH="${extCy}"${progAttr}><p:embed/></p:oleObj></mc:Choice><mc:Fallback><p:oleObj name="${oleName}" showAsIcon="1" r:id="${embRelId}" imgW="${extCx}" imgH="${extCy}"${progAttr}><p:embed/><p:pic><p:nvPicPr><p:cNvPr id="0" name=""/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${imgRelId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${offX}" y="${offY}"/><a:ext cx="${extCx}" cy="${extCy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:oleObj></mc:Fallback></mc:AlternateContent></a:graphicData></a:graphic></p:graphicFrame>`
  if (!slide.includes('</p:spTree>')) embedError('Unsupported slide structure', 400, 'bad_slide')
  zip.file(slideFile, slide.replace('</p:spTree>', `${frame}</p:spTree>`))

  // VML이 있으면 shape 추가 (없으면 Fallback pic으로 충분).
  const vmlMatch = rels.match(/\bTarget="([^"]*vmlDrawing[^"]*)"/)
  if (vmlMatch) {
    const vmlTarget = vmlMatch[1]!
    const vmlFile = vmlTarget.startsWith('../') ? `ppt/${vmlTarget.slice(3)}` : `ppt/drawings/${vmlTarget}`
    const vml = await readText(vmlFile)
    if (vml && vml.includes('</xml>')) {
      const vmlRelsFile = vmlFile.replace(/\/([^/]+)$/, '/_rels/$1.rels')
      const vmlRels = (await readText(vmlRelsFile)) ??
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
      const vmlImgId = nextRelId(vmlRels)
      zip.file(vmlRelsFile, addRel(vmlRels, vmlImgId, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', `../media/${imgName}`))
      const shape = `<v:shape id="${spid}" type="#_x0000_t75" style='position:absolute;left:576pt;top:432pt;width:144pt;height:100pt'><v:fill on="f"/><v:stroke on="f"/><v:imagedata o:relid="${vmlImgId}" o:title="" grayscale="f" bilevel="f"/><o:lock v:ext="edit" aspectratio="t" position="f" selection="f" grouping="f"/></v:shape>`
      zip.file(vmlFile, vml.replace('</xml>', `${shape}</xml>`))
    }
  }

  let ct = (await readText('[Content_Types].xml')) ?? ''
  if (!ct) embedError('Host is not a valid Office file', 400, 'bad_host')
  ct = ensureContentDefault(ct, 'png', 'image/png')
  ct = ensureContentOverride(ct, `ppt/embeddings/${embName}`, ATTACH_MIME[input.attachKind])
  zip.file('[Content_Types].xml', ct)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

export interface XlsxEmbedInput {
  hostBytes: Uint8Array
  attachBytes: Uint8Array
  attachName: string
  attachKind: EmbedAttachKind
  /** 0-based 시트 순서 (기본 0). */
  sheet?: number
}

const XLSX_NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const XLSX_NS_XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
const XLSX_NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const XLSX_PROG_ID: Record<EmbedAttachKind, string | null> = {
  docx: 'Word.Document.12',
  xlsx: 'Excel.Sheet.12',
  pptx: null,
}

/**
 * XLSX에 OLE 개체를 넣는다 (drawing + oleObjects + VML 3곳 일치).
 * - embeddings + 미리보기 PNG + sheet rels (oleObject/image/drawing/vmlDrawing).
 * - sheet oleObjects (plain form) + drawing twoCellAnchor + VML shape.
 * - 앵커는 사용 영역 아래(빈 행)에 둔다. 없으면 drawing/VML 파트를 새로 만든다.
 */
export async function assembleXlsxEmbed(
  zipLoad: (b: Uint8Array) => Promise<ZipLike>,
  input: XlsxEmbedInput,
): Promise<Uint8Array> {
  const sheetIdx = input.sheet ?? 0
  if (!Number.isInteger(sheetIdx) || sheetIdx < 0 || sheetIdx > 256) embedError('Bad sheet number', 400, 'bad_sheet')
  let zip: ZipLike
  try {
    zip = await zipLoad(input.hostBytes)
  } catch {
    embedError('Host is not a valid Office file', 400, 'bad_host')
  }
  const readText = async (name: string): Promise<string | null> => {
    const f = zip!.files[name]
    if (!f || f.dir) return null
    try {
      return (await f.async('string')) as string
    } catch {
      return null
    }
  }
  const workbookXml = await readText('xl/workbook.xml')
  if (!workbookXml || !workbookXml.includes('<workbook')) embedError('Host is not a valid Office file', 400, 'bad_host')
  // 시트 순서 → sheet 파일.
  const sheetTags = [...(workbookXml as string).matchAll(/<[\w.-]*:?sheet\b[^>]*>/g)].map((m) => m[0])
  if (sheetIdx >= sheetTags.length) embedError('Sheet not found in host', 400, 'bad_sheet')
  const sheetTag = sheetTags[sheetIdx]!
  const sheetRel = /(?:r:id|id)="([^"]+)"/.exec(sheetTag)?.[1]
  if (!sheetRel) embedError('Unsupported workbook structure', 400, 'bad_host')
  const wbRels = (await readText('xl/_rels/workbook.xml.rels')) ?? ''
  const wbTarget = new Map(
    [...wbRels.matchAll(/<[\w.-]*:?Relationship\b[^>]*>/g)].map((m) => {
      const t = m[0]
      return [/\bId="([^"]+)"/.exec(t)?.[1] ?? '', /\bTarget="([^"]+)"/.exec(t)?.[1] ?? '']
    }),
  ).get(sheetRel)
  if (!wbTarget) embedError('Unsupported workbook structure', 400, 'bad_host')
  const wbDir = 'xl/workbook.xml'
  const sheetFile = resolveZipPathTest(wbDir, wbTarget as string)
  const sheetXml = await readText(sheetFile)
  if (!sheetXml || !sheetXml.includes('<worksheet')) embedError('Sheet not found in host', 400, 'bad_sheet')
  let sheet = sheetXml as string

  const safeName = sanitizeEmbedName(input.attachName, input.attachKind)
  let embName = safeName
  for (let i = 2; zip!.files[`xl/embeddings/${embName}`]; i++) {
    embName = safeName.replace(/(\.[A-Za-z0-9]{1,8})$/, `-${i}$1`)
  }
  const progId = XLSX_PROG_ID[input.attachKind]

  // 새 shapeId/cNvPr id.
  let maxShape = 1024
  for (const m of sheet.matchAll(/shapeId="(\d+)"/g)) maxShape = Math.max(maxShape, Number(m[1]))
  for (const m of sheet.matchAll(/<xdr:cNvPr[^>]*\bid="(\d+)"/g)) maxShape = Math.max(maxShape, Number(m[1]))
  const shapeId = maxShape + 1
  // 앵커 위치: 사용 영역 아래 빈 행 (없으면 고정 위치).
  let maxRow = 0
  for (const m of sheet.matchAll(/<row[^>]*\br="(\d+)"/g)) maxRow = Math.max(maxRow, Number(m[1]))
  const fromRow = maxRow > 0 ? maxRow + 2 : 7
  const fromCol = 1
  const toCol = 2
  const toRow = fromRow + 3

  // 미리보기 PNG (빈 슬롯).
  let imgN = 1
  while (zip!.files[`xl/media/image${imgN}.png`] || zip!.files[`xl/media/image${imgN}.emf`]) imgN++
  const imgName = `image${imgN}.png`
  zip!.file(`xl/media/${imgName}`, genericIconPng())
  zip!.file(`xl/embeddings/${embName}`, input.attachBytes)

  // sheet rels.
  const sheetRelsFile = sheetFile.replace(/\/([^/]+)$/, '/_rels/$1.rels')
  let sheetRels = (await readText(sheetRelsFile)) ??
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
  const relOfType = (typeSuffix: string): string | null => {
    const re = new RegExp(`<[\\w.-]*:?Relationship\\b[^>]*Type="[^"]*${typeSuffix}"[^>]*>`, 'g')
    const tags = [...sheetRels.matchAll(re)].map((m) => m[0])
    if (tags.length === 0) return null
    return /Target="([^"]+)"/.exec(tags[0]!)?.[1] ?? null
  }
  // drawing 파트 (없으면 생성).
  let drawingTarget = relOfType('/drawing')
  let drawingFile: string | null = null
  let drawingRelId: string | null = null
  if (drawingTarget) {
    drawingFile = drawingTarget.startsWith('../') ? `xl/${drawingTarget.slice(3)}` : `xl/worksheets/${drawingTarget}`
    const m = /Id="([^"]+)"[^>]*Target="[^"]*drawing[^"]*"/.exec(
      [...sheetRels.matchAll(/<[\w.-]*:?Relationship\b[^>]*Type="[^"]*\/drawing"[^>]*>/g)].map((x) => x[0])[0] ?? '',
    )
    drawingRelId = m?.[1] ?? null
  } else {
    let dn = 1
    while (zip!.files[`xl/drawings/drawing${dn}.xml`]) dn++
    drawingFile = `xl/drawings/drawing${dn}.xml`
    drawingRelId = nextRelId(sheetRels)
    sheetRels = addRel(
      sheetRels,
      drawingRelId,
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing',
      `../drawings/drawing${dn}.xml`,
    )
    zip!.file(
      drawingFile,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="${XLSX_NS_XDR}" xmlns:a="${XLSX_NS_A}"></xdr:wsDr>`,
    )
  }
  // VML 파트 (없으면 생성).
  let vmlTarget = relOfType('vmlDrawing')
  let vmlFile: string | null = null
  if (vmlTarget) {
    vmlFile = vmlTarget.startsWith('../') ? `xl/${vmlTarget.slice(3)}` : `xl/worksheets/${vmlTarget}`
  } else {
    let vn = 1
    while (zip!.files[`xl/drawings/vmlDrawing${vn}.vml`]) vn++
    vmlFile = `xl/drawings/vmlDrawing${vn}.vml`
    const vmlRelId = nextRelId(sheetRels)
    sheetRels = addRel(
      sheetRels,
      vmlRelId,
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing',
      `../drawings/vmlDrawing${vn}.vml`,
    )
    zip!.file(
      vmlFile,
      `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout><v:shapetype id="_x0000_t75" coordsize="21600,21600" o:spt="75" o:preferrelative="t" path="m@4@5l@4@11@9@11@9@5xe" filled="f" stroked="f"><v:stroke joinstyle="miter"/><v:path o:extrusionok="f" gradientshapeok="t" o:connecttype="rect"/><o:lock v:ext="edit" aspectratio="t"/></v:shapetype></xml>`,
    )
  }
  // oleObject + image rel.
  const oleRelId = nextRelId(sheetRels)
  sheetRels = addRel(
    sheetRels,
    oleRelId,
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject',
    `../embeddings/${embName}`,
  )
  const imgRelId = nextRelId(sheetRels)
  sheetRels = addRel(
    sheetRels,
    imgRelId,
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
    `../media/${imgName}`,
  )
  zip!.file(sheetRelsFile, sheetRels)

  // sheet 본문: drawing/legacyDrawing ref + oleObjects (3곳 일치, 순서 유지).
  const oleName = embName.replace(/\.[A-Za-z0-9]{1,8}$/, '')
  const progAttr = progId ? ` progId="${progId}"` : ''
  const oleEl =
    `<oleObject${progAttr} dvAspect="DVASPECT_ICON" shapeId="${shapeId}" r:id="${oleRelId}"><objectPr defaultSize="0" r:id="${imgRelId}"><anchor moveWithCells="1"><from><xdr:col>${fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></from><to><xdr:col>${toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></to></anchor></objectPr></oleObject>`
  const RNS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const parts: string[] = []
  if (drawingRelId && !/<[\w.-]*:?drawing\b[^>]*r:id=/.test(sheet)) parts.push(`<drawing ${RNS} r:id="${drawingRelId}"/>`)
  const vmlRelMatch = /Id="([^"]+)"[^>]*Target="[^"]*vmlDrawing[^"]*"/.exec(
    [...sheetRels.matchAll(/<[\w.-]*:?Relationship\b[^>]*Type="[^"]*\/vmlDrawing"[^>]*>/g)].map((x) => x[0])[0] ?? '',
  )
  const vmlRelId = vmlRelMatch?.[1]
  if (vmlRelId && !/legacyDrawing\b[^>]*r:id=/.test(sheet)) parts.push(`<legacyDrawing ${RNS} r:id="${vmlRelId}"/>`)
  if (sheet.includes('<oleObjects')) {
    sheet = sheet.replace(/(<oleObjects[^>]*>)([\s\S]*?)(<\/oleObjects>)/, (_, o, b, c) => `${o}${b}${oleEl}${c}`)
  } else {
    parts.push(`<oleObjects xmlns:xdr="${XLSX_NS_XDR}">${oleEl}</oleObjects>`)
  }
  if (parts.length > 0) {
    if (!sheet.includes('</worksheet>')) embedError('Unsupported sheet structure', 400, 'bad_host')
    const closeTag = `</${'worksheet'}>`
    sheet = sheet.replace(closeTag, `${parts.join('')}${closeTag}`)
  }
  zip!.file(sheetFile, sheet)

  // drawing anchor 추가.
  const drawingXml = (await readText(drawingFile as string)) ?? ''
  const anchor =
    `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
    `<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="${shapeId}" name="${oleName}" hidden="1"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr bwMode="auto"><a:xfrm xmlns:a="${XLSX_NS_A}"><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect" xmlns:a="${XLSX_NS_A}"><a:avLst/></a:prstGeom></xdr:spPr></xdr:sp><xdr:clientData/></xdr:twoCellAnchor>`
  if (drawingXml.includes('</xdr:wsDr>')) {
    zip!.file(drawingFile as string, drawingXml.replace('</xdr:wsDr>', `${anchor}</xdr:wsDr>`))
  } else if (drawingXml.includes('</wsDr>')) {
    zip!.file(drawingFile as string, drawingXml.replace('</wsDr>', `${anchor}</wsDr>`))
  } else {
    embedError('Unsupported drawing structure', 400, 'bad_host')
  }

  // VML shape 추가.
  const vml = (await readText(vmlFile as string)) ?? ''
  if (vml.includes('</xml>')) {
    const vmlRelsFile = (vmlFile as string).replace(/\/([^/]+)$/, '/_rels/$1.rels')
    const vmlRels = (await readText(vmlRelsFile)) ??
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
    const vmlImgId = nextRelId(vmlRels)
    zip!.file(
      vmlRelsFile,
      addRel(vmlRels, vmlImgId, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', `../media/${imgName}`),
    )
    let maxVml = shapeId
    const vm = /_x0000_s(\d+)/g
    let mm: RegExpExecArray | null
    while ((mm = vm.exec(vml)) !== null) maxVml = Math.max(maxVml, Number(mm[1]))
    const vShape =
      `<v:shape id="_x0000_s${maxVml + 1}" type="#_x0000_t75" style='position:absolute;margin-left:60pt;margin-top:${60 + shapeId}pt;width:60pt;height:41pt' filled="t" fillcolor="window [65]" stroked="t" strokecolor="windowText [64]">` +
      `<v:fill on="f"/><v:stroke on="f"/><v:imagedata o:relid="${vmlImgId}" o:title="" grayscale="f" bilevel="f"/><o:lock v:ext="edit" aspectratio="t" position="f" selection="f" grouping="f"/></v:shape>`
    zip!.file(vmlFile as string, vml.replace('</xml>', `${vShape}</xml>`))
  }

  let ct = (await readText('[Content_Types].xml')) ?? ''
  if (!ct) embedError('Host is not a valid Office file', 400, 'bad_host')
  ct = ensureContentDefault(ct, 'png', 'image/png')
  ct = ensureContentDefault(ct, 'vml', 'application/vnd.openxmlformats-officedocument.vmlDrawing')
  ct = ensureContentOverride(ct, `xl/embeddings/${embName}`, ATTACH_MIME[input.attachKind])
  if (drawingFile && !ct.includes(drawingFile)) {
    ct = ensureContentOverride(ct, drawingFile, 'application/vnd.openxmlformats-officedocument.drawing+xml')
  }
  zip!.file('[Content_Types].xml', ct)
  return zip!.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

function resolveZipPathTest(baseFile: string, target: string): string {
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

export interface DocxEmbedInput {
  hostBytes: Uint8Array
  attachBytes: Uint8Array
  attachName: string
  attachKind: EmbedAttachKind
}

const DOCX_PROG_ID: Record<EmbedAttachKind, string | null> = {
  docx: 'Word.Document.12',
  xlsx: 'Excel.Sheet.12',
  pptx: null,
}

/**
 * DOCX에 OLE 개체를 넣는다 (문서 끝 새 문단).
 * - word/embeddings/<name> + 미리보기 PNG + document rels 2개(package/image).
 * - w:object (VML shape + o:OLEObject) 새 문단 1개.
 */
export async function assembleDocxEmbed(
  zipLoad: (b: Uint8Array) => Promise<ZipLike>,
  input: DocxEmbedInput,
): Promise<Uint8Array> {
  let zip: ZipLike
  try {
    zip = await zipLoad(input.hostBytes)
  } catch {
    embedError('Host is not a valid Office file', 400, 'bad_host')
  }
  const readText = async (name: string): Promise<string | null> => {
    const f = zip!.files[name]
    if (!f || f.dir) return null
    try {
      return (await f.async('string')) as string
    } catch {
      return null
    }
  }
  const docXml = await readText('word/document.xml')
  if (!docXml || !docXml.includes('<w:document')) embedError('Host is not a valid Office file', 400, 'bad_host')
  let doc = docXml as string

  const safeName = sanitizeEmbedName(input.attachName, input.attachKind)
  let embName = safeName
  for (let i = 2; zip!.files[`word/embeddings/${embName}`]; i++) {
    embName = safeName.replace(/(\.[A-Za-z0-9]{1,8})$/, `-${i}$1`)
  }
  const progId = DOCX_PROG_ID[input.attachKind]
  const oleName = embName.replace(/\.[A-Za-z0-9]{1,8}$/, '')

  // 미리보기 PNG (빈 슬롯).
  let imgN = 1
  while (zip!.files[`word/media/image${imgN}.png`] || zip!.files[`word/media/image${imgN}.emf`]) imgN++
  const imgName = `image${imgN}.png`
  zip!.file(`word/media/${imgName}`, genericIconPng())
  zip!.file(`word/embeddings/${embName}`, input.attachBytes)

  // document rels.
  const docRelsFile = 'word/_rels/document.xml.rels'
  let docRels = (await readText(docRelsFile)) ??
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
  const oleRelId = nextRelId(docRels)
  docRels = addRel(
    docRels,
    oleRelId,
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/package',
    `embeddings/${embName}`,
  )
  const imgRelId = nextRelId(docRels)
  docRels = addRel(
    docRels,
    imgRelId,
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
    `media/${imgName}`,
  )
  zip!.file(docRelsFile, docRels)

  // shape id.
  let maxShape = 1024
  for (const m of doc.matchAll(/_x0000_i(\d+)/g)) maxShape = Math.max(maxShape, Number(m[1]))
  const shapeId = `_x0000_i${maxShape + 1}`
  const objectId = `_${Math.floor(Math.random() * 2 ** 31)}`
  const progAttr = progId ? ` ProgID="${progId}"` : ''
  const para =
    `<w:p><w:r><w:object w:dxaOrig="1480" w:dyaOrig="1028"><v:shape id="${shapeId}" type="#_x0000_t75" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" style="width:74pt;height:51.35pt" o:ole=""><v:imagedata r:id="${imgRelId}" o:title="" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></v:shape>` +
    `<o:OLEObject Type="Embed"${progAttr} ShapeID="${shapeId}" DrawAspect="Icon" ObjectID="${objectId}" r:id="${oleRelId}" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><o:FieldCodes>\\s</o:FieldCodes></o:OLEObject></w:object></w:r></w:p>`
  if (doc.includes('</w:body>')) {
    doc = doc.replace('</w:body>', `${para}</w:body>`)
  } else {
    embedError('Unsupported document structure', 400, 'bad_host')
  }
  zip!.file('word/document.xml', doc)

  let ct = (await readText('[Content_Types].xml')) ?? ''
  if (!ct) embedError('Host is not a valid Office file', 400, 'bad_host')
  ct = ensureContentDefault(ct, 'png', 'image/png')
  ct = ensureContentOverride(ct, `word/embeddings/${embName}`, ATTACH_MIME[input.attachKind])
  zip!.file('[Content_Types].xml', ct)
  return zip!.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
