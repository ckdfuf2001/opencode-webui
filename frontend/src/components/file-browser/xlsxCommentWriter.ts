import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'

/**
 * 엑셀 코멘트 추가 (스레드형). 우리 패널에서 달고 제자리 저장한다.
 * 문자열 수술로만 건드려서 네임스페이스 깨짐이 없다.
 */

const TC_NS = 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments'
const X_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const TC_REL = 'http://schemas.microsoft.com/office/2017/10/relationships/threadedComment'
const PERSON_REL = 'http://schemas.microsoft.com/office/2017/10/relationships/person'
const TC_CT = 'application/vnd.ms-excel.threadedcomments+xml'
const PERSON_CT = 'application/vnd.ms-excel.person+xml'
const LEGACY_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml'
const VML_CT = 'application/vnd.openxmlformats-officedocument.vmlDrawing'
const LEGACY_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments'
const VML_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing'
const XR_NS = 'http://schemas.microsoft.com/office/spreadsheetml/2014/revision'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
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

function childByLocal(obj: Record<string, unknown>, local: string): unknown {
  for (const [k, v] of Object.entries(obj)) {
    const name = k.includes(':') ? k.slice(k.indexOf(':') + 1) : k
    if (name === local) return v
  }
  return undefined
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

function joinTarget(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const segs: string[] = []
  for (const part of `${baseDir}/${target}`.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') segs.pop()
    else segs.push(part)
  }
  return segs.join('/')
}

type Rel = { id: string; type: string; target: string }

function parseRels(doc: unknown): Rel[] {
  const root = (doc as Record<string, unknown> | undefined)?.['Relationships'] as
    | Record<string, unknown>
    | undefined
  return asArray(root?.['Relationship'] as Record<string, unknown> | Record<string, unknown>[]).map(
    (r) => ({
      id: String(r['@_Id'] ?? ''),
      type: String(r['@_Type'] ?? ''),
      target: String(r['@_Target'] ?? ''),
    }),
  )
}

const normRef = (ref: string): string => {
  const m = ref.includes('!') ? ref.slice(ref.lastIndexOf('!') + 1) : ref
  return m.replace(/\$/g, '').trim().toUpperCase()
}

/** A1 표기를 0-based (col, row)로 바꾼다. */
function refToCell(ref: string): { col: number; row: number } | null {
  const m = /^([A-Za-z]+)(\d+)$/.exec(normRef(ref))
  if (!m) return null
  let col = 0
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { col: col - 1, row: Number(m[2]) - 1 }
}

const LEGACY_PLACEHOLDER_HEAD =
  '[Threaded comment]\r\n\r\nYour version of Excel allows you to read this comment, ' +
  'but any edits to it will get removed if the file is opened in a newer version of Excel. ' +
  'For more information: https://go.microsoft.com/fwlink/?linkid=870924.\r\n\r\nFrom:\r\n    '

export async function addXlsxComment(
  bytes: Uint8Array,
  opts: { sheetIndex: number; ref: string; authorName: string; text: string },
): Promise<Uint8Array> {
  const text = opts.text.trim()
  const ref = normRef(opts.ref)
  if (!text || !ref) throw new Error('empty comment')
  const authorName = opts.authorName.trim() || 'You'
  const zip = await JSZip.loadAsync(bytes)
  const readText = async (path: string): Promise<string | null> => {
    const f = zip.file(path)
    return f ? f.async('string') : null
  }

  // 시트 파트 찾기.
  const wb = parser.parse((await readText('xl/workbook.xml')) ?? '')
  const sheets = asArray(
    ((wb?.['workbook'] as Record<string, unknown> | undefined)?.['sheets'] as
      | Record<string, unknown>
      | undefined)?.['sheet'],
  ) as Record<string, unknown>[]
  const sheet = sheets[Math.max(0, Math.min(opts.sheetIndex, sheets.length - 1))]
  if (!sheet) throw new Error('sheet not found')
  const wbRelsDoc = await readText('xl/_rels/workbook.xml.rels')
  const wbRels = wbRelsDoc ? parseRels(parser.parse(wbRelsDoc)) : []
  const wbRelTargets = new Map(wbRels.map((r) => [r.id, r.target]))
  const sheetTarget = wbRelTargets.get(String(sheet['@_r:id'] ?? sheet['@_id'] ?? ''))
  if (!sheetTarget) throw new Error('sheet rel not found')
  const sheetPath = joinTarget('xl', sheetTarget)
  const dir = sheetPath.includes('/') ? sheetPath.slice(0, sheetPath.lastIndexOf('/')) : ''
  const base = sheetPath.slice(sheetPath.lastIndexOf('/') + 1)
  const relsPath = joinTarget(dir, `_rels/${base}.rels`)

  const newRelId = (relsXml: string | null): string => {
    let max = 0
    if (relsXml) {
      for (const m of relsXml.matchAll(/Id="rId(\d+)"/g)) {
        const n = Number(m[1])
        if (Number.isFinite(n) && n > max) max = n
      }
    }
    return `rId${max + 1}`
  }

  // 작성자 확보.
  let personRel = wbRels.find((r) => r.type === PERSON_REL)
  let personPath = personRel ? joinTarget('xl', personRel.target) : 'xl/persons/person.xml'
  let personXml = await readText(personPath)
  let personId: string | null = null
  if (personXml) {
    const doc = parser.parse(personXml) as Record<string, unknown>
    const list = childByLocal(doc, 'personList')
    for (const p of asArray(childByLocal((list ?? {}) as Record<string, unknown>, 'person'))) {
      const o = p as Record<string, unknown>
      if (String(o['@_displayName'] ?? '') === authorName) {
        personId = String(o['@_id'] ?? o['@_personId'] ?? '')
        break
      }
    }
  }
  if (!personId) {
    personId = guid()
    const snippet =
      `<person displayName="${esc(authorName)}" id="${personId}" ` +
      `userId="${randomUserId()}" providerId="Windows Live"/>`
    if (personXml) {
      const next = insertBeforeClose(personXml, 'personList', snippet)
      if (!next) throw new Error('person part shape unknown')
      zip.file(personPath, next)
    } else {
      zip.file(
        personPath,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
          `<personList xmlns="${TC_NS}" xmlns:x="${X_NS}">${snippet}</personList>`,
      )
      if (!personRel) {
        // workbook rels + content type 등록.
        let wbr = wbRelsDoc ?? ''
        if (!wbr) {
          wbr =
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`
        }
        const wbrNext = insertBeforeClose(
          wbr,
          'Relationships',
          `<Relationship Id="${newRelId(wbr)}" Type="${PERSON_REL}" Target="persons/person.xml"/>`,
        )
        if (!wbrNext) throw new Error('workbook rels shape unknown')
        zip.file('xl/_rels/workbook.xml.rels', wbrNext)
      }
      const ctPath = '[Content_Types].xml'
      const ctXml = await readText(ctPath)
      if (ctXml && !ctXml.includes('/xl/persons/')) {
        const ctNext = insertBeforeClose(
          ctXml,
          'Types',
          `<Override PartName="/${personPath}" ContentType="${PERSON_CT}"/>`,
        )
        if (ctNext) zip.file(ctPath, ctNext)
      }
    }
  }

  // 스레드 파트 확보.
  let relsXml = await readText(relsPath)
  let tcPath: string | null = null
  if (relsXml) {
    const hit = parseRels(parser.parse(relsXml)).find((r) => r.type === TC_REL)
    if (hit) tcPath = joinTarget(dir, hit.target)
  }
  const now = new Date()
  const pad = (n: number, l = 2) => String(n).padStart(l, '0')
  const dt =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3).slice(0, 2)}`
  const tcId = guid()
  const tc =
    `<threadedComment ref="${esc(ref)}" dT="${dt}" personId="${personId}" id="${tcId}">` +
    `<text>${esc(text)}</text></threadedComment>`
  if (tcPath && (await readText(tcPath))) {
    const cur = (await readText(tcPath)) as string
    const next = insertBeforeClose(cur, 'ThreadedComments', tc)
    if (!next) throw new Error('threaded part shape unknown')
    zip.file(tcPath, next)
  } else {
    let n = 1
    while (zip.file(`xl/threadedComments/threadedComment${n}.xml`)) n++
    tcPath = `xl/threadedComments/threadedComment${n}.xml`
    zip.file(
      tcPath,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<ThreadedComments xmlns="${TC_NS}" xmlns:x="${X_NS}">${tc}</ThreadedComments>`,
    )
    const relSnippet = `<Relationship Id="${newRelId(relsXml)}" Type="${TC_REL}" Target="../threadedComments/threadedComment${n}.xml"/>`
    if (relsXml) {
      const next = insertBeforeClose(relsXml, 'Relationships', relSnippet)
      if (!next) throw new Error('sheet rels shape unknown')
      zip.file(relsPath, next)
    } else {
      zip.file(
        relsPath,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relSnippet}</Relationships>`,
      )
    }
    const ctPath = '[Content_Types].xml'
    const ctXml = await readText(ctPath)
    if (ctXml) {
      const ctNext = insertBeforeClose(
        ctXml,
        'Types',
        `<Override PartName="/${tcPath}" ContentType="${TC_CT}"/>`,
      )
      if (ctNext) zip.file(ctPath, ctNext)
    }
  }
  // 구버전용 그림자 (레거시 파트 + VML): 없으면 엑셀이 코멘트를 못 본다.
  await writeLegacyShadow(zip, { dir, relsPath, ref, text, threadedId: tcId, newRelId })
  return zip.generateAsync({ type: 'uint8array' })
}

/**
 * 스레드 코멘트의 레거시 쌍둥이 + VML 도형을 만든다.
 * 엑셀은 이 셋이 있어야 코멘트를 인식한다.
 */
async function writeLegacyShadow(
  zip: JSZip,
  opts: {
    dir: string
    relsPath: string
    ref: string
    text: string
    threadedId: string
    newRelId: (relsXml: string | null) => string
  },
): Promise<void> {
  const { dir, relsPath, ref, text, threadedId, newRelId } = opts
  const cell = refToCell(ref)
  const readText = async (path: string): Promise<string | null> => {
    const f = zip.file(path)
    return f ? f.async('string') : null
  }
  let relsXml = await readText(relsPath)
  const findRel = (type: string): { id: string; target: string } | null => {
    if (!relsXml) return null
    const m = relsXml.match(
      new RegExp(
        `<Relationship[^>]*Type="${type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`,
      ),
    )
    if (!m) return null
    const tag = m[0]
    const id = /Id="([^"]+)"/.exec(tag)
    const target = /Target="([^"]+)"/.exec(tag)
    if (!id || !target) return null
    return { id: id[1] as string, target: target[1] as string }
  }
  const hasRel = (type: string): string | null => {
    const hit = findRel(type)
    return hit ? hit.target : null
  }
  const normRelTarget = (t: string): string => {
    if (t.startsWith('/')) return t.slice(1)
    const segs: string[] = []
    for (const part of `${dir}/${t}`.split('/')) {
      if (part === '' || part === '.') continue
      if (part === '..') segs.pop()
      else segs.push(part)
    }
    return segs.join('/')
  }
  const ensureCt = async (part: string, ct: string): Promise<void> => {
    const ctPath = '[Content_Types].xml'
    const ctXml = await readText(ctPath)
    if (!ctXml || ctXml.includes(`PartName="/${part}"`)) return
    const next = insertBeforeClose(ctXml, 'Types', `<Override PartName="/${part}" ContentType="${ct}"/>`)
    if (next) zip.file(ctPath, next)
  }
  const ensureRel = async (type: string, targetFromDir: string): Promise<string> => {
    const hit = findRel(type)
    if (hit) return hit.id
    const id = newRelId(relsXml)
    const snippet = `<Relationship Id="${id}" Type="${type}" Target="${targetFromDir}"/>`
    if (relsXml) {
      const next = insertBeforeClose(relsXml, 'Relationships', snippet)
      if (!next) throw new Error('sheet rels shape unknown')
      relsXml = next
      zip.file(relsPath, next)
    } else {
      relsXml =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${snippet}</Relationships>`
      zip.file(relsPath, relsXml)
    }
    return id
  }

  // 1) 레거시 파트.
  let legPath = hasRel(LEGACY_REL) ? normRelTarget(hasRel(LEGACY_REL) as string) : null
  if (!legPath) {
    let n = 1
    while (zip.file(`xl/comments/comment${n}.xml`)) n++
    legPath = `xl/comments/comment${n}.xml`
    await ensureRel(LEGACY_REL, `../comments/comment${n}.xml`)
    await ensureCt(legPath, LEGACY_CT)
  }
  let legXml = await readText(legPath)
  const authorTag = `tc=${threadedId}`
  if (!legXml) {
    legXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<comments xmlns="${X_NS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ` +
      `mc:Ignorable="xr" xmlns:xr="${XR_NS}"><authors></authors><commentList></commentList></comments>`
  } else if (!legXml.includes('xmlns:xr')) {
    legXml = legXml.replace(/<comments([^>]*)>/, `<comments$1 xmlns:xr="${XR_NS}">`)
  }
  // authors에 tc 링크 추가.
  const authorIdx = (() => {
    const m = [...legXml.matchAll(/<author>([\s\S]*?)<\/author>/g)].map((x) => x[1])
    const found = m.findIndex((a) => a === authorTag)
    if (found >= 0) return found
    const next = legXml.replace(/(<authors[^>]*>)/, `$1<author>${esc(authorTag)}</author>`)
    legXml = next
    return m.length
  })()
  const stub = `<comment ref="${esc(ref)}" authorId="${authorIdx}" shapeId="${authorIdx}" xr:uid="${esc(threadedId)}">` +
    `<text><t>${esc(`${LEGACY_PLACEHOLDER_HEAD}${text}`)}</t></text></comment>`
  {
    const next = insertBeforeClose(legXml, 'commentList', stub)
    if (!next) throw new Error('legacy comment part shape unknown')
    legXml = next
  }
  zip.file(legPath, legXml)

  // 2) VML 도형 (지표용). 시트의 legacyDrawing 연결을 따라간다.
  if (!cell) return
  const sheetPath = relsPath.replace(/\/_rels\/([^/]+)\.rels$/, '/$1')
  const sheetXml0 = await readText(sheetPath)
  const legacyDrawMatch = sheetXml0?.match(/<legacyDrawing[^>]*r:id="([^"]+)"/)
  let vmlPath: string | null = null
  if (legacyDrawMatch && relsXml) {
    const id = legacyDrawMatch[1] as string
    const m = relsXml.match(
      new RegExp(`<Relationship[^>]*Id="${id}"[^>]*Target="([^"]+)"`),
    )
    if (m) vmlPath = normRelTarget(m[1] as string)
  }
  if (!vmlPath) {
    const t = hasRel(VML_REL)
    if (t) vmlPath = normRelTarget(t)
  }
  let vml = vmlPath ? await readText(vmlPath) : null
  let vmlRelId: string | null = null
  if (!vmlPath) {
    let n = 1
    while (zip.file(`xl/drawings/vmlDrawing${n}.vml`)) n++
    vmlPath = `xl/drawings/vmlDrawing${n}.vml`
    vmlRelId = await ensureRel(VML_REL, `../drawings/vmlDrawing${n}.vml`)
    await ensureCt(vmlPath, VML_CT)
  } else if (legacyDrawMatch) {
    // legacyDrawing이 가리키는 rel을 그대로 쓴다 (위에서 vmlPath를 거기서 찾았음).
    vmlRelId = legacyDrawMatch[1] as string
  }
  if (!vmlRelId) {
    const hit = findRel(VML_REL)
    vmlRelId = hit ? hit.id : await ensureRel(VML_REL, `../drawings/${(vmlPath as string).split('/').pop()}`)
  }
  // 시트에 legacyDrawing 연결이 없으면 건다 (엑셀이 VML을 인식하는 조건).
  if (sheetXml0 && !/<legacyDrawing[\s>]/.test(sheetXml0)) {
    let tagged = sheetXml0
    if (!/xmlns:r=/.test(tagged)) {
      tagged = tagged.replace(
        /<worksheet([^>]*)>/,
        `<worksheet$1 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`,
      )
    }
    const linked = insertBeforeClose(tagged, 'worksheet', `<legacyDrawing r:id="${vmlRelId}"/>`)
    if (linked) zip.file(sheetPath, linked)
  }
  const shapeSeq = (vml?.match(/_x0000_s(\d+)/g) ?? [])
    .map((s) => Number(s.slice('_x0000_s'.length)))
    .filter((n) => Number.isFinite(n))
  const shapeId = `_x0000_s${(shapeSeq.length ? Math.max(...shapeSeq) : 1024) + 1}`
  const zIndex = shapeSeq.length + 1
  const { col, row } = cell
  const shape =
    `<v:shape id="${shapeId}" type="#_x0000_t202" ` +
    `style='position:absolute;margin-left:119.25pt;margin-top:9pt;width:108pt;height:59.25pt;z-index:${zIndex};visibility:hidden' ` +
    `fillcolor="infoBackground [80]" strokecolor="none [81]" o:insetmode="auto">` +
    `<v:fill color2="infoBackground [80]"/><v:shadow color="none [81]" obscured="t"/><v:path o:connecttype="none"/>` +
    `<v:textbox style='mso-direction-alt:auto'><div style='text-align:left'></div></v:textbox>` +
    `<x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/>` +
    `<x:Anchor>${col + 1}, 15, ${Math.max(0, row - 1)}, 12, ${col + 3}, 15, ${row + 3}, 3</x:Anchor>` +
    `<x:AutoFill>False</x:AutoFill><x:Row>${row}</x:Row><x:Column>${col}</x:Column>` +
    `</x:ClientData></v:shape>`
  if (!vml) {
    vml =
      `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" ` +
      `xmlns:x="urn:schemas-microsoft-com:office:excel">` +
      `<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout>` +
      `<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe">` +
      `<v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>` +
      `${shape}</xml>`
  } else {
    const next = insertBeforeClose(vml, 'xml', shape)
    vml = next ?? `${vml}${shape}`
  }
  zip.file(vmlPath as string, vml as string)
}
