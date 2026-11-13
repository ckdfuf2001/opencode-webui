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
import { createHash, randomUUID } from 'node:crypto'

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

/** 192x96 문서 아이콘 PNG (파랑 테두리 + 흰 바탕 + 줄무늬). pptx/xlsx 프레임(2:1)과
 * 종횡비가 같아 늘어나지 않는다 (고DPI에서도 깨지지 않음). */
export function genericIconPng(kind: EmbedAttachKind = 'docx'): Uint8Array {
  const W = 192
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
  // C7b: 가운데 칩 스타일 (흰 바탕+회색 테두리+클립 배지+문서 글리프).
  const LINE: [number, number, number] = [203, 213, 225]
  const GRAY: [number, number, number] = [148, 163, 184]
  const SLATE: [number, number, number] = [51, 65, 85]
  const PAPER: [number, number, number] = [241, 245, 249]
  const WHITE: [number, number, number] = [255, 255, 255]
  // 1px 테두리.
  rect(0, 0, W - 1, 0, LINE)
  rect(0, H - 1, W - 1, H - 1, LINE)
  rect(0, 0, 0, H - 1, LINE)
  rect(W - 1, 0, W - 1, H - 1, LINE)
  // 클립 배지 (좌상단 진회색 원).
  const bcx = 24
  const bcy = 24
  const br = 13
  for (let y = bcy - br - 1; y <= bcy + br + 1; y++) {
    for (let x = bcx - br - 1; x <= bcx + br + 1; x++) {
      const dx = x - bcx
      const dy = y - bcy
      if (dx * dx + dy * dy <= br * br) set(x, y, ...SLATE)
    }
  }
  // 클립 (흰색 타원 고리 + 안쪽 막대).
  for (let a = 0; a < 360; a += 3) {
    const rad = (a * Math.PI) / 180
    const ex = Math.round(bcx + 6 * Math.cos(rad))
    const ey = Math.round(bcy + 8.5 * Math.sin(rad))
    set(ex, ey, ...WHITE)
    set(ex + 1, ey, ...WHITE)
  }
  rect(bcx - 1, bcy - 4, bcx + 1, bcy + 8, WHITE)
  // 문서 글리프 (중앙) — 형식별 구분 (오버레이 iconForFile과 같은 기준).
  const gx0 = 74
  const gy0 = 14
  const gx1 = 134
  const gy1 = 82
  if (kind === 'xlsx') {
    // 표: 외곽 + 격자 + 초록 헤더행.
    const GREEN: [number, number, number] = [22, 163, 74]
    const HLIGHT: [number, number, number] = [220, 252, 231]
    rect(gx0, gy0, gx1, gy1, WHITE)
    rect(gx0, gy0, gx1, gy0 + 12, HLIGHT)
    rect(gx0, gy0, gx1, gy0, GREEN)
    rect(gx0, gy1, gx1, gy1, GRAY)
    rect(gx0, gy0, gx0, gy1, GRAY)
    rect(gx1, gy0, gx1, gy1, GRAY)
    rect(gx0, gy0 + 12, gx1, gy0 + 12, GREEN)
    for (let c = 1; c < 4; c++) {
      const x = gx0 + Math.round(((gx1 - gx0) * c) / 4)
      rect(x, gy0, x, gy1, GRAY)
    }
    for (let r = 1; r < 4; r++) {
      const y = gy0 + 12 + Math.round(((gy1 - gy0 - 12) * r) / 4)
      rect(gx0, y, gx1, y, GRAY)
    }
  } else if (kind === 'pptx') {
    // 슬라이드: 외곽 + 주황 제목바 + 불릿 2개.
    const ORANGE: [number, number, number] = [234, 88, 12]
    rect(gx0, gy0, gx1, gy1, WHITE)
    rect(gx0, gy0, gx1, gy0 + 14, ORANGE)
    rect(gx0, gy0, gx1, gy0, ORANGE)
    rect(gx0, gy1, gx1, gy1, GRAY)
    rect(gx0, gy0, gx0, gy1, GRAY)
    rect(gx1, gy0, gx1, gy1, GRAY)
    rect(gx0 + 8, gy0 + 24, gx0 + 12, gy0 + 28, SLATE)
    rect(gx0 + 16, gy0 + 24, gx1 - 8, gy0 + 28, GRAY)
    rect(gx0 + 8, gy0 + 36, gx0 + 12, gy0 + 40, SLATE)
    rect(gx0 + 16, gy0 + 36, gx1 - 20, gy0 + 40, GRAY)
  } else {
    // docx/기타: 문서 + 접힌 모서리 + 줄 3개 (첫 줄 파랑).
    const BLUE: [number, number, number] = [37, 99, 235]
    rect(gx0, gy0, gx1, gy1, PAPER)
    rect(gx0, gy0, gx1, gy0, GRAY)
    rect(gx0, gy1, gx1, gy1, GRAY)
    rect(gx0, gy0, gx0, gy1, GRAY)
    rect(gx1, gy0, gx1, gy1, GRAY)
    // 접힌 모서리 (우상단).
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j <= i; j++) set(gx1 - i, gy0 + j, ...WHITE)
      set(gx1 - i, gy0 + i, ...GRAY)
    }
    // 본문 줄 3개.
    rect(gx0 + 8, gy0 + 22, gx1 - 8, gy0 + 26, BLUE)
    rect(gx0 + 8, gy0 + 34, gx1 - 8, gy0 + 38, GRAY)
    rect(gx0 + 8, gy0 + 46, gx1 - 30, gy0 + 50, GRAY)
  }
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
  /** 0..1 슬라이드 내 상대 위치 (클릭 지점). 없으면 기존 우하단 고정. */
  xFrac?: number
  yFrac?: number
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
  zip.file(`ppt/media/${imgName}`, genericIconPng(input.attachKind))
  zip.file(`ppt/embeddings/${embName}`, input.attachBytes)
  zip.file(slideRelsFile, rels)

  // 새 cNvPr id / spid.
  let maxId = 0
  for (const m of slide.matchAll(/<p:cNvPr[^>]*\bid="(\d+)"/g)) maxId = Math.max(maxId, Number(m[1]))
  const frameId = maxId + 1
  let maxSp = 1024
  for (const m of slide.matchAll(/spid="_x0000_s(\d+)"/g)) maxSp = Math.max(maxSp, Number(m[1]))
  const spid = `_x0000_s${maxSp + 1}`
  // 배치: 클릭 위치(x/y 0..1)가 있으면 그 자리, 없으면 기존 우하단 고정.
  // 슬라이드 크기는 presentation.xml sldSz에서 읽고, 없으면 기본 13.33x7.5in.
  const extCx = 1296000
  const extCy = 648000
  const presXml = await readText('ppt/presentation.xml')
  let sldCx = 12192000
  let sldCy = 6858000
  if (presXml) {
    const mSz =
      /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"|<p:sldSz\b[^>]*\bcy="(\d+)"[^>]*\bcx="(\d+)"/.exec(presXml)
    if (mSz) {
      const cx = Number(mSz[1] ?? mSz[4])
      const cy = Number(mSz[2] ?? mSz[3])
      if (Number.isFinite(cx) && cx > extCx) sldCx = cx
      if (Number.isFinite(cy) && cy > extCy) sldCy = cy
    }
  }
  const clamp01 = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null
  const fx = clamp01(input.xFrac)
  const fy = clamp01(input.yFrac)
  const offX = fx === null ? 7315200 : Math.round(fx * (sldCx - extCx))
  const offY = fy === null ? 5486400 : Math.round(fy * (sldCy - extCy))
  const oleName = embName.replace(/\.[A-Za-z0-9]{1,8}$/, '')
  const progAttr = progId ? ` progId="${progId}"` : ''
  const creationId = randomUUID().toUpperCase()
  const frame =
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${frameId}" name="${oleName}"><a:extLst><a:ext uri="{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}"><a16:creationId xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main" id="{${creationId}}"/></a:ext></a:extLst></p:cNvPr><p:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${offX}" y="${offY}"/><a:ext cx="${extCx}" cy="${extCy}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole"><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:v="urn:schemas-microsoft-com:vml" Requires="v"><p:oleObj spid="${spid}" name="${oleName}" showAsIcon="1" r:id="${embRelId}" imgW="${extCx}" imgH="${extCy}"${progAttr}><p:embed/></p:oleObj></mc:Choice><mc:Fallback><p:oleObj name="${oleName}" showAsIcon="1" r:id="${embRelId}" imgW="${extCx}" imgH="${extCy}"${progAttr}><p:embed/><p:pic><p:nvPicPr><p:cNvPr id="0" name=""/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${imgRelId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${offX}" y="${offY}"/><a:ext cx="${extCx}" cy="${extCy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:oleObj></mc:Fallback></mc:AlternateContent></a:graphicData></a:graphic></p:graphicFrame>`
  if (!slide.includes('</p:spTree>')) embedError('Unsupported slide structure', 400, 'bad_slide')
  const newSlide = slide.replace('</p:spTree>', `${frame}</p:spTree>`)
  checkBalancedXml(newSlide, slideFile)
  zip.file(slideFile, newSlide)

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
      const shape = `<v:shape id="${spid}" type="#_x0000_t75" style='position:absolute;left:${offX / 12700}pt;top:${offY / 12700}pt;width:102pt;height:51pt'><v:fill on="f"/><v:stroke on="f"/><v:imagedata o:relid="${vmlImgId}" o:title="" grayscale="f" bilevel="f"/><o:lock v:ext="edit" aspectratio="t" position="f" selection="f" grouping="f"/></v:shape>`
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

/**
 * 조립한 XML의 태그 균형을 검사한다 (깨진 바이트 기록 방지, fail-closed).
 * 코멘트/CDATA는 제외하고 검사한다.
 */
export function checkBalancedXml(xml: string, what: string): void {
  const clean = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<!--[\s\S]*?-->/g, '')
  const stack: string[] = []
  const re = /<(\/?)([\w:.-]+)([^>]*?)(\/?)>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(clean)) !== null) {
    const closing = m[1] ?? ''
    const name = m[2] ?? ''
    const attrs = m[3] ?? ''
    const selfclose = m[4] ?? ''
    if (!name || name[0] === '?' || name[0] === '!') continue
    if (selfclose === '/' || /\/\s*$/.test(attrs)) continue
    if (closing === '/') {
      const top = stack.pop()
      if (top !== name) embedError(`Unbalanced XML in ${what}`, 500, 'bad_assembly')
    } else {
      stack.push(name)
    }
  }
  if (stack.length > 0) embedError(`Unbalanced XML in ${what}`, 500, 'bad_assembly')
}

export interface XlsxEmbedInput {
  hostBytes: Uint8Array
  attachBytes: Uint8Array
  attachName: string
  attachKind: EmbedAttachKind
  /** 0-based 시트 순서 (기본 0). */
  sheet?: number
  /** 0-based 클릭 셀 (없으면 사용 영역 아래 빈 행). */
  cellCol?: number
  cellRow?: number
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
 * XLSX에 문서 첨부를 넣는다 (drawing + oleObjects + VML 3곳 일치).
 * - embeddings + 미리보기 PNG + sheet rels (package/image/drawing/vmlDrawing).
 *   office 첨부는 package rel이다 (oleObject 요소의 progId가 package rel을 가리킨다).
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
  // 앵커 위치: 클릭 셀(cellCol/cellRow)이 있으면 그 셀, 없으면 사용 영역 아래 빈 행.
  let maxRow = 0
  for (const m of sheet.matchAll(/<row[^>]*\br="(\d+)"/g)) maxRow = Math.max(maxRow, Number(m[1]))
  const cellCol =
    typeof input.cellCol === 'number' && Number.isInteger(input.cellCol) && input.cellCol >= 0 && input.cellCol <= 16383
      ? input.cellCol
      : null
  const cellRow =
    typeof input.cellRow === 'number' && Number.isInteger(input.cellRow) && input.cellRow >= 0 && input.cellRow <= 1048575
      ? input.cellRow
      : null
  const fromRow = cellRow ?? (maxRow > 0 ? maxRow + 2 : 7)
  const fromCol = cellCol ?? 1
  const toCol = fromCol + 1
  const toRow = fromRow + 3

  // 미리보기 PNG (빈 슬롯).
  let imgN = 1
  while (zip!.files[`xl/media/image${imgN}.png`] || zip!.files[`xl/media/image${imgN}.emf`]) imgN++
  const imgName = `image${imgN}.png`
  zip!.file(`xl/media/${imgName}`, genericIconPng(input.attachKind))
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
  // P0-4: office 첨부(docx/xlsx/pptx)는 package rel로 조립한다.
  // <oleObject progId="Word.Document.12" ...> 요소는 유지하되 r:id가 package rel을
  // 가리킨다 (Excel이 OOXML 첨부를 저장하는 기본 형태). 진짜 OLE(CFB) 다운로드는
  // 기존 oleObject 파트(C5-1 경로)에만 남는다 — INSERT는 office만 받으므로 분기 없다.
  const oleRelId = nextRelId(sheetRels)
  sheetRels = addRel(
    sheetRels,
    oleRelId,
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/package',
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
  // xdr 접두사는 oleEl 자체에 선언한다 — 기존 <oleObjects>에 덧붙일 때
  // (lib 저장본의 xmlns:x14 형태) 호스트 선언과 무관하게 유효하다.
  const oleEl =
    `<oleObject${progAttr} dvAspect="DVASPECT_ICON" shapeId="${shapeId}" xmlns:xdr="${XLSX_NS_XDR}" r:id="${oleRelId}"><objectPr defaultSize="0" r:id="${imgRelId}"><anchor moveWithCells="1"><from><xdr:col>${fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></from><to><xdr:col>${toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></to></anchor></objectPr></oleObject>`
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
    checkBalancedXml(sheet, sheetFile)
  }
  zip!.file(sheetFile, sheet)

  // drawing anchor (pic: lib가 네이티브 렌더+이동+저장. ole 바인딩은 sheet oleObjects가 담당).
  // cNvPr name/id는 ole와 일치시킨다 (오버레이가 img alt로 찾는다).
  // drawing rels를 먼저 만들어 blip r:embed id를 확정한다.
  const drawingRelsFile = (drawingFile as string).replace(/\/([^/]+)$/, '/_rels/$1.rels')
  const drawingRels = (await readText(drawingRelsFile)) ??
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
  const drawingImgRelId = nextRelId(drawingRels)
  zip!.file(
    drawingRelsFile,
    addRel(drawingRels, drawingImgRelId, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', `../media/${imgName}`),
  )
  const drawingXml = (await readText(drawingFile as string)) ?? ''
  const anchor =
    `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
    `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${shapeId}" name="${oleName}"/><xdr:cNvPicPr/></xdr:nvPicPr>` +
    `<xdr:blipFill><a:blip r:embed="${drawingImgRelId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
    `<xdr:spPr><a:xfrm xmlns:a="${XLSX_NS_A}"><a:off x="0" y="0"/><a:ext cx="1828800" cy="1270000"/></a:xfrm><a:prstGeom prst="rect" xmlns:a="${XLSX_NS_A}"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`
  if (drawingXml.includes('</xdr:wsDr>')) {
    const next = drawingXml.replace('</xdr:wsDr>', `${anchor}</xdr:wsDr>`)
    checkBalancedXml(next, drawingFile as string)
    zip!.file(drawingFile as string, next)
  } else if (drawingXml.includes('</wsDr>')) {
    const next = drawingXml.replace('</wsDr>', `${anchor}</wsDr>`)
    checkBalancedXml(next, drawingFile as string)
    zip!.file(drawingFile as string, next)
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
      `<v:shape id="_x0000_s${maxVml + 1}" type="#_x0000_t75" style='position:absolute;margin-left:${fromCol * 48}pt;margin-top:${fromRow * 15}pt;width:144pt;height:100pt' filled="t" fillcolor="window [65]" stroked="t" strokecolor="windowText [64]">` +
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
  /** 0-based 최상위 문단 (그 뒤에 삽입, 없으면 문서 끝). */
  block?: number
  /**
   * C7: block 문단의 텍스트 앞부분 (클라이언트 힌트). 클라이언트와 서버의
   * 문단 목록이 다를 수 있어(에디터 크롬 문단) 텍스트로 대조한다:
   * block 위치의 텍스트가 다르면 텍스트가 일치하는 첫 문단 뒤에 둔다.
   */
  blockText?: string
  /** C7b: 앵커 해시 (blockText 정규화 해시와 일치하는 블록 우선). */
  anchorHash?: string
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
  zip!.file(`word/media/${imgName}`, genericIconPng(input.attachKind))
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
    `<w:p><w:r><w:object w:dxaOrig="1920" w:dyaOrig="960"><v:shape id="${shapeId}" type="#_x0000_t75" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" style="width:96pt;height:48pt" o:ole=""><v:imagedata r:id="${imgRelId}" o:title="" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></v:shape>` +
    `<o:OLEObject Type="Embed"${progAttr} ShapeID="${shapeId}" DrawAspect="Icon" ObjectID="${objectId}" r:id="${oleRelId}" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><o:FieldCodes>\\s</o:FieldCodes></o:OLEObject></w:object></w:r></w:p>`
  if (doc.includes('</w:body>')) {
    // block(0-based 최상위 블록)이 있으면 그 뒤, 없으면 문서 끝.
    // C7b: 직계 w:p/w:tbl만 센다 (표 안·텍스트상자 안 문단 제외).
    // 텍스트 힌트가 있으면 앵커 해시로 먼저 찾는다 (클라이언트 크롬 문단으로
    // 인덱스가 어긋날 수 있고, innerText에 lib 렌더 잔재가 섞임).
    const blocks = topLevelBlocks(doc)
    const matches = (a: string, b: string): boolean => {
      const norm = (t: string): string => t.replace(/\s+/g, ' ').trim()
      const na = norm(a)
      const nb = norm(b)
      if (na.length < 8 || nb.length < 8) return false
      return na.includes(nb) || nb.includes(na)
    }
    const insertAfterBlock = (bi: number): string | null => {
      const b = blocks[bi]
      if (!b) return null
      return doc.slice(0, b.end) + para + doc.slice(b.end)
    }
    let next: string | null = null
    const wantBlock =
      typeof input.block === 'number' && Number.isInteger(input.block) && input.block >= 0 ? input.block : null
    const wantText = typeof input.blockText === 'string' && input.blockText.length > 0 ? input.blockText.slice(0, 60) : null
    const wantHash = typeof input.anchorHash === 'string' && input.anchorHash.length > 0 ? input.anchorHash : null
    // 0) 저장된 앵커 해시 일치 (가장 정확).
    if (wantHash !== null) {
      const idx = blocks.findIndex((b) => anchorHashOf(b.text) === wantHash)
      if (idx >= 0) next = insertAfterBlock(idx)
    }
    // 1) 텍스트 힌트 일치 (인덱스 어긋남에 강함).
    if (next === null && wantText !== null) {
      const textHash = anchorHashOf(wantText)
      let idx = blocks.findIndex((b) => anchorHashOf(b.text) === textHash)
      if (idx < 0) idx = blocks.findIndex((b) => matches(b.text, wantText))
      if (idx >= 0) next = insertAfterBlock(idx)
    }
    // 2) 인덱스 (텍스트가 없으면 그대로).
    if (next === null && wantBlock !== null && wantText === null && wantHash === null) {
      next = insertAfterBlock(wantBlock)
    }
    if (next === null) next = doc.replace('</w:body>', `${para}</w:body>`)
    checkBalancedXml(next, 'word/document.xml')
    doc = next
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

/* ---------- C5-3: 첨부 읽기/교체 (GET/PUT /api/collab/embed) ---------- */

export interface EmbedPartInfo {
  /** zip 안 정규 경로 (예: xl/embeddings/report.docx). */
  part: string
  relType: 'package' | 'oleObject'
  /** rels에 적힌 원문 Target. */
  target: string
}

const EMBED_REL_RE =
  /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/(package|oleObject)"[^>]*Target="([^"]+)"/g

/**
 * part 경로 문법 검증 (역참조·절대경로·역슬래시·빈 조각 거부).
 * rels 대조는 하지 않는다 (read/replace에서 수행).
 */
export function normalizeEmbedPart(raw: string): string {
  if (typeof raw !== 'string' || !raw) embedError('Bad part', 400, 'bad_part')
  const p = raw.replace(/\\/g, '/')
  if (!p || p.startsWith('/') || p.includes('\0')) embedError('Bad part', 400, 'bad_part')
  const segs = p.split('/')
  if (segs.some((s) => s === '' || s === '.' || s === '..')) embedError('Bad part', 400, 'bad_part')
  return segs.join('/')
}

/**
 * C7: N번째 최상위 문단의 텍스트 앞부분 (클라이언트 칩 위치 찾기용 힌트).
 * 없으면 빈 문자열 (인덱스로 폴백한다).
 */
export function blockTextSnippet(docXml: string, block: number): string {
  try {
    const blocks = topLevelBlocks(docXml)
    const b = blocks[block]
    if (!b) return ''
    return b.text.slice(0, 60)
  } catch {
    /* 무시 */
  }
  return ''
}

/** w:body 직계 블록 (문단/표). 중첩 문단·텍스트상자 안은 제외. */
export interface DocxBlock {
  tag: 'p' | 'tbl'
  start: number
  end: number
  text: string
}

/**
 * C7b: w:body 직계 w:p/w:tbl 목록 (중첩 제외). 단순 정규식 카운트는
 * 표 안·텍스트상자 안 문단까지 세서 어긋난다.
 */
export function topLevelBlocks(docXml: string): DocxBlock[] {
  const out: DocxBlock[] = []
  try {
    const bodyOpen = docXml.indexOf('<w:body')
    if (bodyOpen < 0) return out
    const bodyStart = docXml.indexOf('>', bodyOpen)
    const bodyClose = docXml.lastIndexOf('</w:body>')
    if (bodyStart < 0 || bodyClose < 0 || bodyClose <= bodyStart) return out
    const body = docXml.slice(bodyStart + 1, bodyClose)
    const base = bodyStart + 1
    // w:p / w:tbl 여닫기 토큰을 순서대로 훑으며 스택으로 직계만 모은다.
    const re = /<\/?w:(p|tbl)(?=[\s>/])/g
    const stack: Array<{ tag: 'p' | 'tbl'; start: number }> = []
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) !== null) {
      const isClose = m[0].startsWith('</')
      const tag = (m[1] === 'tbl' ? 'tbl' : 'p') as 'p' | 'tbl'
      if (!isClose) {
        if (stack.length === 0) stack.push({ tag, start: base + m.index })
        else stack.push({ tag, start: -1 })
      } else {
        const top = stack.pop()
        if (!top) continue
        if (top.start >= 0 && stack.length === 0) {
          const endTag = tag === 'p' ? '</w:p>' : '</w:tbl>'
          const endAt = body.indexOf(endTag, m.index)
          if (endAt >= 0) {
            const end = base + endAt + endTag.length
            const inner = docXml.slice(top.start, end)
            const texts: string[] = []
            const tr = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g
            let tm: RegExpExecArray | null
            while ((tm = tr.exec(inner)) !== null && texts.join('').length < 120) texts.push(tm[1] ?? '')
            out.push({ tag: top.tag, start: top.start, end, text: texts.join('') })
          }
        }
      }
    }
  } catch {
    /* 무시 — 빈 목록 */
  }
  return out
}

/** C7b: 앵커 텍스트 해시 (공백 정규화 뒤 sha256 앞 16자). 위치 저장용. */
export interface EmbedPos {
  slide?: number
  x?: number
  y?: number
  sheet?: number
  col?: number
  row?: number
  block?: number
  text?: string
}

/**
 * C7c-0: 같은 곳 겹침 방지. 같은 슬라이드/시트에 이미 있으면 아이콘 크기만큼 비켜 놓는다.
 * - pptx: 가운데(0.5,0.5)에서 n번째는 (+0.12,+0.08)씩 (0.9 상한).
 * - xlsx: (col+n,row+n) 대각선 (상한 클램프).
 * - docx: 흐름 배치라 겹치지 않음 (그대로).
 * existing는 같은 슬라이드/시트로 미리 걸러서 넘긴다.
 */
/** C7c: 디스크에서 임베딩 위치를 역추적한다 (예전 첨부 백필용).
 * - pptx: 각 슬라이드의 ole graphicFrame (a:off → sldSz 기준 fractions).
 * - xlsx: sheet oleObjects + drawing 앵커 (shapeId 일치 → col/row).
 * - docx: w:object 단락 (topLevel 순서 → block + text).
 * 반환 pos는 assemble 입력과 같은 좌표계 ( fractions / 0-based cell / block ).
 */
export interface BackfilledEmbed {
  part: string
  name: string
  pos: EmbedPos
}

export async function listEmbedPositions(
  zipLoad: (b: Uint8Array) => Promise<ZipLike>,
  hostBytes: Uint8Array,
  hostKind: 'pptx' | 'xlsx' | 'docx',
): Promise<BackfilledEmbed[]> {
  const out: BackfilledEmbed[] = []
  const zip = await zipLoad(hostBytes)
  const readText = async (name: string): Promise<string | null> => {
    try {
      const f = zip.files[name]
      if (!f || f.dir) return null
      return (await f.async('string')) as string
    } catch {
      return null
    }
  }
  const relTarget = (relsXml: string, id: string): string | null => {
    const m = new RegExp(`<[^>]*?Id="${id}"[^>]*?Target="([^"]+)"`).exec(relsXml)
    return m?.[1] ?? null
  }
  const resolveRel = (base: string, target: string): string => {
    if (target.startsWith('/')) return target.slice(1)
    const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : ''
    const parts = (dir + target).split('/')
    const stack: string[] = []
    for (const q of parts) {
      if (q === '.' || q === '') continue
      if (q === '..') stack.pop()
      else stack.push(q)
    }
    return stack.join('/')
  }
  if (hostKind === 'pptx') {
    const pres = (await readText('ppt/presentation.xml')) ?? ''
    let sldCx = 12192000
    let sldCy = 6858000
    const szm = /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(pres) ?? /<p:sldSz[^>]*cy="(\d+)"[^>]*cx="(\d+)"/.exec(pres)
    if (szm) { sldCx = Number(szm[1]); sldCy = Number(szm[2]) }
    const presRels = (await readText('ppt/_rels/presentation.xml.rels')) ?? ''
    const sldIds = [...pres.matchAll(/<p:sldId[^>]*r:id="([^"]+)"/g)].map((m) => m[1]!)
    for (let si = 0; si < sldIds.length; si++) {
      const tgt = relTarget(presRels, sldIds[si]!)
      if (!tgt) continue
      const slideFile = resolveRel('ppt/presentation.xml', tgt)
      const slide = (await readText(slideFile)) ?? ''
      if (!slide) continue
      const slideRels = (await readText(slideFile.replace(/\/([^/]+)$/, '/_rels/$1.rels'))) ?? ''
      const frames = [...slide.matchAll(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g)].map((m) => m[0])
      for (const fr of frames) {
        const off = /<a:off x="(\d+)" y="(\d+)"/.exec(fr)
        const ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(fr)
        const ole = /<p:oleObj[^>]*r:id="([^"]+)"/.exec(fr)
        if (!off || !ole) continue
        const embTgt = relTarget(slideRels, ole[1]!)
        if (!embTgt || embTgt.indexOf('embeddings/') < 0) continue
        const embFile = resolveRel(slideFile, embTgt)
        const name = embFile.split('/').pop() ?? embFile
        // 조립은 off = frac*(sld-ext)로 넣는다 (도형 가운데 정렬) — 역산한다.
        const ecxv = ext ? Number(ext[1]) : 0
        const ecyv = ext ? Number(ext[2]) : 0
        const denx = sldCx - ecxv > 0 ? sldCx - ecxv : sldCx
        const deny = sldCy - ecyv > 0 ? sldCy - ecyv : sldCy
        out.push({ part: embFile, name, pos: { slide: si + 1, x: Number(off[1]) / denx, y: Number(off[2]) / deny } })
      }
    }
    return out
  }
  if (hostKind === 'xlsx') {
    const wb = (await readText('xl/workbook.xml')) ?? ''
    const wbRels = (await readText('xl/_rels/workbook.xml.rels')) ?? ''
    const sheets = [...wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map((m) => ({ name: m[1]!, rid: m[2]! }))
    if (sheets.length === 0) {
      for (const m of wb.matchAll(/<sheet[^>]*r:id="([^"]+)"[^>]*name="([^"]+)"/g)) sheets.push({ name: m[2]!, rid: m[1]! })
    }
    for (let si = 0; si < sheets.length; si++) {
      const tgt = relTarget(wbRels, sheets[si]!.rid)
      if (!tgt) continue
      const sheetFile = resolveRel('xl/workbook.xml', tgt)
      const sheet = (await readText(sheetFile)) ?? ''
      if (!sheet) continue
      const sheetRels = (await readText(sheetFile.replace(/\/([^/]+)$/, '/_rels/$1.rels'))) ?? ''
      const oleEls = [...sheet.matchAll(/<oleObject[^>]*shapeId="(\d+)"[^>]*r:id="([^"]+)"|<oleObject[^>]*r:id="([^"]+)"[^>]*shapeId="(\d+)"/g)]
      if (oleEls.length === 0) continue
      // drawing 앵커 (shapeId 일치).
      let drawingAnchors: Array<{ id: string; col: number; row: number }> = []
      const drTgt = [...sheetRels.matchAll(/<[^>]*?Id="([^"]+)"[^>]*?Target="([^"]*drawing[^"]*)"/g)].map((m) => ({ id: m[1]!, tgt: m[2]! }))
      for (const d of drTgt) {
        const dFile = resolveRel(sheetFile, d.tgt)
        const dXml = (await readText(dFile)) ?? ''
        if (!dXml) continue
        for (const am of dXml.matchAll(/<xdr:twoCellAnchor>[\s\S]*?<\/xdr:twoCellAnchor>/g)) {
          const a = am[0]
          const idm = /<xdr:cNvPr[^>]*id="(\d+)"/.exec(a)
          const fromm = /<xdr:from><xdr:col>(\d+)<\/xdr:col>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/.exec(a)
          if (idm && fromm) drawingAnchors.push({ id: idm[1]!, col: Number(fromm[1]), row: Number(fromm[2]) })
        }
      }
      for (const om of oleEls) {
        const shapeId = om[1] ?? om[4] ?? ''
        const rid = om[2] ?? om[3] ?? ''
        const embTgt = relTarget(sheetRels, rid)
        if (!embTgt || embTgt.indexOf('embeddings/') < 0) continue
        const embFile = resolveRel(sheetFile, embTgt)
        const anch = drawingAnchors.find((a) => a.id === shapeId)
        if (!anch) continue
        out.push({ part: embFile, name: embFile.split('/').pop() ?? embFile, pos: { sheet: si, col: anch.col, row: anch.row } })
      }
    }
    return out
  }
  // docx: w:object 단락 (topLevel 순서 → block + text).
  {
    const doc = (await readText('word/document.xml')) ?? ''
    if (!doc) return out
    const body = /<w:body[\s\S]*?<\/w:body>/.exec(doc)?.[0] ?? doc
    const blocks = [...body.matchAll(/<(w:p|w:tbl)[\s>][\s\S]*?<\/\1>/g)].map((m) => m[0])
    const docRels = (await readText('word/_rels/document.xml.rels')) ?? ''
    blocks.forEach((blk, bi) => {
      for (const om of blk.matchAll(/<o:OLEObject[^>]*r:id="([^"]+)"/g)) {
        const embTgt = relTarget(docRels, om[1]!)
        if (!embTgt || embTgt.indexOf('embeddings/') < 0) continue
        const embFile = resolveRel('word/document.xml', embTgt)
        const text = blk.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
        out.push({ part: embFile, name: embFile.split('/').pop() ?? embFile, pos: { block: bi, text } })
      }
    })
    return out
  }
}

export function offsetOverlap(
  hostKind: 'pptx' | 'xlsx' | 'docx',
  req: EmbedPos,
  existing: EmbedPos[],
): EmbedPos {
  // C7d: 실제로 겹치는 것만 센다 (멀리 있는 기존분은 무시).
  let close = existing
  if (hostKind === 'pptx') {
    const bx0 = req.x ?? 0.5
    const by0 = req.y ?? 0.5
    close = existing.filter((e) => Math.hypot((e.x ?? 0.5) - bx0, (e.y ?? 0.5) - by0) < 0.15)
  } else if (hostKind === 'xlsx') {
    close = existing.filter((e) => e.col === req.col && e.row === req.row)
  }
  const n = close.length
  if (n === 0) return { ...req }
  if (hostKind === 'pptx') {
    const bx = req.x ?? 0.5
    const by = req.y ?? 0.5
    return { ...req, x: Math.min(0.9, bx + n * 0.12), y: Math.min(0.9, by + n * 0.08) }
  }
  if (hostKind === 'xlsx') {
    return { ...req, col: Math.min(16383, (req.col ?? 0) + n), row: Math.min(1048575, (req.row ?? 0) + n) }
  }
  return { ...req }
}

/**
 * C7e: pptx 임베딩 이동/리사이즈 (a:off/a:ext + VML 동기화). fractions 기준.
 * 조립과 같은 중심 규칙 (off = frac*(sld-ext)) 을 쓴다.
 */
export async function movePptxEmbed(
  zipLoad: (b: Uint8Array) => Promise<ZipLike>,
  hostBytes: Uint8Array,
  embPart: string,
  pos: { slide?: number; x?: number; y?: number; w?: number; h?: number },
): Promise<{ bytes: Uint8Array; found: boolean }> {
  const zip = await zipLoad(hostBytes)
  const readText = async (name: string): Promise<string | null> => {
    try {
      const f = zip.files[name]
      if (!f || f.dir) return null
      return (await f.async('string')) as string
    } catch {
      return null
    }
  }
  const relTarget = (relsXml: string, id: string): string | null => {
    const m = new RegExp(`<[^>]*?Id="${id}"[^>]*?Target="([^"]+)"`).exec(relsXml)
    return m?.[1] ?? null
  }
  const resolveRel = (base: string, target: string): string => {
    if (target.startsWith('/')) return target.slice(1)
    const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : ''
    const parts = (dir + target).split('/')
    const stack: string[] = []
    for (const q of parts) {
      if (q === '.' || q === '') continue
      else if (q === '..') stack.pop()
      else stack.push(q)
    }
    return stack.join('/')
  }
  const pres = (await readText('ppt/presentation.xml')) ?? ''
  let sldCx = 12192000
  let sldCy = 6858000
  const szm = /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(pres) ?? /<p:sldSz[^>]*cy="(\d+)"[^>]*cx="(\d+)"/.exec(pres)
  if (szm) {
    sldCx = Number(szm[1])
    sldCy = Number(szm[2])
  }
  const presRels = (await readText('ppt/_rels/presentation.xml.rels')) ?? ''
  const sldIds = [...pres.matchAll(/<p:sldId[^>]*r:id="([^"]+)"/g)].map((m) => m[1]!)
  if (pos.slide !== undefined && (pos.slide < 1 || pos.slide > sldIds.length)) {
    embedError('Bad slide', 400, 'bad_slide')
  }
  const indices = pos.slide !== undefined ? [pos.slide - 1] : sldIds.map((_, i) => i)
  let done = false
  for (const si of indices) {
    const tgt = relTarget(presRels, sldIds[si]!)
    if (!tgt) continue
    const slideFile = tgt.startsWith('/') ? tgt.slice(1) : 'ppt/' + tgt.replace(/^\.\.\//, '')
    const slide = (await readText(slideFile)) ?? ''
    if (!slide) continue
    const slideRels = (await readText(slideFile.replace(/\/([^/]+)$/, '/_rels/$1.rels'))) ?? ''
    let changed = slide
    let slideDirty = false
    const frames = [...slide.matchAll(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g)].map((m) => m[0])
    for (const fr of frames) {
      const ole = /<p:oleObj[^>]*r:id="([^"]+)"/.exec(fr)
      if (!ole) continue
      const embTgt = relTarget(slideRels, ole[1]!)
      if (!embTgt || resolveRel(slideFile, embTgt) !== embPart) continue
      const offm = /<a:off x="(\d+)" y="(\d+)"/.exec(fr)
      const extm = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(fr)
      if (!offm || !extm) continue
      const curCx = Number(extm[1])
      const curCy = Number(extm[2])
      const ncx = pos.w !== undefined ? Math.max(12700, Math.round(pos.w * sldCx)) : curCx
      const ncy = pos.h !== undefined ? Math.max(12700, Math.round(pos.h * sldCy)) : curCy
      const nx = pos.x !== undefined ? Math.round(pos.x * (sldCx - ncx)) : Number(offm[1])
      const ny = pos.y !== undefined ? Math.round(pos.y * (sldCy - ncy)) : Number(offm[2])
      const nfr = fr
        .replace(/<a:off x="\d+" y="\d+"/, `<a:off x="${nx}" y="${ny}"`)
        .replace(/<a:ext cx="\d+" cy="\d+"/, `<a:ext cx="${ncx}" cy="${ncy}"`)
      if (nfr !== fr) {
        changed = changed.replace(fr, nfr)
        slideDirty = true
      }
      // VML 동기화 (spid 일치).
      const spidm = /spid="(_x0000_s\d+)"/.exec(fr)
      const vmlTgt = [...slideRels.matchAll(/<[^>]*?Type="[^"]*\/vmlDrawing"[^>]*?Target="([^"]+)"|<[^>]*?Target="([^"]*vmlDrawing[^"]*)"[^>]*?Type="[^"]*\/vmlDrawing"/g)].map((m) => m[1] ?? m[2]).find(Boolean)
      if (spidm && vmlTgt) {
        const vmlFile = resolveRel(slideFile, vmlTgt)
        const vml = (await readText(vmlFile)) ?? ''
        if (vml.includes(`id="${spidm[1]}"`)) {
          const toPt = (emu: number): number => Math.round((emu / 12700) * 100) / 100
          const nv = vml.replace(
            new RegExp(`(<v:shape id="${spidm[1]}"[^>]*?style='[^']*?)(margin-left:[\\d.]+pt;[^']*?margin-top:[\\d.]+pt;)`),
            `$1margin-left:${toPt(nx)}pt;margin-top:${toPt(ny)}pt;`,
          )
          if (nv !== vml) {
            zip.file(vmlFile, nv)
          }
        }
      }
      done = true
    }
    if (slideDirty) {
      zip.file(slideFile, changed)
    }
  }
  if (!done) return { bytes: hostBytes, found: false }
  const out = await zip.generateAsync({ type: 'uint8array' })
  return { bytes: out, found: true }
}

/**
 * C7e: 파트의 미리보기 PNG 바이트 (shape blip → media, 없으면 형식별 generic).
 */
export async function previewPngForPart(
  zipLoad: (b: Uint8Array) => Promise<ZipLike>,
  hostBytes: Uint8Array,
  hostKind: 'pptx' | 'xlsx' | 'docx',
  embPart: string,
  attachKind: EmbedAttachKind,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const generic = (): { bytes: Uint8Array; contentType: string } => ({ bytes: genericIconPng(attachKind), contentType: 'image/png' })
  try {
    const zip = await zipLoad(hostBytes)
    const readBin = async (name: string): Promise<Uint8Array | null> => {
      try {
        const f = zip.files[name]
        if (!f || f.dir) return null
        return (await f.async('uint8array')) as Uint8Array
      } catch {
        return null
      }
    }
    const readText = async (name: string): Promise<string | null> => {
      try {
        const f = zip.files[name]
        if (!f || f.dir) return null
        return (await f.async('string')) as string
      } catch {
        return null
      }
    }
    if (hostKind === 'pptx') {
      const pres = (await readText('ppt/presentation.xml')) ?? ''
      const presRels = (await readText('ppt/_rels/presentation.xml.rels')) ?? ''
      const sldIds = [...pres.matchAll(/<p:sldId[^>]*r:id="([^"]+)"/g)].map((m) => m[1]!)
      for (const sid of sldIds) {
        const tm = new RegExp(`<[^>]*?Id="${sid}"[^>]*?Target="([^"]+)"`).exec(presRels)
        if (!tm) continue
        const slideFile = tm[1]!.startsWith('/') ? tm[1]!.slice(1) : 'ppt/' + tm[1]!.replace(/^\.\.\//, '')
        const slide = (await readText(slideFile)) ?? ''
        if (!slide || slide.indexOf(embPart.split('/').pop() ?? '\0part') < 0) continue
        const slideRels = (await readText(slideFile.replace(/\/([^/]+)$/, '/_rels/$1.rels'))) ?? ''
        // oleObj r:id → package target 확인 후 같은 프레임의 blip을 찾는다.
        const frames = [...slide.matchAll(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g)].map((m) => m[0])
        for (const fr of frames) {
          const ole = /<p:oleObj[^>]*r:id="([^"]+)"/.exec(fr)
          if (!ole) continue
          const embTgt = new RegExp(`<[^>]*?Id="${ole[1]}"[^>]*?Target="([^"]+)"`).exec(slideRels)?.[1]
          if (!embTgt) continue
          const dir = slideFile.includes('/') ? slideFile.slice(0, slideFile.lastIndexOf('/') + 1) : ''
          const norm = (dir + embTgt).split('/').filter((q) => q !== '.' && q !== '').join('/').replace(/[^/]+\/\.\.\//g, '')
          const normParts: string[] = []
          for (const q of (dir + embTgt).split('/')) {
            if (q === '.' || q === '') continue
            else if (q === '..') normParts.pop()
            else normParts.push(q)
          }
          if (normParts.join('/') !== embPart && norm !== embPart) continue
          const blip = /<a:blip[^>]*r:embed="([^"]+)"/.exec(fr)
          if (!blip) continue
          const imgTgt = new RegExp(`<[^>]*?Id="${blip[1]}"[^>]*?Target="([^"]+)"`).exec(slideRels)?.[1]
          if (!imgTgt) continue
          const imgParts: string[] = []
          for (const q of (dir + imgTgt).split('/')) {
            if (q === '.' || q === '') continue
            else if (q === '..') imgParts.pop()
            else imgParts.push(q)
          }
          const imgFile = imgParts.join('/')
          const buf = await readBin(imgFile)
          if (buf) return { bytes: buf, contentType: imgFile.endsWith('.emf') ? 'image/x-emf' : imgFile.endsWith('.wmf') ? 'image/x-wmf' : 'image/png' }
        }
      }
    }
    // xlsx/docx는 후속 (지금은 generic).
    return generic()
  } catch {
    return generic()
  }
}

export function anchorHashOf(text: string): string {
  const norm = text.replace(/\s+/g, ' ').trim()
  if (!norm) return ''
  return createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 16)
}

/** rel Target을 rels 파일 기준으로 해석해 파트 경로로 바꾼다. */
export function resolveRelTarget(relsFile: string, target: string): string | null {
  if (!target || target.includes('\\')) return null
  if (target.startsWith('/')) return target.slice(1) || null
  const m = /^(.*)\/_rels\/[^/]+$/.exec(relsFile)
  if (!m) return null
  const parts = m[1]!.split('/')
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue
    else if (seg === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else parts.push(seg)
  }
  return parts.join('/')
}

/** 부모 zip에서 embeddings 파트 목록 (rels 기준, 중복 제거). */
export async function listEmbedParts(
  zipLoad: (b: Uint8Array) => Promise<ZipLike>,
  hostBytes: Uint8Array,
): Promise<EmbedPartInfo[]> {
  let zip: ZipLike
  try {
    zip = await zipLoad(hostBytes)
  } catch {
    embedError('Host is not a valid Office file', 400, 'bad_host')
  }
  const out: EmbedPartInfo[] = []
  const seen = new Set<string>()
  for (const rn of Object.keys(zip!.files)) {
    if (!rn.endsWith('.rels')) continue
    const f = zip!.files[rn]
    if (!f || f.dir) continue
    let text: string
    try {
      text = (await f.async('string')) as string
    } catch {
      continue
    }
    if (typeof text !== 'string') continue
    EMBED_REL_RE.lastIndex = 0
    let mm: RegExpExecArray | null
    while ((mm = EMBED_REL_RE.exec(text)) !== null) {
      const resolved = resolveRelTarget(rn, mm[2]!)
      if (!resolved || !resolved.includes('embeddings/')) continue
      if (seen.has(resolved)) continue
      seen.add(resolved)
      out.push({ part: resolved, relType: mm[1] as 'package' | 'oleObject', target: mm[2]! })
    }
  }
  return out
}

/** 임베딩 파트 바이트를 꺼낸다 (allowlist 대조 포함). */
export async function readEmbedPart(
  zipLoad: (b: Uint8Array) => Promise<ZipLike>,
  hostBytes: Uint8Array,
  part: string,
): Promise<{ bytes: Uint8Array; name: string; relType: 'package' | 'oleObject' }> {
  const norm = normalizeEmbedPart(part)
  let zip: ZipLike
  try {
    zip = await zipLoad(hostBytes)
  } catch {
    embedError('Host is not a valid Office file', 400, 'bad_host')
  }
  const parts = await listEmbedParts(zipLoad, hostBytes)
  const hit = parts.find((p) => p.part === norm)
  if (!hit) embedError('No such embedded part', 404, 'bad_part')
  const f = zip!.files[norm]
  if (!f || f.dir) embedError('No such embedded part', 404, 'bad_part')
  const bytes = new Uint8Array((await f!.async('uint8array')) as Uint8Array)
  return { bytes, name: norm.split('/').pop() ?? 'attachment.bin', relType: (hit as EmbedPartInfo).relType }
}

/** 임베딩 파트를 교체한 새 호스트 바이트를 만든다 (나머지 불변). */
export async function replaceEmbedPart(
  zipLoad: (b: Uint8Array) => Promise<ZipLike>,
  hostBytes: Uint8Array,
  part: string,
  newBytes: Uint8Array,
): Promise<Uint8Array> {
  const norm = normalizeEmbedPart(part)
  let zip: ZipLike
  try {
    zip = await zipLoad(hostBytes)
  } catch {
    embedError('Host is not a valid Office file', 400, 'bad_host')
  }
  const parts = await listEmbedParts(zipLoad, hostBytes)
  if (!parts.some((p) => p.part === norm)) embedError('No such embedded part', 404, 'bad_part')
  zip!.file(norm, newBytes)
  return zip!.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
