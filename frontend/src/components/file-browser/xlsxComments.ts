import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'

/** 엑셀 코멘트 (기존 + 스레드형). 뷰어에 패널이 없어서 직접 읽어 우측 목록으로 보여준다. */
export type XlsxCommentReply = {
  author: string
  text: string
}

export type XlsxComment = {
  sheet: string
  sheetIndex: number
  ref: string
  author: string
  text: string
  replies: XlsxCommentReply[]
  resolved: boolean
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

/** prefix·대소문자 무시하고 자식을 찾는다 (ThreadedComments/threadedComments 등). */
function kid(obj: unknown, ...locals: string[]): unknown {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined
  const wants = locals.map((l) => l.toLowerCase())
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k.startsWith('@_')) continue
    const name = k.includes(':') ? k.slice(k.indexOf(':') + 1) : k
    if (wants.includes(name.toLowerCase())) return v
  }
  return undefined
}

function collectText(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node !== 'object' || node === null) return ''
  let s = ''
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k.startsWith('@_')) continue
    s += collectText(v)
  }
  return s
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/** rel target을 패키지 경로로 정규화한다. */
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

export async function loadXlsxSheetNames(bytes: Uint8Array): Promise<string[]> {
  try {
    const zip = await JSZip.loadAsync(bytes)
    const f = zip.file('xl/workbook.xml')
    if (!f) return []
    const wb = parser.parse(await f.async('string')) as Record<string, unknown>
    const sheets = asArray(
      ((wb?.['workbook'] as Record<string, unknown> | undefined)?.['sheets'] as
        | Record<string, unknown>
        | undefined)?.['sheet'],
    ) as Record<string, unknown>[]
    return sheets.map((s) => String(s['@_name'] ?? ''))
  } catch {
    return []
  }
}

export async function loadXlsxComments(bytes: Uint8Array): Promise<XlsxComment[]> {
  const out: XlsxComment[] = []
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    return out
  }
  const readXml = async (path: string): Promise<Record<string, unknown> | null> => {
    const f = zip.file(path)
    if (!f) return null
    try {
      return parser.parse(await f.async('string')) as Record<string, unknown>
    } catch {
      return null
    }
  }
  try {
    const wb = await readXml('xl/workbook.xml')
    const sheets = asArray(
      ((wb?.['workbook'] as Record<string, unknown> | undefined)?.['sheets'] as
        | Record<string, unknown>
        | undefined)?.['sheet'],
    ) as Record<string, unknown>[]
    if (!sheets.length) return out
    const wbRelsDoc = await readXml('xl/_rels/workbook.xml.rels')
    const wbRels = new Map(parseRels(wbRelsDoc).map((r) => [r.id, r.target]))

    // 스레드형 작성자 표: workbook rels에서 person 파트를 찾는다
    // (기본 xl/persons/person.xml 아닐 수 있음).
    const persons = new Map<string, string>()
    const personRel = wbRelsDoc
      ? parseRels(wbRelsDoc).find((r) => r.type.endsWith('/person'))
      : undefined
    const personPaths = personRel ? [joinTarget('xl', personRel.target)] : []
    personPaths.push('xl/persons/person.xml')
    for (const pp of personPaths) {
      if (persons.size > 0) break
      const personDoc = await readXml(pp)
      const personList = kid(personDoc, 'personList') as Record<string, unknown> | undefined
      for (const p of asArray(kid(personList, 'person')) as Record<string, unknown>[]) {
        const id = String(p['@_id'] ?? p['@_personId'] ?? '')
        const name = String(p['@_displayName'] ?? '')
        if (id) persons.set(id, name || 'Unknown')
      }
    }

    for (let si = 0; si < sheets.length; si++) {
      const sheet = sheets[si] ?? {}
      const name = String(sheet['@_name'] ?? `Sheet${si + 1}`)
      const rId = String(sheet['@_r:id'] ?? sheet['@_id'] ?? '')
      const target = wbRels.get(rId)
      if (!target) continue
      const sheetPath = joinTarget('xl', target)
      const dir = sheetPath.includes('/') ? sheetPath.slice(0, sheetPath.lastIndexOf('/')) : ''
      const base = sheetPath.slice(sheetPath.lastIndexOf('/') + 1)
      const relsDoc = await readXml(joinTarget(dir, `_rels/${base}.rels`))
      if (!relsDoc) continue
      const rels = parseRels(relsDoc)

      // 스레드형 코멘트.
      const tcRel = rels.find((r) => r.type.endsWith('/threadedComment'))
      if (tcRel) {
        const tcDoc = await readXml(joinTarget(dir, tcRel.target))
        const list = kid(tcDoc, 'threadedComments') as Record<string, unknown> | undefined
        const items = asArray(kid(list, 'threadedComment')) as Record<string, unknown>[]
        const byId = new Map<string, number>()
        items.forEach((tc, idx) => {
          const id = String(tc['@_id'] ?? '')
          if (id) byId.set(id, idx)
        })
        const roots: typeof items = []
        const children = new Map<number, typeof items>()
        items.forEach((tc) => {
          const parent = String(tc['@_parentId'] ?? '')
          const pi = byId.get(parent)
          if (pi !== undefined) {
            const list = children.get(pi) ?? []
            list.push(tc)
            children.set(pi, list)
          } else {
            roots.push(tc)
          }
        })
        const toReply = (tc: Record<string, unknown>): XlsxCommentReply => ({
          author: persons.get(String(tc['@_personId'] ?? '')) ?? 'Unknown',
          text: norm(collectText(kid(tc, 'text'))),
        })
        for (const tc of roots) {
          out.push({
            sheet: name,
            sheetIndex: si,
            ref: String(tc['@_ref'] ?? ''),
            author: persons.get(String(tc['@_personId'] ?? '')) ?? 'Unknown',
            text: norm(collectText(kid(tc, 'text'))),
            replies: (children.get(items.indexOf(tc)) ?? []).map(toReply),
            resolved: String(tc['@_done'] ?? '') === '1',
          })
        }
      }

      // 기존(레거시) 코멘트. 같은 셀에 스레드형이 있으면 중복이라 건너뛴다.
      const legRel = rels.find(
        (r) => r.type.endsWith('/comments') && !r.type.endsWith('/threadedComment'),
      )
      if (legRel) {
        const threadedCells = new Set(
          out.filter((c) => c.sheetIndex === si).map((c) => c.ref.toUpperCase()),
        )
        const legDoc = await readXml(joinTarget(dir, legRel.target))
        const cm = kid(legDoc, 'comments') as Record<string, unknown> | undefined
        const authors = asArray(kid(cm, 'authors')).flatMap((a) =>
          asArray(kid(a, 'author')),
        ).map((a) => (typeof a === 'string' ? a : norm(collectText(a))))
        const list = asArray(
          kid(kid(cm, 'commentList'), 'comment'),
        ) as Record<string, unknown>[]
        for (const c of list) {
          const ai = Number(c['@_authorId'] ?? 0)
          const ref = String(c['@_ref'] ?? '')
          if (ref && threadedCells.has(ref.toUpperCase())) continue
          out.push({
            sheet: name,
            sheetIndex: si,
            ref,
            author: authors[ai] ?? 'Unknown',
            text: norm(collectText(kid(c, 'text'))),
            replies: [],
            resolved: false,
          })
        }
      }
    }
  } catch {
    // 파싱 실패는 코멘트 없음으로 취급한다.
  }
  return out.filter((c) => c.ref && (c.text || c.replies.length > 0))
}
