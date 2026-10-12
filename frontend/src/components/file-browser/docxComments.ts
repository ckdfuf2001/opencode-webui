import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'

/** 워드 코멘트 (레거시 + 모던 스레드). lib 패널 대신 우측 목록으로 보여준다. */
export type DocxCommentReply = {
  author: string
  date: string
  text: string
  /** w:comment @id (답글/삭제용). */
  cid: string
}

export type DocxComment = {
  author: string
  date: string
  text: string
  /** 범위 앞 40자 (문서 위치 힌트). */
  anchor: string
  replies: DocxCommentReply[]
  resolved: boolean
  /** w:comment @id (레거시 포함 — 전체 ops 지원). */
  cid: string
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

/** prefix 무시하고 자식을 찾는다. */
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

function attr(obj: unknown, ...locals: string[]): string {
  if (typeof obj !== 'object' || obj === null) return ''
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!k.startsWith('@_')) continue
    const name = k.slice(2)
    const local = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name
    if (locals.some((l) => l.toLowerCase() === local.toLowerCase())) return String(v ?? '')
  }
  return ''
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 문서 범위 텍스트 (commentRangeStart~End 사이 w:t 이어붙이기, 최대 40자). */
function anchorText(docXml: string, id: string): string {
  const si = docXml.indexOf(`<w:commentRangeStart w:id="${id}"`)
  if (si < 0) return ''
  const se = docXml.indexOf(`<w:commentRangeEnd w:id="${id}"`, si)
  const slice = docXml.slice(si, se < 0 ? si + 2000 : se)
  const texts: string[] = []
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(slice)) && texts.join(' ').length < 60) texts.push(m[1])
  return norm(texts.join(' ')).slice(0, 40)
}

export async function loadDocxComments(bytes: Uint8Array): Promise<DocxComment[]> {
  try {
    const zip = await JSZip.loadAsync(bytes)
    const cf = zip.file('word/comments.xml')
    if (!cf) return []
    const doc = parser.parse(await cf.async('string')) as Record<string, unknown>
    const comments = asArray(
      kid(doc, 'comments', 'comment'),
    ).flatMap((c) => asArray(kid(c, 'comment'))) as Record<string, unknown>[]
    if (comments.length === 0) {
      const root = kid(doc, 'comments') as Record<string, unknown> | undefined
      const direct = asArray(kid(root, 'comment')) as Record<string, unknown>[]
      if (direct.length > 0) comments.push(...direct)
    }
    // paraId 맵 (w:p w14:paraId).
    const idToPara = new Map<string, string>()
    const idToText = new Map<string, string>()
    for (const c of comments) {
      const id = attr(c, 'id')
      const p = kid(c, 'p')
      const paras = asArray(p) as Record<string, unknown>[]
      const paraIds = paras.map((x) => attr(x, 'paraId')).filter(Boolean)
      if (id && paraIds[0]) idToPara.set(id, paraIds[0])
      if (id) {
        const ts: string[] = []
        for (const x of paras) {
          for (const r of asArray(kid(x, 'r'))) {
            const t = kid(r, 't')
            if (typeof t === 'string') ts.push(t)
            else if (t && typeof t === 'object') {
              const inner = (t as Record<string, unknown>)['#text']
              if (typeof inner === 'string') ts.push(inner)
            }
          }
        }
        idToText.set(id, norm(ts.join('\n')))
      }
    }
    // 확장 정보 (done/부모).
    const paraDone = new Map<string, boolean>()
    const paraParent = new Map<string, string>()
    const exf = zip.file('word/commentsExtended.xml')
    if (exf) {
      const ex = parser.parse(await exf.async('string')) as Record<string, unknown>
      const items = asArray(kid(kid(ex, 'commentsEx'), 'commentEx')) as Record<string, unknown>[]
      for (const it of items) {
        const pid = attr(it, 'paraId')
        if (!pid) continue
        paraDone.set(pid, attr(it, 'done') === '1')
        const pp = attr(it, 'paraIdParent')
        if (pp) paraParent.set(pid, pp)
      }
    }
    const paraToId = new Map<string, string>()
    for (const [id, para] of idToPara) paraToId.set(para, id)
    let docXml = ''
    try {
      const df = zip.file('word/document.xml')
      if (df) docXml = await df.async('string')
    } catch {
      /* 무시 */
    }
    const roots: DocxComment[] = []
    const kids = new Map<string, DocxCommentReply[]>()
    for (const c of comments) {
      const id = attr(c, 'id')
      const para = idToPara.get(id) ?? ''
      const parentPara = para ? (paraParent.get(para) ?? '') : ''
      const parentId = parentPara ? (paraToId.get(parentPara) ?? '') : ''
      const entry = {
        author: attr(c, 'author') || 'Unknown',
        date: attr(c, 'date'),
        text: idToText.get(id) ?? '',
      }
      if (parentId) {
        const list = kids.get(parentId) ?? []
        list.push({ ...entry, cid: id })
        kids.set(parentId, list)
      } else {
        roots.push({
          ...entry,
          anchor: docXml ? anchorText(docXml, id) : '',
          replies: [],
          resolved: para ? (paraDone.get(para) ?? false) : false,
          cid: id,
        })
      }
    }
    for (const r of roots) r.replies = kids.get(r.cid) ?? []
    return roots
  } catch {
    return []
  }
}

/** 코멘트가 하나라도 있으면 true (패널 자동 열기용). */
export async function hasDocxComments(bytes: Uint8Array): Promise<boolean> {
  try {
    const zip = await JSZip.loadAsync(bytes)
    const f = zip.file('word/comments.xml')
    if (!f) return false
    const xml = await f.async('string')
    return /<w:comment[\s>]/.test(xml)
  } catch {
    return false
  }
}
