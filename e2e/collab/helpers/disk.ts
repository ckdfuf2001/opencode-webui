import fs from 'node:fs'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: false })

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

function childByLocal(obj: Record<string, unknown>, local: string): unknown {
  for (const [k, v] of Object.entries(obj)) {
    const name = k.includes(':') ? k.slice(k.indexOf(':') + 1) : k
    if (name === local) return v
  }
  return undefined
}

/** shape 이름(cNvPr/@name)으로 텍스트를 읽는다. */
export interface DeckSnapshot {
  slideCount: number
  textOf: (shapeName: string) => string | null
}

export async function readDeck(absPath: string): Promise<DeckSnapshot> {
  const bytes = await fs.promises.readFile(absPath)
  const zip = await JSZip.loadAsync(bytes)
  const readXml = async (p: string): Promise<Record<string, unknown> | null> => {
    const f = zip.file(p)
    if (!f) return null
    try {
      return parser.parse(await f.async('string')) as Record<string, unknown>
    } catch {
      return null
    }
  }
  const joinTarget = (baseDir: string, target: string): string => {
    if (target.startsWith('/')) return target.slice(1)
    const segs: string[] = []
    for (const part of `${baseDir}/${target}`.split('/')) {
      if (part === '' || part === '.') continue
      if (part === '..') segs.pop()
      else segs.push(part)
    }
    return segs.join('/')
  }
  const parseRels = (doc: unknown): Map<string, string> => {
    const root = (doc as Record<string, unknown> | undefined)?.['Relationships'] as Record<string, unknown> | undefined
    const out = new Map<string, string>()
    for (const r of asArray(root?.['Relationship'] as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
      out.set(String(r['@_Id'] ?? ''), String(r['@_Target'] ?? ''))
    }
    return out
  }

  const pres = await readXml('ppt/presentation.xml')
  const presDoc = (childByLocal((pres ?? {}) as Record<string, unknown>, 'presentation') ?? pres ?? {}) as Record<string, unknown>
  const sldIds = asArray(childByLocal(childByLocal(presDoc, 'sldIdLst') as Record<string, unknown> ?? {}, 'sldId')) as Record<string, unknown>[]
  const presRels = parseRels(await readXml('ppt/_rels/presentation.xml.rels'))

  const texts = new Map<string, string>()
  for (const sld of sldIds) {
    const rId = String(sld['@_r:id'] ?? sld['@_id'] ?? '')
    const target = presRels.get(rId)
    if (!target) continue
    const slidePath = joinTarget('ppt', target)
    const slide = await readXml(slidePath)
    if (!slide) continue
    const slideRoot = (childByLocal(slide as Record<string, unknown>, 'sld') ?? slide) as Record<string, unknown>
    const cSld = childByLocal(slideRoot, 'cSld') ?? slideRoot
    const spTree = childByLocal((cSld ?? {}) as Record<string, unknown>, 'spTree')
    for (const sp of asArray(childByLocal((spTree ?? {}) as Record<string, unknown>, 'sp'))) {
      const o = sp as Record<string, unknown>
      const nvSpPr = childByLocal(o, 'nvSpPr') as Record<string, unknown> | undefined
      const cNvPr = childByLocal((nvSpPr ?? {}) as Record<string, unknown>, 'cNvPr') as Record<string, unknown> | undefined
      const name = String(cNvPr?.['@_name'] ?? '')
      if (!name) continue
      const txBody = childByLocal(o, 'txBody')
      const t: string[] = []
      const walk = (n: unknown): void => {
        if (typeof n === 'string') return
        if (typeof n !== 'object' || n === null) return
        for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
          const local = k.includes(':') ? k.slice(k.indexOf(':') + 1) : k
          if (local === 't' && typeof v === 'string') t.push(v)
          else walk(v)
        }
      }
      walk(txBody)
      texts.set(name, t.join('').replace(/\s+/g, ' ').trim())
    }
  }
  return {
    slideCount: sldIds.length,
    textOf: (shapeName: string) => texts.get(shapeName) ?? null,
  }
}

/** write-back debounce(2.5초)에 여유를 둔 디스크 대기. */
export async function waitForDisk(
  absPath: string,
  predicate: (deck: DeckSnapshot) => boolean,
  timeout = 8000,
): Promise<DeckSnapshot> {
  const start = Date.now()
  let last!: DeckSnapshot
  for (;;) {
    try {
      last = await readDeck(absPath)
      if (predicate(last)) return last
    } catch {
      // 파일이 아직 없으면 계속 대기
    }
    if (Date.now() - start > timeout) {
      throw new Error(`waitForDisk timeout: ${absPath}`)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}
