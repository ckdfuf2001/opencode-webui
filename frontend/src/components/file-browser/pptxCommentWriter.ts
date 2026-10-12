import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'

/**
 * ppt 코멘트 추가 (모던 형식). 우리 패널에서 달고 제자리 저장한다.
 * 문자열 수술로만 건드려서 네임스페이스 깨짐이 없다.
 */

const COMMENTS_REL_TYPE = 'http://schemas.microsoft.com/office/2018/10/relationships/comments'
const COMMENTS_CT = 'application/vnd.ms-powerpoint.comments+xml'
const NS_DECL =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main"'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
})

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const guid = () => `{${crypto.randomUUID().toUpperCase()}}`

function randomUserId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
}

function insertBeforeClose(xml: string, local: string, snippet: string): string | null {
  const re = new RegExp(`</(?:[\\w-]+:)?${local}>`)
  const m = re.exec(xml)
  if (!m || m.index === undefined) return null
  return `${xml.slice(0, m.index)}${snippet}${xml.slice(m.index)}`
}

type NameMap = Map<string, string>

function childByLocal(obj: Record<string, unknown>, local: string): unknown {
  for (const [k, v] of Object.entries(obj)) {
    const name = k.includes(':') ? k.slice(k.indexOf(':') + 1) : k
    if (name === local) return v
  }
  return undefined
}

function normPath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const segs: string[] = []
  for (const part of `${baseDir}/${target}`.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') segs.pop()
    else segs.push(part)
  }
  return segs.join('/')
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

export async function addPptxComment(
  bytes: Uint8Array,
  opts: { slideNo: number; authorName: string; text: string; pos?: { x: number; y: number } },
): Promise<Uint8Array> {
  const text = opts.text.trim()
  if (!text) throw new Error('empty comment')
  const authorName = opts.authorName.trim() || 'Me'
  const zip = await JSZip.loadAsync(bytes)
  const readText = async (path: string): Promise<string | null> => {
    const f = zip.file(path)
    return f ? f.async('string') : null
  }

  // 슬라이드 파트 찾기 (발표 순서 기준).
  const presXml = await readText('ppt/presentation.xml')
  if (!presXml) throw new Error('no presentation.xml')
  const pres = parser.parse(presXml) as Record<string, unknown>
  const presRoot = (childByLocal(pres, 'presentation') ?? pres) as Record<string, unknown>
  const sldIds = asArray(
    childByLocal((childByLocal(presRoot, 'sldIdLst') ?? {}) as Record<string, unknown>, 'sldId'),
  ) as Record<string, unknown>[]
  const sld = sldIds[Math.max(0, Math.min(opts.slideNo, sldIds.length)) - 1] as
    | Record<string, unknown>
    | undefined
  if (!sld) throw new Error('slide not found')
  const sldId = String(sld['@_id'] ?? '')
  const presRelsXml = await readText('ppt/_rels/presentation.xml.rels')
  if (!presRelsXml) throw new Error('no presentation rels')
  const presRels = parser.parse(presRelsXml) as Record<string, unknown>
  const relTargets = new Map<string, string>()
  for (const r of asArray(
    (childByLocal(presRels, 'Relationships') as Record<string, unknown> | undefined)?.[
      'Relationship'
    ],
  ) as Record<string, unknown>[]) {
    relTargets.set(String(r['@_Id'] ?? ''), String(r['@_Target'] ?? ''))
  }
  const slideTarget = relTargets.get(String(sld['@_r:id'] ?? sld['@_id'] ?? ''))
  if (!slideTarget) throw new Error('slide rel not found')
  const slidePath = slideTarget.startsWith('/') ? slideTarget.slice(1) : `ppt/${slideTarget}`
  const dir = slidePath.includes('/') ? slidePath.slice(0, slidePath.lastIndexOf('/')) : ''
  const base = slidePath.slice(slidePath.lastIndexOf('/') + 1)

  // 작성자 확보.
  let authorsXml = await readText('ppt/authors.xml')
  const nameToId: NameMap = new Map()
  if (authorsXml) {
    const doc = parser.parse(authorsXml) as Record<string, unknown>
    const lst = childByLocal(doc, 'authorLst')
    for (const a of asArray(childByLocal((lst ?? {}) as Record<string, unknown>, 'author'))) {
      const o = a as Record<string, unknown>
      if (o['@_id'] && o['@_name']) nameToId.set(String(o['@_name']), String(o['@_id']))
    }
  }
  let authorId = nameToId.get(authorName)
  if (!authorId) {
    authorId = guid()
    const initials = authorName.replace(/\s+/g, '').slice(0, 2).toUpperCase() || 'ME'
    // userId/providerId 없으면 데스크톱이 작성자를 못 읽는다.
    const snippet =
      `<p188:author id="${authorId}" name="${esc(authorName)}" initials="${esc(initials)}" ` +
      `userId="${randomUserId()}" providerId="Windows Live"/>`
    if (authorsXml) {
      const next = insertBeforeClose(authorsXml, 'authorLst', snippet)
      if (!next) throw new Error('authors.xml shape unknown')
      authorsXml = next
    } else {
      authorsXml =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<p188:authorLst ${NS_DECL}>${snippet}</p188:authorLst>`
      await ensureAuthorsCt()
    }
    zip.file('ppt/authors.xml', authorsXml)
  }

  // authors.xml content type이 없으면(새로 만든 경우) 등록한다.
  async function ensureAuthorsCt(): Promise<void> {
    const ctPath = '[Content_Types].xml'
    const ctXml = await zip.file(ctPath)?.async('string')
    if (!ctXml || ctXml.includes('/ppt/authors.xml')) return
    const snippet =
      `<Override PartName="/ppt/authors.xml" ContentType="application/vnd.ms-powerpoint.authors+xml"/>`
    const next = insertBeforeClose(ctXml, 'Types', snippet)
    if (next) zip.file(ctPath, next)
  }

  // 코멘트 파트 확보.
  const relsPath = dir ? `${dir}/_rels/${base}.rels` : `_rels/${base}.rels`
  let relsXml = await readText(relsPath)
  const newRelId = (): string => {
    let max = 0
    if (relsXml) {
      for (const m of relsXml.matchAll(/Id="rId(\d+)"/g)) {
        const n = Number(m[1])
        if (Number.isFinite(n) && n > max) max = n
      }
    }
    return `rId${max + 1}`
  }
  let commentPath: string | null = null
  if (relsXml) {
    const doc = parser.parse(relsXml) as Record<string, unknown>
    const rels = asArray(
      (childByLocal(doc, 'Relationships') as Record<string, unknown> | undefined)?.['Relationship'],
    ) as Record<string, unknown>[]
    const hit = rels.find((r) => String(r['@_Type'] ?? '') === COMMENTS_REL_TYPE)
    if (hit) {
      commentPath = normPath(dir, String(hit['@_Target'] ?? ''))
    }
  }
  const cmId = guid()
  const created = new Date().toISOString().replace(/Z$/, '')
  // sldMkLst 없으면 파워포인트가 파일을 거부한다 (cId 값은 무관).
  // pos 없으면 왼쪽 위(1인치)로 간다.
  const px = Math.max(0, Math.round(opts.pos?.x ?? 914400))
  const py = Math.max(0, Math.round(opts.pos?.y ?? 914400))
  const mark =
    `<pc:sldMkLst xmlns:pc="http://schemas.microsoft.com/office/powerpoint/2013/main/command">` +
    `<pc:docMk/><pc:sldMk cId="1" sldId="${esc(sldId)}"/></pc:sldMkLst>`
  const cm =
    `<p188:cm id="${cmId}" authorId="${authorId}" created="${created}">` +
    mark +
    `<p188:pos x="${px}" y="${py}"/>` +
    `<p188:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ko-KR"/>` +
    `<a:t xml:space="preserve">${esc(text)}</a:t></a:r></a:p></p188:txBody></p188:cm>`
  if (commentPath && (await readText(commentPath))) {
    const cur = (await readText(commentPath)) as string
    const next = insertBeforeClose(cur, 'cmLst', cm)
    if (!next) throw new Error('comment part shape unknown')
    zip.file(commentPath, next)
  } else {
    const rand = Math.floor(Math.random() * 900 + 100)
    const name = `modernComment_${rand}_${Date.now().toString(36).toUpperCase()}.xml`
    commentPath = `ppt/comments/${name}`
    const doc =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<p188:cmLst ${NS_DECL}>${cm}</p188:cmLst>`
    zip.file(commentPath, doc)
    // slide rels에 연결.
    const relSnippet = `<Relationship Id="${newRelId()}" Type="${COMMENTS_REL_TYPE}" Target="../comments/${name}"/>`
    if (relsXml) {
      const next = insertBeforeClose(relsXml, 'Relationships', relSnippet)
      if (!next) throw new Error('slide rels shape unknown')
      zip.file(relsPath, next)
    } else {
      zip.file(
        relsPath,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relSnippet}</Relationships>`,
      )
    }
    // content type 등록.
    const ctPath = '[Content_Types].xml'
    const ctXml = await readText(ctPath)
    if (!ctXml) throw new Error('no [Content_Types]')
    const ctSnippet = `<Override PartName="/${commentPath}" ContentType="${COMMENTS_CT}"/>`
    const ctNext = insertBeforeClose(ctXml, 'Types', ctSnippet)
    if (!ctNext) throw new Error('content types shape unknown')
    zip.file(ctPath, ctNext)
  }
  return zip.generateAsync({ type: 'uint8array' })
}
