import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { syncXlsxOleAnchors } from '../../src/services/office-embed'

const zipLoad = (b: Uint8Array): Promise<unknown> => JSZip.loadAsync(b) as unknown as Promise<unknown>

async function sheetObjPrNumbers(zip: JSZip, sname: string, sid: string): Promise<number[] | null> {
  const sheet = await zip.files[sname]?.async('string')
  if (!sheet) return null
  // self-closing Fallback 제외, 실제 oleObject만.
  const blocks: string[] = []
  let pos = 0
  while (true) {
    const o = sheet.indexOf('<oleObject', pos)
    if (o < 0) break
    const e = sheet.indexOf('>', o)
    if (e < 0) break
    const tag = sheet.slice(o, e + 1)
    if (!new RegExp(`\\bshapeId="${sid}"`).test(tag) || /\/>$/.test(tag)) { pos = e + 1; continue }
    const c = sheet.indexOf('</oleObject>', e)
    if (c < 0) break
    blocks.push(sheet.slice(e + 1, c))
    pos = c + '</oleObject>'.length
  }
  if (blocks.length === 0) return null
  const m = /<anchor[^>]*>([\s\S]*?)<\/anchor>/.exec(blocks[0]!)
  if (!m) return null
  return [...m[1].matchAll(/<(?:\w+:)?(?:col|row|colOff|rowOff)[^>]*>(\d+)</g)].map((n) => Number(n[1]))
}

describe('syncXlsxOleAnchors multi-sheet', () => {
  it('시트1만 옮기면 시트2 위치는 바이트 그대로다 (동일 shapeId)', async () => {
    const base = new Uint8Array(
      fs.readFileSync(path.join(process.cwd(), '../e2e/collab/fixtures/ole/embed-pdf.xlsx')),
    )
    const zip = (await zipLoad(base)) as JSZip
    // 시트2 복제 (Excel per-sheet numbering 재현: 같은 shapeId 1025).
    const s1 = await zip.files['xl/worksheets/sheet1.xml']!.async('string')
    const r1 = await zip.files['xl/worksheets/_rels/sheet1.xml.rels']!.async('string')
    const d1 = await zip.files['xl/drawings/drawing1.xml']!.async('string')
    zip.file('xl/worksheets/sheet2.xml', s1)
    const r2 = r1.replace('../drawings/drawing1.xml', '../drawings/drawing2.xml')
    zip.file('xl/worksheets/_rels/sheet2.xml.rels', r2)
    zip.file('xl/drawings/drawing2.xml', d1)
    const twoSheet = (await zip.generateAsync({ type: 'uint8array' })) as Uint8Array
    // 시트1 DRAW만 옮긴다 (lib 부분 갱신 흉내). drawing1의 1025 from을 바꾼다.
    const z2 = (await zipLoad(twoSheet)) as JSZip
    let dd1 = await z2.files['xl/drawings/drawing1.xml']!.async('string')
    {
      const cPos = dd1.indexOf('id="1025"')
      expect(cPos).toBeGreaterThan(0)
      const openTag = '<xdr:twoCellAnchor'
      const closeTag = '</xdr:twoCellAnchor>'
      const lastCloseBefore = dd1.lastIndexOf(closeTag, cPos)
      const openPos = dd1.indexOf(openTag, lastCloseBefore + 1)
      const closePos = dd1.indexOf(closeTag, cPos)
      const blk = dd1.slice(openPos, closePos)
      let k = 0
      const vals = [9, 100, 9, 200]
      const fixed = blk.replace(/(<xdr:from>)([\s\S]*?)(<\/xdr:from>)/, (_s: string, open: string, from: string, close: string) => {
        const ff = from.replace(/<(?:\w+:)?(?:col|row|colOff|rowOff)[^>]*>(\d+)</g, (m: string) =>
          m.replace(/>\d+</, `>${vals[k++ % 4]}<`),
        )
        return `${open}${ff}${close}`
      })
      expect(fixed).not.toBe(blk)
      dd1 = dd1.slice(0, openPos) + fixed + dd1.slice(closePos)
      z2.file('xl/drawings/drawing1.xml', dd1)
    }
    const moved = (await z2.generateAsync({ type: 'uint8array' })) as Uint8Array
    const zBefore = (await zipLoad(moved)) as JSZip
    const s2Before = await zBefore.files['xl/worksheets/sheet2.xml']!.async('string')
    // red 전제: 시트1 DRAW와 시트1 OBJPR이 어긋나 있다.
    const s1draw = await (async (): Promise<number[] | null> => {
      const dd = await zBefore.files['xl/drawings/drawing1.xml']!.async('string')
      const cPos = dd.indexOf('id="1025"')
      const openPos = dd.indexOf('<xdr:twoCellAnchor', dd.lastIndexOf('</xdr:twoCellAnchor>', cPos) + 1)
      const closePos = dd.indexOf('</xdr:twoCellAnchor>', cPos)
      const blk = dd.slice(openPos, closePos)
      const fm = /<xdr:from>([\s\S]*?)<\/xdr:from>/.exec(blk)
      const tm = /<xdr:to>([\s\S]*?)<\/xdr:to>/.exec(blk)
      if (!fm || !tm) return null
      return [...`${fm[1]}${tm[1]}`.matchAll(/<(?:\w+:)?(?:col|row|colOff|rowOff)[^>]*>(\d+)</g)].map((m) => Number(m[1]))
    })()
    const s1obj = await sheetObjPrNumbers(zBefore, 'xl/worksheets/sheet1.xml', '1025')
    expect(s1draw).not.toBeNull()
    expect(s1obj).not.toBeNull()
    expect(s1draw).not.toEqual(s1obj)
    const { bytes, synced } = await syncXlsxOleAnchors(zipLoad as never, moved)
    expect(synced).toBeGreaterThan(0)
    const zAfter = (await zipLoad(bytes)) as JSZip
    const s2After = await zAfter.files['xl/worksheets/sheet2.xml']!.async('string')
    // green: 시트2는 바이트 그대로 (시트1 위치로 덮어쓰지 않는다).
    expect(s2After).toBe(s2Before)
    // 시트1은 DRAW와 일치한다.
    const s1objAfter = await sheetObjPrNumbers(zAfter, 'xl/worksheets/sheet1.xml', '1025')
    expect(s1objAfter).toEqual(s1draw)
  })
})
