import JSZip from 'jszip'

/**
 * docx 코멘트 작성 (레거시 + 모던 스레드 5-part 세트).
 * lib 패널 대신 우리 패널에서 달고 제자리 저장한다. 문자열 수술 위주.
 */

const REL_COMMENTS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments'
const REL_EXTENDED = 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended'
const REL_IDS = 'http://schemas.microsoft.com/office/2016/09/relationships/commentsIds'
const REL_EXTENSIBLE = 'http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible'
const REL_PEOPLE = 'http://schemas.microsoft.com/office/2011/relationships/people'

const CT_COMMENTS =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml'
const CT_EXTENDED =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml'
const CT_IDS = 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsIds+xml'
const CT_EXTENSIBLE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtensible+xml'
const CT_PEOPLE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml'

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const hex8 = () => {
  const b = crypto.getRandomValues(new Uint8Array(4))
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0').toUpperCase())
    .join('')
}

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')
const stampUtc = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`
}

function insertBeforeClose(xml: string, local: string, snippet: string): string | null {
  const re = new RegExp(`</(?:[\\w-]+:)?${local}>`)
  const m = re.exec(xml)
  if (!m || m.index === undefined) return null
  return `${xml.slice(0, m.index)}${snippet}${xml.slice(m.index)}`
}

/** 컨테이너 끝에 추가 (빈 self-closing 루트도 펼친다). */
function appendToContainer(xml: string, local: string, snippet: string): string | null {
  const close = insertBeforeClose(xml, local, snippet)
  if (close) return close
  const m = new RegExp(`<((?:[\\w-]+:)?${local})\\b([^>]*)\\/>`).exec(xml)
  if (!m || m.index === undefined) return null
  return (
    xml.slice(0, m.index) +
    `<${m[1]}${m[2]}>${snippet}</${m[1]}>` +
    xml.slice(m.index + m[0].length)
  )
}

/** DOM 직렬화 (파싱 때 딸려온 xml 선언이 있으면 제거 — 중복 선언 방지). */
function serializeXmlBody(doc: XMLDocument): string {
  return new XMLSerializer().serializeToString(doc).replace(/^<\?xml[^?]*\?>\s*/, '')
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

/** mc:Ignorable에 나열하는 접두사는 전부 선언돼 있어야 한다 (Word 엄격 파싱). */
const NEED_NS: Record<string, string> = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
  w15: 'http://schemas.microsoft.com/office/word/2012/wordml',
  w16: 'http://schemas.microsoft.com/office/word/2018/wordml',
  w16cid: 'http://schemas.microsoft.com/office/word/2016/wordml/cid',
  w16cex: 'http://schemas.microsoft.com/office/word/2018/wordml/cex',
  w16se: 'http://schemas.microsoft.com/office/word/2015/wordml/symex',
  w16sdtdh: 'http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash',
  w16sdtfl: 'http://schemas.microsoft.com/office/word/2024/wordml/sdtformatlock',
  w16du: 'http://schemas.microsoft.com/office/word/2023/wordml/word16du',
  wp14: 'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
}

/** document.xml 루트에서 xmlns 선언을 빌려온다 (Ignorable 접두사 미선언 방지). */
function borrowNsDecls(docXml: string | null): string {
  const base =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ' +
    'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" ' +
    'xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid" ' +
    'xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex" ' +
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'
  if (!docXml) return base
  const root = /<w:document\b[^>]*>/.exec(docXml)?.[0] ?? ''
  const have = new Set<string>()
  for (const m of root.matchAll(/xmlns:([a-zA-Z0-9]+)\s*=\s*"[^"]*"/g)) have.add(m[1])
  let out = ''
  for (const m of root.matchAll(/xmlns:[a-zA-Z0-9]+\s*=\s*"[^"]*"/g)) out += m[0] + ' '
  const need: Record<string, string> = NEED_NS
  for (const [p, uri] of Object.entries(need)) {
    if (!have.has(p)) out += `xmlns:${p}="${uri}" `
  }
  return out.trim()
}

/** 코멘트 5-part + rel + content-type을 보장한다 (없으면 생성). */
async function ensureCommentSystem(zip: JSZip): Promise<void> {
  const readText = async (path: string): Promise<string | null> => {
    const f = zip.file(path)
    return f ? f.async('string') : null
  }
  const docXml = await readText('word/document.xml')
  const ns = borrowNsDecls(docXml)
  const mc = 'mc:Ignorable="w14 w15 w16se w16cid w16 w16cex w16sdtdh w16sdtfl w16du wp14"'
  const fresh: Array<[string, string]> = [
    ['word/comments.xml', `${XML_DECL}<w:comments ${ns} ${mc}></w:comments>`],
    ['word/commentsExtended.xml', `${XML_DECL}<w15:commentsEx ${ns} ${mc}></w15:commentsEx>`],
    ['word/commentsIds.xml', `${XML_DECL}<w16cid:commentsIds ${ns} ${mc}></w16cid:commentsIds>`],
    [
      'word/commentsExtensible.xml',
      `${XML_DECL}<w16cex:commentsExtensible ${ns} ${mc}></w16cex:commentsExtensible>`,
    ],
    ['word/people.xml', `${XML_DECL}<w15:people ${ns} ${mc}></w15:people>`],
  ]
  for (const [path, body] of fresh) {
    if (!zip.file(path)) zip.file(path, body)
  }
  // 기존 파트 루트에도 필요한 xmlns이 없으면 채운다 (구버전/외부 생성 파트 수리).
  {
    const needNs: Record<string, string> = NEED_NS
    for (const [path] of fresh) {
      const f = zip.file(path)
      if (!f) continue
      const xml = await f.async('string')
      const open =
        /^<\?xml[^?]*\?>\s*(<[a-zA-Z0-9:]+(?:\s+[a-zA-Z0-9:]+(?:\s*=\s*"[^"]*")?)*)(\s*\/?>)/.exec(
          xml,
        )
      if (!open) continue
      const have = new Set<string>()
      for (const m of open[1].matchAll(/xmlns:([a-zA-Z0-9]+)\s*=/g)) have.add(m[1])
      let add = ''
      for (const [p, uri] of Object.entries(needNs)) {
        if (!have.has(p)) add += ` xmlns:${p}="${uri}"`
      }
      if (add) {
        const tag = `${open[1]}${add}${open[2]}`
        zip.file(path, xml.slice(0, open.index) + tag + xml.slice(open.index + open[0].length))
      }
    }
  }
  // content types.
  const ctPath = '[Content_Types].xml'
  let ctXml = await readText(ctPath)
  if (ctXml) {
    const need: Array<[string, string]> = [
      ['/word/comments.xml', CT_COMMENTS],
      ['/word/commentsExtended.xml', CT_EXTENDED],
      ['/word/commentsIds.xml', CT_IDS],
      ['/word/commentsExtensible.xml', CT_EXTENSIBLE],
      ['/word/people.xml', CT_PEOPLE],
    ]
    let dirty = false
    for (const [part, ct] of need) {
      if (!ctXml.includes(part)) {
        const next = insertBeforeClose(
          ctXml,
          'Types',
          `<Override PartName="${part}" ContentType="${ct}"/>`,
        )
        if (next) {
          ctXml = next
          dirty = true
        }
      }
    }
    if (dirty) zip.file(ctPath, ctXml)
  }
  // document rels.
  const relsPath = 'word/_rels/document.xml.rels'
  let relsXml = await readText(relsPath)
  if (relsXml) {
    const need: Array<[string, string]> = [
      [REL_COMMENTS, 'comments.xml'],
      [REL_EXTENDED, 'commentsExtended.xml'],
      [REL_IDS, 'commentsIds.xml'],
      [REL_EXTENSIBLE, 'commentsExtensible.xml'],
      [REL_PEOPLE, 'people.xml'],
    ]
    let max = 0
    for (const m of relsXml.matchAll(/Id="rId(\d+)"/g)) {
      const n = Number(m[1])
      if (Number.isFinite(n) && n > max) max = n
    }
    let dirty = false
    for (const [type, target] of need) {
      if (!relsXml.includes(type)) {
        max += 1
        const next = insertBeforeClose(
          relsXml,
          'Relationships',
          `<Relationship Id="rId${max}" Type="${type}" Target="${target}"/>`,
        )
        if (next) {
          relsXml = next
          dirty = true
        }
      }
    }
    if (dirty) zip.file(relsPath, relsXml)
  }
}

/** 기존 w:comment id 중 최대값+1. */
function nextCommentId(commentsXml: string): number {
  let max = -1
  for (const m of commentsXml.matchAll(/<w:comment\s[^>]*w:id="(\d+)"/g)) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n > max) max = n
  }
  return max + 1
}

/** w:id -> w14:paraId (같은 w:comment 안에서만). */
function paraOf(commentsXml: string, id: number): string | null {
  const el = new RegExp(`<w:comment\\s[^>]*w:id="${id}"[^>]*>[\\s\\S]*?</w:comment>`).exec(
    commentsXml,
  )
  if (!el) return null
  const m = /w14:paraId="([0-9A-Fa-f]+)"/.exec(el[0])
  return m ? m[1].toUpperCase() : null
}

/** 문서 첫 w:r을 감싸는 마커를 넣는다 (보기 추가용 앵커). */
function anchorFirstRun(docXml: string, id: number): string | null {
  const body = docXml.indexOf('<w:body')
  const rOpen = docXml.indexOf('<w:r', body < 0 ? 0 : body)
  if (rOpen < 0) return null
  const rClose = docXml.indexOf('</w:r>', rOpen)
  if (rClose < 0) return null
  const end = rClose + '</w:r>'.length
  return (
    docXml.slice(0, rOpen) +
    `<w:commentRangeStart w:id="${id}"/>` +
    docXml.slice(rOpen, end) +
    `<w:commentRangeEnd w:id="${id}"/><w:commentReference w:id="${id}"/>` +
    docXml.slice(end)
  )
}

/** root 범위 안쪽에 답글 마커를 둔다 (네이티브와 같은 겹침: Start0 StartR … End0 Ref0 EndR RefR). */
function anchorReply(docXml: string, rootId: number, id: number): string | null {
  const start = `<w:commentRangeStart w:id="${rootId}"/>`
  const ref = `<w:commentReference w:id="${rootId}"/>`
  const si = docXml.indexOf(start)
  const ri = docXml.indexOf(ref)
  if (si >= 0 && ri >= 0) {
    const startEnd = si + start.length
    const refEnd = ri + ref.length
    return (
      docXml.slice(0, startEnd) +
      `<w:commentRangeStart w:id="${id}"/>` +
      docXml.slice(startEnd, refEnd) +
      `<w:commentRangeEnd w:id="${id}"/><w:commentReference w:id="${id}"/>` +
      docXml.slice(refEnd)
    )
  }
  const bodyClose = docXml.lastIndexOf('</w:body>')
  if (bodyClose < 0) return null
  const mark =
    `<w:commentRangeStart w:id="${id}"/>` +
    `<w:commentRangeEnd w:id="${id}"/><w:commentReference w:id="${id}"/>`
  return docXml.slice(0, bodyClose) + mark + docXml.slice(bodyClose)
}

function commentXml(
  id: number,
  paraId: string,
  authorName: string,
  text: string,
  date = stamp(),
): string {
  const initials = authorName.replace(/\s+/g, '').slice(0, 2).toUpperCase() || 'ME'
  return (
    `<w:comment w:id="${id}" w:author="${esc(authorName)}" w:date="${date}" w:initials="${esc(initials)}">` +
    `<w:p><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>` +
    `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>` +
    `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p></w:comment>`
  ).replace('<w:p>', `<w:p w14:paraId="${paraId}" w14:textId="${hex8()}">`)
}

function ensureW14ns(commentsXml: string): string {
  if (commentsXml.includes('xmlns:w14=')) return commentsXml
  return commentsXml.replace(/<w:comments([^>]*)>/, '<w:comments$1 xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">')
}

async function ensurePerson(zip: JSZip, authorName: string): Promise<void> {
  const path = 'word/people.xml'
  const f = zip.file(path)
  if (!f) return
  let xml = await f.async('string')
  if (xml.includes(`w15:author="${esc(authorName)}"`)) return
  const person =
    `<w15:person w15:author="${esc(authorName)}">` +
    `<w15:presenceInfo w15:providerId="Windows Live" w15:userId="${(hex8() + hex8()).toLowerCase().slice(0, 16)}"/>` +
    `</w15:person>`
  const next = appendToContainer(xml, 'people', person)
  if (next) zip.file(path, next)
}

async function addAuxEntries(
  zip: JSZip,
  opts: { paraId: string; durableId: string; parentPara?: string; done?: boolean; dateUtc?: string },
): Promise<void> {
  // commentsIds.
  {
    const f = zip.file('word/commentsIds.xml')
    if (f) {
      const xml = await f.async('string')
      const next = appendToContainer(
        xml,
        'commentsIds',
        `<w16cid:commentId w16cid:paraId="${opts.paraId}" w16cid:durableId="${opts.durableId}"/>`,
      )
      if (next) zip.file('word/commentsIds.xml', next)
    }
  }
  // commentsExtended.
  {
    const f = zip.file('word/commentsExtended.xml')
    if (f) {
      const xml = await f.async('string')
      const parent = opts.parentPara ? ` w15:paraIdParent="${opts.parentPara}"` : ''
      const done = opts.done ? '1' : '0'
      const next = appendToContainer(
        xml,
        'commentsEx',
        `<w15:commentEx w15:paraId="${opts.paraId}"${parent} w15:done="${done}"/>`,
      )
      if (next) zip.file('word/commentsExtended.xml', next)
    }
  }
  // commentsExtensible.
  {
    const f = zip.file('word/commentsExtensible.xml')
    if (f) {
      const xml = await f.async('string')
      const next = appendToContainer(
        xml,
        'commentsExtensible',
        `<w16cex:commentExtensible w16cex:durableId="${opts.durableId}" w16cex:dateUtc="${opts.dateUtc ?? stampUtc()}"/>`,
      )
      if (next) zip.file('word/commentsExtensible.xml', next)
    }
  }
}

/** 코멘트 추가 (문서 첫 런에 앵커). */
export async function addDocxComment(
  bytes: Uint8Array,
  opts: { authorName: string; text: string },
): Promise<Uint8Array> {
  const text = opts.text.trim()
  if (!text) throw new Error('empty comment')
  const authorName = opts.authorName.trim() || 'You'
  const zip = await JSZip.loadAsync(bytes)
  await ensureCommentSystem(zip)
  const readText = async (path: string): Promise<string | null> => {
    const f = zip.file(path)
    return f ? f.async('string') : null
  }
  let commentsXml = (await readText('word/comments.xml')) ?? ''
  commentsXml = ensureW14ns(commentsXml)
  const id = nextCommentId(commentsXml)
  const paraId = hex8()
  const durableId = hex8()
  const cm = commentXml(id, paraId, authorName, text)
  const next = appendToContainer(commentsXml, 'comments', cm)
  if (!next) throw new Error('comments.xml shape unknown')
  zip.file('word/comments.xml', next)
  await addAuxEntries(zip, { paraId, durableId })
  await ensurePerson(zip, authorName)
  const docXml = await readText('word/document.xml')
  if (docXml) {
    const anchored = anchorFirstRun(docXml, id)
    if (!anchored) throw new Error('no text run to anchor')
    zip.file('word/document.xml', anchored)
  }
  return zip.generateAsync({ type: 'uint8array' })
}

/** 답글 추가 (부모 범위에 앵커). */
export async function replyDocxComment(
  bytes: Uint8Array,
  opts: { parentCid: string; authorName: string; text: string },
): Promise<Uint8Array> {
  const text = opts.text.trim()
  if (!text || !opts.parentCid) throw new Error('empty comment')
  const authorName = opts.authorName.trim() || 'You'
  const parentId = Number(opts.parentCid)
  if (!Number.isFinite(parentId)) throw new Error('comment not found')
  const zip = await JSZip.loadAsync(bytes)
  await ensureCommentSystem(zip)
  const readText = async (path: string): Promise<string | null> => {
    const f = zip.file(path)
    return f ? f.async('string') : null
  }
  let commentsXml = (await readText('word/comments.xml')) ?? ''
  commentsXml = ensureW14ns(commentsXml)
  const parentPara = paraOf(commentsXml, parentId)
  if (!parentPara) throw new Error('comment not found')
  const id = nextCommentId(commentsXml)
  const paraId = hex8()
  const durableId = hex8()
  const cm = commentXml(id, paraId, authorName, text)
  const next = appendToContainer(commentsXml, 'comments', cm)
  if (!next) throw new Error('comments.xml shape unknown')
  zip.file('word/comments.xml', next)
  await addAuxEntries(zip, { paraId, durableId, parentPara })
  await ensurePerson(zip, authorName)
  const docXml = await readText('word/document.xml')
  if (docXml) {
    const anchored = anchorReply(docXml, parentId, id)
    if (anchored) zip.file('word/document.xml', anchored)
  }
  return zip.generateAsync({ type: 'uint8array' })
}

/** 해결 토글 (루트면 자식까지 함께). */
export async function setDocxCommentDone(
  bytes: Uint8Array,
  opts: { cid: string; done: boolean },
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)
  const path = 'word/commentsExtended.xml'
  const f = zip.file(path)
  if (!f) throw new Error('comment not found')
  const doc = new DOMParser().parseFromString(await f.async('string'), 'application/xml')
  const els = Array.from(doc.getElementsByTagName('*'))
  const local = (el: Element) => {
    const t = el.localName ?? el.tagName
    return t.includes(':') ? t.slice(t.indexOf(':') + 1) : t
  }
  // cid -> paraId (comments.xml에서).
  const cf = zip.file('word/comments.xml')
  if (!cf) throw new Error('comment not found')
  const commentsXml = await cf.async('string')
  const targetPara = paraOf(commentsXml, Number(opts.cid))
  if (!targetPara) throw new Error('comment not found')
  // 자식 paraId 수집.
  const paras = new Set<string>([targetPara])
  for (const el of els) {
    if (local(el) !== 'commentEx') continue
    const pid = el.getAttribute('w15:paraId') ?? el.getAttribute('paraId') ?? ''
    const pp = el.getAttribute('w15:paraIdParent') ?? el.getAttribute('paraIdParent') ?? ''
    if (pp === targetPara && pid) paras.add(pid)
  }
  let touched = false
  for (const el of els) {
    if (local(el) !== 'commentEx') continue
    const pid = el.getAttribute('w15:paraId') ?? el.getAttribute('paraId') ?? ''
    if (!paras.has(pid)) continue
    if (opts.done) el.setAttribute('w15:done', '1')
    else el.setAttribute('w15:done', '0')
    touched = true
  }
  if (!touched) throw new Error('comment not found')
  zip.file(path, XML_DECL + serializeXmlBody(doc))
  return zip.generateAsync({ type: 'uint8array' })
}

/** 본문 수정 (첫 문단 교체, paraId 유지). */
export async function editDocxComment(
  bytes: Uint8Array,
  opts: { cid: string; text: string },
): Promise<Uint8Array> {
  const text = opts.text.trim()
  if (!text) throw new Error('empty comment')
  const zip = await JSZip.loadAsync(bytes)
  const path = 'word/comments.xml'
  const f = zip.file(path)
  if (!f) throw new Error('comment not found')
  const doc = new DOMParser().parseFromString(await f.async('string'), 'application/xml')
  const els = Array.from(doc.getElementsByTagName('*'))
  const local = (el: Element) => {
    const t = el.localName ?? el.tagName
    return t.includes(':') ? t.slice(t.indexOf(':') + 1) : t
  }
  const cm = els.find((e) => local(e) === 'comment' && e.getAttribute('w:id') === opts.cid)
  if (!cm) throw new Error('comment not found')
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  const mk = (tag: string) => doc.createElementNS(W, tag)
  // 기존 문단 전부 제거 후 단일 문단으로 교체 (paraId/textId는 유지 — 스레드 연결).
  const oldP = Array.from(cm.childNodes).find(
    (n): n is Element => n.nodeType === 1 && local(n as Element) === 'p',
  )
  const keepPara = oldP?.getAttribute('w14:paraId') ?? ''
  const keepText = oldP?.getAttribute('w14:textId') ?? ''
  for (const child of Array.from(cm.childNodes)) cm.removeChild(child)
  const p = mk('w:p')
  if (keepPara) p.setAttribute('w14:paraId', keepPara)
  if (keepText) p.setAttribute('w14:textId', keepText)
  const r0 = mk('w:r')
  const ref = mk('w:annotationRef')
  r0.appendChild(ref)
  p.appendChild(r0)
  const r = mk('w:r')
  const t = mk('w:t')
  t.setAttribute('xml:space', 'preserve')
  t.textContent = text
  r.appendChild(t)
  p.appendChild(r)
  cm.appendChild(p)
  zip.file(path, XML_DECL + serializeXmlBody(doc))
  return zip.generateAsync({ type: 'uint8array' })
}

/** 삭제 (루트면 스레드 전체 캐스케이드). 마커도 함께 제거. */
export async function deleteDocxComment(bytes: Uint8Array, cid: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)
  const cf = zip.file('word/comments.xml')
  if (!cf) throw new Error('comment not found')
  const commentsXml = await cf.async('string')
  const targetId = Number(cid)
  if (!Number.isFinite(targetId)) throw new Error('comment not found')
  const targetPara = paraOf(commentsXml, targetId)
  // 자식 id 수집 (extended의 paraIdParent).
  const delIds = new Set<number>([targetId])
  const delParas = new Set<string>(targetPara ? [targetPara] : [])
  const exf = zip.file('word/commentsExtended.xml')
  let exXml = exf ? await exf.async('string') : ''
  if (exXml && targetPara) {
    const doc = new DOMParser().parseFromString(exXml, 'application/xml')
    const exEls = Array.from(doc.getElementsByTagName('*'))
    const idf = zip.file('word/comments.xml')
    const idPara = new Map<string, number>()
    if (idf) {
      const cxml = await idf.async('string')
      for (const m of cxml.matchAll(/<w:comment\s[^>]*w:id="(\d+)"[^>]*>[\s\S]*?<\/w:comment>/g)) {
        const pm = /w14:paraId="([0-9A-Fa-f]+)"/.exec(m[0])
        if (pm) idPara.set(pm[1].toUpperCase(), Number(m[1]))
      }
    }
    for (const el of exEls) {
      const tag = (el.localName ?? el.tagName).split(':').pop() ?? ''
      if (tag !== 'commentEx') continue
      const pp =
        el.getAttribute('w15:paraIdParent') ?? el.getAttribute('paraIdParent') ?? ''
      const pid = el.getAttribute('w15:paraId') ?? el.getAttribute('paraId') ?? ''
      if (pp === targetPara && pid) {
        delParas.add(pid)
        const nid = idPara.get(pid)
        if (nid !== undefined) delIds.add(nid)
      }
    }
  }
  // comments.xml에서 제거.
  {
    const doc = new DOMParser().parseFromString(commentsXml, 'application/xml')
    const els = Array.from(doc.getElementsByTagName('*'))
    let dirty = false
    for (const el of els) {
      const tag = (el.localName ?? el.tagName).split(':').pop() ?? ''
      if (tag !== 'comment') continue
      if (delIds.has(Number(el.getAttribute('w:id')))) {
        el.parentNode?.removeChild(el)
        dirty = true
      }
    }
    if (!dirty) throw new Error('comment not found')
    zip.file('word/comments.xml', XML_DECL + serializeXmlBody(doc))
  }
  // document.xml 마커 제거.
  {
    const df = zip.file('word/document.xml')
    if (df) {
      let xml = await df.async('string')
      for (const id of delIds) {
        xml = xml.split(`<w:commentRangeStart w:id="${id}"/>`).join('')
        xml = xml.split(`<w:commentRangeEnd w:id="${id}"/>`).join('')
        xml = xml.split(`<w:commentReference w:id="${id}"/>`).join('')
        xml = xml.replace(new RegExp(`<w:commentRangeStart\\s+w:id="${id}"\\s*/>`, 'g'), '')
        xml = xml.replace(new RegExp(`<w:commentRangeEnd\\s+w:id="${id}"\\s*/>`, 'g'), '')
        xml = xml.replace(new RegExp(`<w:commentReference\\s+w:id="${id}"\\s*/>`, 'g'), '')
      }
      zip.file('word/document.xml', xml)
    }
  }
  // aux entries 제거 (paraId/durableId 기준).
  const scrub = async (path: string, attrNames: string[]) => {
    const ff = zip.file(path)
    if (!ff) return
    const doc = new DOMParser().parseFromString(await ff.async('string'), 'application/xml')
    const els = Array.from(doc.getElementsByTagName('*'))
    let dirty = false
    // durableId 수집.
    const durables = new Set<string>()
    {
      const idf = zip.file('word/commentsIds.xml')
      if (idf) {
        const ix = await idf.async('string')
        for (const m of ix.matchAll(/w16cid:paraId="([0-9A-Fa-f]+)"\s+w16cid:durableId="([0-9A-Fa-f]+)"/g)) {
          if (delParas.has(m[1].toUpperCase())) durables.add(m[2].toUpperCase())
        }
      }
    }
    for (const el of els) {
      for (const a of attrNames) {
        const v = (el.getAttribute(a) ?? '').toUpperCase()
        if (!v) continue
        if (delParas.has(v) || durables.has(v)) {
          el.parentNode?.removeChild(el)
          dirty = true
          break
        }
      }
    }
    if (dirty) zip.file(path, XML_DECL + serializeXmlBody(doc))
  }
  await scrub('word/commentsIds.xml', ['w16cid:paraId', 'w16cid:durableId', 'paraId', 'durableId'])
  await scrub('word/commentsExtended.xml', ['w15:paraId', 'w15:paraIdParent', 'paraId', 'paraIdParent'])
  await scrub('word/commentsExtensible.xml', ['w16cex:durableId', 'durableId'])
  return zip.generateAsync({ type: 'uint8array' })
}
