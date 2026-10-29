import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'

/**
 * ppt 코멘트 추가 (모던 형식). 우리 패널에서 달고 제자리 저장한다.
 * 문자열 수술로만 건드려서 네임스페이스 깨짐이 없다.
 */

const COMMENTS_REL_TYPE = 'http://schemas.microsoft.com/office/2018/10/relationships/comments'
const COMMENTS_CT = 'application/vnd.ms-powerpoint.comments+xml'
const AUTHORS_REL_TYPE = 'http://schemas.microsoft.com/office/2018/10/relationships/authors'
const NS_DECL =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main"'
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
})

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * OOXML GUID `{8-4-4-4-12}` (대문자).
 * 내장 UUID API는 secure context 전용이라 http에서는 undefined다.
 * getRandomValues는 비보안 컨텍스트에서도 동작하므로 UUIDv4를 직접 만든다.
 */
const guid = (): string => {
  const h = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('')
  const v = `${h.slice(0, 12)}4${h.slice(13, 16)}${'89ab'[h.charCodeAt(16) % 4]}${h.slice(17)}`
  return `{${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20)}}`.toUpperCase()
}

const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const P188_NS = 'http://schemas.microsoft.com/office/powerpoint/2018/8/main'

function localName(el: Element): string {
  const n = el.localName ?? el.tagName
  return n.includes(':') ? n.slice(n.indexOf(':') + 1) : n
}

/** DOM 직렬화 (파싱 때 딸려온 xml 선언이 있으면 제거 — 중복 선언 방지). */
function serializeXmlBody(doc: XMLDocument): string {
  return new XMLSerializer().serializeToString(doc).replace(/^<\?xml[^?]*\?>\s*/, '')
}

/** part XML에서 id가 일치하는 cm/reply 엘리먼트와 소속 cmLst를 찾는다. */
function findCommentNode(
  doc: XMLDocument,
  cid: string,
): { node: Element; topCm: Element; modern: boolean } | null {
  const all = Array.from(doc.getElementsByTagName('*')) as Element[]
  // 1) 직접 id 일치 (모던 cm/reply @id).
  for (const el of all) {
    const ln = localName(el)
    if ((ln === 'cm' || ln === 'reply') && el.getAttribute('id') === cid) {
      let top: Element = el
      let p: Element | null = el
      while (p) {
        if (localName(p) === 'cm') top = p
        const parent: ParentNode | null = p.parentNode
        p = parent && (parent as Element).localName !== undefined ? (parent as Element) : null
      }
      const modern = el.prefix === 'p188' || el.tagName.startsWith('p188:')
      return { node: el, topCm: top, modern }
    }
  }
  // 2) 레거시 authorId:idx 키.
  const m = /^([^:]*):([^:]*)$/.exec(cid)
  if (m) {
    for (const el of all) {
      if (
        localName(el) === 'cm' &&
        el.getAttribute('authorId') === m[1] &&
        el.getAttribute('idx') === m[2]
      ) {
        return { node: el, topCm: el, modern: false }
      }
    }
  }
  return null
}

function txBodyFor(doc: XMLDocument, text: string, modern: boolean): Element {
  const mk = (ns: string | null, tag: string): Element => doc.createElementNS(ns, tag)
  if (modern) {
    const tx = mk(P188_NS, 'p188:txBody')
    tx.appendChild(mk(A_NS, 'a:bodyPr'))
    tx.appendChild(mk(A_NS, 'a:lstStyle'))
    const p = mk(A_NS, 'a:p')
    const r = mk(A_NS, 'a:r')
    const rPr = mk(A_NS, 'a:rPr')
    rPr.setAttribute('lang', 'ko-KR')
    const t = mk(A_NS, 'a:t')
    t.setAttribute('xml:space', 'preserve')
    t.textContent = text
    r.appendChild(rPr)
    r.appendChild(t)
    p.appendChild(r)
    tx.appendChild(p)
    return tx
  }
  const p = mk(A_NS, 'a:p')
  const r = mk(A_NS, 'a:r')
  const t = mk(A_NS, 'a:t')
  t.setAttribute('xml:space', 'preserve')
  t.textContent = text
  r.appendChild(t)
  p.appendChild(r)
  const tx = doc.createElement('p:txBody')
  tx.appendChild(p)
  return tx
}

function replaceTxBody(cm: Element, doc: XMLDocument, text: string, modern: boolean): void {
  const txs = Array.from(cm.childNodes).filter(
    (n): n is Element => n.nodeType === 1 && localName(n as Element) === 'txBody',
  )
  for (const old of txs) cm.removeChild(old)
  // 네이티브 순서: replyLst -> txBody -> extLst. txBody는 replyLst 뒤에 둔다.
  const anchor = Array.from(cm.childNodes).find(
    (n) => n.nodeType === 1 && localName(n as Element) === 'extLst',
  )
  cm.insertBefore(txBodyFor(doc, text, modern), anchor ?? null)
}

async function mutateCommentParts(
  bytes: Uint8Array,
  mutate: (doc: XMLDocument, partName: string) => boolean,
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)
  let touched = false
  for (const name of Object.keys(zip.files)) {
    if (!/ppt\/comments\/.*\.xml$/i.test(name)) continue
    const file = zip.file(name)
    if (!file) continue
    const xml = await file.async('string')
    let doc: XMLDocument
    try {
      doc = new DOMParser().parseFromString(xml, 'application/xml')
    } catch {
      continue
    }
    if (doc.getElementsByTagName('parsererror').length > 0) continue
    try {
      if (mutate(doc, name)) {
        zip.file(name, XML_DECL + serializeXmlBody(doc))
        touched = true
      }
    } catch {
      continue
    }
  }
  if (!touched) throw new Error('comment not found')
  return zip.generateAsync({ type: 'uint8array' })
}

/** 모던 작성자 확보 (기존 author 파트에서 이름 매칭, 없으면 첫 파트에 추가). */
async function ensureModernAuthorId(zip: JSZip, authorName: string): Promise<string> {
  const readText = async (path: string): Promise<string | null> => {
    const f = zip.file(path)
    return f ? f.async('string') : null
  }
  const candidates: string[] = ['ppt/authors.xml']
  try {
    const presRels = await readText('ppt/_rels/presentation.xml.rels')
    if (presRels) {
      const doc = new DOMParser().parseFromString(presRels, 'application/xml')
      for (const rel of Array.from(doc.getElementsByTagName('Relationship'))) {
        if (
          rel.getAttribute('Type') ===
          'http://schemas.microsoft.com/office/2018/10/relationships/authors'
        ) {
          const t = rel.getAttribute('Target') ?? ''
          candidates.push(t.startsWith('/') ? t.slice(1) : `ppt/${t}`)
        }
      }
    }
  } catch {
    /* 무시 */
  }
  for (const path of candidates) {
    const xml = await readText(path)
    if (!xml) continue
    let doc: XMLDocument
    try {
      doc = new DOMParser().parseFromString(xml, 'application/xml')
    } catch {
      continue
    }
    const authors = Array.from(doc.getElementsByTagName('*')).filter(
      (e) => localName(e) === 'author',
    )
    for (const a of authors) {
      if (a.getAttribute('name') === authorName) {
        const id = a.getAttribute('id')
        if (id) {
          await ensureAuthorsRel(zip)
          return id
        }
      }
    }
    // 첫 번째로 찾은 파트에 추가한다.
    const id = guid()
    const el = doc.createElementNS(P188_NS, 'p188:author')
    el.setAttribute('id', id)
    el.setAttribute('name', authorName)
    el.setAttribute('initials', authorName.replace(/\s+/g, '').slice(0, 2).toUpperCase() || 'ME')
    el.setAttribute('userId', randomUserId())
    el.setAttribute('providerId', 'Windows Live')
    const lst = Array.from(doc.getElementsByTagName('*')).find((e) => localName(e) === 'authorLst')
    if (lst) {
      lst.appendChild(el)
      zip.file(path, XML_DECL + serializeXmlBody(doc))
      await ensureAuthorsRel(zip)
      return id
    }
  }
  throw new Error('author store missing')
}

const nowStamp = (): string => new Date().toISOString().replace(/Z$/, '')

/** 답글 추가 (모던 전용). parentCid가 reply면 그 최상위 cm에 단다. */
export async function replyPptxComment(
  bytes: Uint8Array,
  opts: { parentCid: string; authorName: string; text: string },
): Promise<Uint8Array> {
  const text = opts.text.trim()
  if (!text) throw new Error('empty comment')
  const authorName = opts.authorName.trim()
  if (!authorName) throw new Error('작성자 이름을 입력하세요')
  const zip = await JSZip.loadAsync(bytes)
  const authorId = await ensureModernAuthorId(zip, authorName)
  let done = false
  for (const name of Object.keys(zip.files)) {
    if (!/ppt\/comments\/.*\.xml$/i.test(name)) continue
    const file = zip.file(name)
    if (!file) continue
    const doc = new DOMParser().parseFromString(await file.async('string'), 'application/xml')
    if (doc.getElementsByTagName('parsererror').length > 0) continue
    const found = findCommentNode(doc, opts.parentCid)
    if (!found || !found.modern) continue
    const top = found.topCm
    let lst = Array.from(top.childNodes).find(
      (n): n is Element => n.nodeType === 1 && localName(n as Element) === 'replyLst',
    )
    const tx = Array.from(top.childNodes).find(
      (n): n is Element => n.nodeType === 1 && localName(n as Element) === 'txBody',
    )
    if (!lst) {
      lst = doc.createElementNS(P188_NS, 'p188:replyLst')
      top.insertBefore(lst, tx ?? null)
    } else if (tx && (lst.compareDocumentPosition(tx) & 2) !== 0) {
      // replyLst가 txBody 뒤에 있으면 앞으로 옮긴다 (네이티브 순서: replyLst -> txBody).
      top.insertBefore(lst, tx)
    }
    const reply = doc.createElementNS(P188_NS, 'p188:reply')
    reply.setAttribute('id', guid())
    reply.setAttribute('authorId', authorId)
    reply.setAttribute('created', nowStamp())
    reply.appendChild(txBodyFor(doc, text, true))
    lst.appendChild(reply)
    zip.file(name, XML_DECL + serializeXmlBody(doc))
    done = true
    break
  }
  if (!done) throw new Error('comment not found')
  return zip.generateAsync({ type: 'uint8array' })
}

/** 해결 토글 (모던 cm/reply). */
export async function setPptxCommentDone(
  bytes: Uint8Array,
  opts: { cid: string; done: boolean },
): Promise<Uint8Array> {
  return mutateCommentParts(bytes, (doc) => {
    const found = findCommentNode(doc, opts.cid)
    if (!found || !found.modern) return false
    found.node.setAttribute('status', opts.done ? 'resolved' : 'active')
    return true
  })
}

/** 본문 수정 (모던 cm/reply). */
export async function editPptxComment(
  bytes: Uint8Array,
  opts: { cid: string; text: string },
): Promise<Uint8Array> {
  const text = opts.text.trim()
  if (!text) throw new Error('empty comment')
  return mutateCommentParts(bytes, (doc) => {
    const found = findCommentNode(doc, opts.cid)
    if (!found || !found.modern) return false
    replaceTxBody(found.node, doc, text, true)
    return true
  })
}

/** 삭제 (모던 cm은 답글ごと, reply는 낱개). */
export async function deletePptxComment(bytes: Uint8Array, cid: string): Promise<Uint8Array> {
  return mutateCommentParts(bytes, (doc) => {
    const found = findCommentNode(doc, cid)
    if (!found || !found.modern) return false
    found.node.parentNode?.removeChild(found.node)
    return true
  })
}

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

/** authors.xml이 있으면 presentation rels에 authors 관계를 보장한다 (없으면 데스크톱이 작성자를 못 읽는다). */
async function ensureAuthorsRel(zip: JSZip): Promise<void> {
  if (!zip.file('ppt/authors.xml')) return
  const path = 'ppt/_rels/presentation.xml.rels'
  const f = zip.file(path)
  if (!f) return
  const xml = await f.async('string')
  if (xml.includes(AUTHORS_REL_TYPE)) return
  let max = 0
  for (const m of xml.matchAll(/Id="rId(\d+)"/g)) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n > max) max = n
  }
  const snippet =
    `<Relationship Id="rId${max + 1}" Type="${AUTHORS_REL_TYPE}" Target="authors.xml"/>`
  const next = insertBeforeClose(xml, 'Relationships', snippet)
  if (next) zip.file(path, next)
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
  const authorName = opts.authorName.trim()
  if (!authorName) throw new Error('작성자 이름을 입력하세요')
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
    await ensureAuthorsRel(zip)
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
