import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { patchUnsupportedAnchors } from '../src/lib/xlsxAnchorPatch'

const DRAWING_BEFORE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<xdr:twoCellAnchor editAs="oneCell">
<xdr:from><xdr:col>1</xdr:col><xdr:colOff>84667</xdr:colOff><xdr:row>3</xdr:row><xdr:rowOff>127000</xdr:rowOff></xdr:from>
<xdr:to><xdr:col>2</xdr:col><xdr:colOff>169333</xdr:colOff><xdr:row>6</xdr:row><xdr:rowOff>12700</xdr:rowOff></xdr:to>
<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="1" name="ole"/></xdr:nvSpPr></xdr:sp>
<xdr:clientData/>
</xdr:twoCellAnchor>
</xdr:wsDr>`

async function makeXlsx(drawingXml: string): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file('_rels/.rels', '<Relationships/>')
  zip.file(
    'xl/workbook.xml',
    `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<Relationships><Relationship Id="rId1" Type="sheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  )
  zip.file('xl/worksheets/sheet1.xml', '<worksheet/>')
  zip.file(
    'xl/worksheets/_rels/sheet1.xml.rels',
    `<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
  )
  // vmlDrawing rel이 먼저 있어도 drawing 파트를 찾아야 한다 (회귀).
  zip.file('xl/drawings/vmlDrawing1.vml', '<xml/>')
  zip.file('xl/drawings/drawing1.xml', drawingXml)
  zip.file('xl/oleObjects/oleObject1.bin', new Uint8Array([1, 2, 3, 4]))
  zip.file('xl/embeddings/oleObject1.bin', new Uint8Array([5, 6, 7, 8]))
  return zip.generateAsync({ type: 'uint8array' })
}

async function drawingOf(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  return zip.file('xl/drawings/drawing1.xml')!.async('string')
}

describe('patchUnsupportedAnchors', () => {
  it('twoCellAnchor from/to를 모델 값으로 교체하고 나머지는 그대로 둔다', async () => {
    const before = await makeXlsx(DRAWING_BEFORE)
    const after = await patchUnsupportedAnchors(before, [
      {
        sheet: 0,
        index: 0,
        anchor: {
          from: { col: 3, row: 9, colOffset: 389467, rowOffset: 12700 },
          to: { col: 4, row: 11, colOffset: 474133, rowOffset: 107950 },
        },
      },
    ])
    const xml = await drawingOf(after)
    expect(xml).toContain('<xdr:col>3</xdr:col>')
    expect(xml).toContain('<xdr:colOff>389467</xdr:colOff>')
    expect(xml).toContain('<xdr:row>9</xdr:row>')
    expect(xml).toContain('<xdr:col>4</xdr:col>')
    expect(xml).toContain('<xdr:row>11</xdr:row>')
    expect(xml).not.toContain('<xdr:col>1</xdr:col>')
    // 앵커 블록 외(도형 본문·속성)는 유지.
    expect(xml).toContain('editAs="oneCell"')
    expect(xml).toContain('name="ole"')
    // ole 파트 보존.
    const z = await JSZip.loadAsync(after)
    expect(Array.from(await z.file('xl/oleObjects/oleObject1.bin')!.async('uint8array'))).toEqual([1, 2, 3, 4])
    expect(Array.from(await z.file('xl/embeddings/oleObject1.bin')!.async('uint8array'))).toEqual([5, 6, 7, 8])
  })

  it('업데이트가 없으면 원본 그대로', async () => {
    const before = await makeXlsx(DRAWING_BEFORE)
    const after = await patchUnsupportedAnchors(before, [])
    expect(Buffer.from(after)).toEqual(Buffer.from(before))
  })

  it('인덱스 범위를 벗어나면 손대지 않는다', async () => {
    const before = await makeXlsx(DRAWING_BEFORE)
    const after = await patchUnsupportedAnchors(before, [
      { sheet: 0, index: 3, anchor: { from: { col: 9, row: 9 }, to: { col: 9, row: 9 } } },
    ])
    expect(await drawingOf(after)).toBe(DRAWING_BEFORE)
  })

  it('oneCellAnchor만 있으면 손대지 않는다', async () => {
    const one = DRAWING_BEFORE.split('twoCellAnchor').join('oneCellAnchor')
    const before = await makeXlsx(one)
    const after = await patchUnsupportedAnchors(before, [
      {
        sheet: 0,
        index: 0,
        anchor: { from: { col: 3, row: 9 }, to: { col: 4, row: 11 } },
      },
    ])
    expect(await drawingOf(after)).toBe(one)
  })

  it('불완전 앵커(to 없음)는 스킵한다', async () => {
    const before = await makeXlsx(DRAWING_BEFORE)
    const after = await patchUnsupportedAnchors(before, [
      { sheet: 0, index: 0, anchor: { from: { col: 3, row: 9 } } },
    ])
    expect(await drawingOf(after)).toBe(DRAWING_BEFORE)
  })
})
