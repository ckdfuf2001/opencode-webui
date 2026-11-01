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
