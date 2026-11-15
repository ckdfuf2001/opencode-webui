import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { assembleXlsxEmbed, syncXlsxOleAnchors } from '../../src/services/office-embed'

const zipLoad = (b: Uint8Array): Promise<unknown> => JSZip.loadAsync(b) as unknown as Promise<unknown>

async function anchorsOf(bytes: Uint8Array): Promise<{ objPr: string[]; draw: string[] }> {
  const zip = (await zipLoad(bytes)) as JSZip
  const sheet = await zip.files['xl/worksheets/sheet1.xml']!.async('string')
  const drawingName = Object.keys(zip.files).find((n) => /drawings\/drawing[0-9]*\.xml$/.test(n))!
  const drawing = await zip.files[drawingName]!.async('string')
  const objPr = [...sheet.matchAll(/<oleObject[^>]*\bshapeId="1026"[^>]*>([\s\S]*?)<\/oleObject>/g)].map(
    (m) => (/<anchor[^>]*>([\s\S]*?)<\/anchor>/.exec(m[1])?.[1] ?? '').replace(/\s+/g, ' '),
  )
  const draw = [...drawing.matchAll(/<xdr:twoCellAnchor[^>]*>[\s\S]*?<\/xdr:twoCellAnchor>/g)]
    .map((b) => b[0])
    .filter((blk) => new RegExp(`<xdr:cNvPr[^>]*\\bid="1026"`).test(blk))
    .map((blk) => {
      const fm = /<xdr:from>([\s\S]*?)<\/xdr:from>/.exec(blk)
      const tm = /<xdr:to>([\s\S]*?)<\/xdr:to>/.exec(blk)
      return `${(fm?.[1] ?? '').replace(/\s+/g, ' ')}|${(tm?.[1] ?? '').replace(/\s+/g, ' ')}`
    })
  return { objPr, draw }
}

describe('syncXlsxOleAnchors', () => {
  it('lib처럼 DRAW만 옮긴 파일의 OBJPR을 DRAW에 맞춘다', async () => {
    const hostBytes = new Uint8Array(
      fs.readFileSync(path.join(process.cwd(), '../e2e/collab/fixtures/ole/embed-pdf.xlsx')),
    )
    const attachBytes = new Uint8Array(
      fs.readFileSync(path.join(process.cwd(), '../e2e/collab/fixtures/ole/embed-docx.xlsx')),
    )
    const assembled = await assembleXlsxEmbed(zipLoad as never, {
      hostBytes,
      attachBytes,
      attachName: 'sync-test.xlsx',
      attachKind: 'xlsx',
      sheet: 0,
      cellCol: 4,
      cellRow: 4,
    } as never)
    // lib 드래그 흉내: DRAW from만 C5→D8로 옮기고 OBJPR은 그대로 둔다 (부분 갱신).
    const zip = (await zipLoad(assembled)) as JSZip
    const dnames = Object.keys(zip.files).filter((n) => /drawings\/drawing[0-9]*\.xml$/.test(n))
    const dname = dnames[0]!
    let dxml = await zip.files[dname]!.async('string')
    // shapeId 1026 (우리 삽입분, xdr:pic)의 DRAW from을 col 4→6, row 4→7로 바꾼다.
    // (from/to가 cNvPr보다 앞에 있으므로 anchor 블록 단위로 찾는다.)
    let replaced = 0
    // 위치 기준으로 1026 앵커 블록을 정확히 잘라낸다 (정규식 스패닝 방지).
    {
      const cPos = dxml.indexOf('id="1026"')
      expect(cPos).toBeGreaterThan(0)
      const openTag = '<xdr:twoCellAnchor'
      const closeTag = '</xdr:twoCellAnchor>'
      const lastCloseBefore = dxml.lastIndexOf(closeTag, cPos)
      const openPos = dxml.indexOf(openTag, lastCloseBefore + 1)
      const closePos = dxml.indexOf(closeTag, cPos)
      expect(openPos).toBeGreaterThanOrEqual(0)
      expect(closePos).toBeGreaterThan(cPos)
      const blk = dxml.slice(openPos, closePos)
      let k = 0
      const vals = [6, 1000, 7, 2000]
      const fixed = blk.replace(/(<xdr:from>)([\s\S]*?)(<\/xdr:from>)/, (_s: string, open: string, from: string, close: string) => {
        const ff = from.replace(/<(?:\w+:)?(?:col|row|colOff|rowOff)[^>]*>(\d+)</g, (m: string) =>
          m.replace(/>\d+</, `>${vals[k++ % 4]}<`),
        )
        return `${open}${ff}${close}`
      })
      if (fixed !== blk) {
        replaced++
        dxml = dxml.slice(0, openPos) + fixed + dxml.slice(closePos)
      }
    }
    expect(replaced).toBe(1)
    zip.file(dname, dxml)
    const moved = (await zip.generateAsync({ type: 'uint8array' })) as Uint8Array
    const before = await anchorsOf(moved)
    const bnums = (s: string): number[] => [...s.matchAll(/>(\d+)</g)].map((m) => Number(m[1]))
    expect(before.draw.length).toBe(1)
    expect(before.objPr.length).toBe(1)
    // red 전제: DRAW와 OBJPR이 어긋나 있다 (lib 부분 갱신 재현).
    expect(before.draw[0]).not.toBe(before.objPr[0])
    const { bytes, synced } = await syncXlsxOleAnchors(zipLoad as never, moved)
    expect(synced).toBeGreaterThan(0)
    const after = await anchorsOf(bytes)
    // green: OBJPR 숫자 8개가 DRAW 숫자 8개와 일치한다.
    const nums = (s: string): number[] =>
      [...s.matchAll(/>(\d+)</g)].map((m) => Number(m[1]))
    // draw는 from|to 합쳐 8개, objPr anchor도 8개.
    expect(nums(after.objPr[0]!)).toEqual(nums(after.draw[0]!))
  })
})
