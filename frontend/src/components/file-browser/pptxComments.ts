import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'

/** ppt 코멘트 (모던 + 레거시). 뷰어 탭 대신 우측 우리 패널로 보여준다. */
export type PptxCommentReply = {
  author: string
  text: string
  created: string
}

export type PptxComment = {
  slideNo: number
  author: string
  text: string
  created: string
  replies: PptxCommentReply[]
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
  let s = ''
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k.startsWith('@_')) continue
    s += collectText(v)
  }
  return s
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 로컬명이 통째로 들어가 있어 prefix가 달라도 통한다 (p188:cm vs p:cm). */
function childByLocal(obj: Record<string, unknown>, local: string): unknown {
  for (const [k, v] of Object.entries(obj)) {
    const name = k.includes(':') ? k.slice(k.indexOf(':') + 1) : k
    if (name === local) return v
  }
  return undefined
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

const txBodyText = (cm: Record<string, unknown>): string => {
  const bodies = asArray(childByLocal(cm, 'txBody'))
  if (bodies.length) return norm(bodies.map(collectText).join(' '))
  // 레거시(p:cm)는 p:text에 평문이 직접 들어있다.
  const plain = childByLocal(cm, 'text')
  return norm(typeof plain === 'string' ? plain : collectText(plain))
}

/** 슬라이드 크기(EMU). 위치 클릭→EMU 변환용. */
export async function loadPptxSlideSize(bytes: Uint8Array): Promise<{ cx: number; cy: number }> {
  const fallback = { cx: 12192000, cy: 6858000 }
  try {
    const zip = await JSZip.loadAsync(bytes)
    const f = zip.file('ppt/presentation.xml')
    if (!f) return fallback
    const pres = parser.parse(await f.async('string')) as Record<string, unknown>
    const root = (childByLocal(pres, 'presentation') ?? pres) as Record<string, unknown>
    const sldSz = childByLocal(root, 'sldSz') as Record<string, unknown> | undefined
    const cx = Number(sldSz?.['@_cx'] ?? 0)
    const cy = Number(sldSz?.['@_cy'] ?? 0)
    if (cx > 0 && cy > 0) return { cx, cy }
  } catch {
    /* 무시 */
  }
  return fallback
}

export async function loadPptxComments(bytes: Uint8Array): Promise<PptxComment[]> {
  const out: PptxComment[] = []
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
    // 슬라이드 순서: presentation sldIdLst + presentation rels.
    const pres = await readXml('ppt/presentation.xml')
    const presRoot = (childByLocal((pres ?? {}) as Record<string, unknown>, 'presentation') ??
      pres ?? {}) as Record<string, unknown>
    const sldIdLst = childByLocal(presRoot, 'sldIdLst')
    const sldIds = asArray(
      childByLocal((sldIdLst ?? {}) as Record<string, unknown>, 'sldId'),
    ) as Record<string, unknown>[]
    const presRels = new Map(
      parseRels(await readXml('ppt/_rels/presentation.xml.rels')).map((r) => [r.id, r.target]),
    )

    // 작성자 표: 모던은 presentation rels로 위치를 찾는다
    // (ppt/authors/author1.xml 등. 없으면 ppt/authors.xml 폴백).
    const authors = new Map<string, string>()
    const loadAuthorList = (doc: Record<string, unknown> | null, listLocal: string, itemLocal: string) => {
      if (!doc) return
      const lst = childByLocal(doc, listLocal)
      for (const a of asArray(childByLocal((lst ?? {}) as Record<string, unknown>, itemLocal))) {
        const o = a as Record<string, unknown>
        const id = String(o['@_id'] ?? '')
        if (id && !authors.has(id)) authors.set(id, String(o['@_name'] ?? 'Unknown'))
      }
    }
    const MODERN_AUTHOR_REL = 'http://schemas.microsoft.com/office/2018/10/relationships/authors'
    const presRelsDoc = await readXml('ppt/_rels/presentation.xml.rels')
    const authorTargets: string[] = []
    if (presRelsDoc) {
      for (const r of parseRels(presRelsDoc)) {
        if (r.type === MODERN_AUTHOR_REL && r.target) authorTargets.push(r.target)
      }
    }
    for (const t of authorTargets) {
      loadAuthorList(await readXml(joinTarget('ppt', t)), 'authorLst', 'author')
    }
    loadAuthorList(await readXml('ppt/authors.xml'), 'authorLst', 'author')
    const legacyAuthorsDoc = await readXml('ppt/commentAuthors.xml')
    loadAuthorList(legacyAuthorsDoc, 'cmAuthorLst', 'cmAuthor')

    const parseCm = (cm: Record<string, unknown>): { author: string; text: string; created: string } => ({
      author: authors.get(String(cm['@_authorId'] ?? '')) ?? 'Unknown',
      text: txBodyText(cm),
      created: String(cm['@_created'] ?? cm['@_dt'] ?? ''),
    })

    for (let i = 0; i < sldIds.length; i++) {
      const sld = sldIds[i] ?? {}
      const rId = String(sld['@_r:id'] ?? sld['@_id'] ?? '')
      const target = presRels.get(rId)
      if (!target) continue
      const slidePath = joinTarget('ppt', target)
      const dir = slidePath.includes('/') ? slidePath.slice(0, slidePath.lastIndexOf('/')) : ''
      const base = slidePath.slice(slidePath.lastIndexOf('/') + 1)
      const relsDoc = await readXml(joinTarget(dir, `_rels/${base}.rels`))
      if (!relsDoc) continue
      const commentRels = parseRels(relsDoc).filter(
        (r) => r.type.endsWith('/comments') || r.type.endsWith('/commentAuthors'),
      )
      for (const rel of commentRels) {
        const doc = await readXml(joinTarget(dir, rel.target))
        if (!doc) continue
        const lst = childByLocal(doc, 'cmLst')
        const items = asArray(childByLocal((lst ?? {}) as Record<string, unknown>, 'cm')) as Record<
          string,
          unknown
        >[]
        // 답글: (1) 모던 p188:replyLst/p188:reply, (2) 중첩 cm,
        // (3) parentId 참조, (4) 레거시 p15:threadingInfo parentCm (authorId+idx).
        const roots: typeof items = []
        const byKey = new Map<string, number>()
        items.forEach((cm, idx) => {
          const suffix = String(cm['@_idx'] ?? cm['@_id'] ?? '')
          if (suffix) byKey.set(`${String(cm['@_authorId'] ?? '')}:${suffix}`, idx)
        })
        const children = new Map<number, typeof items>()
        const claimed = new Set<number>()
        const threadParentKey = (cm: Record<string, unknown>): string | null => {
          for (const ext of asArray(childByLocal(cm, 'extLst'))) {
            for (const e of asArray(
              childByLocal((ext ?? {}) as Record<string, unknown>, 'ext'),
            )) {
              const info = childByLocal((e ?? {}) as Record<string, unknown>, 'threadingInfo')
              if (!info) continue
              const p = childByLocal(info as Record<string, unknown>, 'parentCm') as
                | Record<string, unknown>
                | undefined
              if (p) return `${String(p['@_authorId'] ?? '')}:${String(p['@_idx'] ?? '')}`
            }
          }
          return null
        }
        items.forEach((cm) => {
          // 모던 답글 목록.
          const replyNodes = asArray(childByLocal(cm, 'replyLst')).flatMap((rl) =>
            asArray(childByLocal((rl ?? {}) as Record<string, unknown>, 'reply')),
          ) as typeof items
          if (replyNodes.length) {
            const idx = items.indexOf(cm)
            children.set(idx, [...(children.get(idx) ?? []), ...replyNodes])
          }
          const nested = asArray(childByLocal(cm, 'cm')) as typeof items
          if (nested.length) {
            const idx = items.indexOf(cm)
            children.set(idx, [...(children.get(idx) ?? []), ...nested])
          }
          const parent =
            String(cm['@_parentId'] ?? cm['@_parent'] ?? '') || threadParentKey(cm) || ''
          const pi = parent ? byKey.get(parent) : undefined
          // parentId 형태(id만)도 키 끝과 매칭해본다.
          const piById =
            pi ??
            (parent && !parent.includes(':')
              ? items.findIndex((o) => String(o['@_id'] ?? '') === parent)
              : undefined)
          if (piById !== undefined && piById >= 0) {
            children.set(piById, [...(children.get(piById) ?? []), cm])
            claimed.add(items.indexOf(cm))
          }
        })
        items.forEach((cm) => {
          if (!claimed.has(items.indexOf(cm))) roots.push(cm)
        })
        for (const cm of roots) {
          const main = parseCm(cm)
          const idx = items.indexOf(cm)
          out.push({
            slideNo: i + 1,
            author: main.author,
            text: main.text,
            created: main.created,
            replies: (children.get(idx) ?? []).map((r) => {
              const p = parseCm(r)
              return { author: p.author, text: p.text, created: p.created }
            }),
          })
        }
      }
    }
  } catch {
    // 파싱 실패는 코멘트 없음으로 취급한다.
  }
  return out.filter((c) => c.text || c.replies.length > 0)
}
