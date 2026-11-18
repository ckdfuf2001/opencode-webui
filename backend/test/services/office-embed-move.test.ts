import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import {
  assembleDocxEmbed,
  assembleXlsxEmbed,
  moveDocxEmbed,
  moveXlsxEmbed,
  topLevelBlocks,
  type ZipLike,
} from '../../src/services/office-embed'

/**
 * C7n red: xlsx/docx 첨부 이동 (앵커 재기록).
 * - 서버 함수가 아직 없어 import 자체가 실패한다.
 */
const zipLoad = async (b: Uint8Array): Promise<ZipLike> => {
  const z = await JSZip.loadAsync(b)
  return z as unknown as ZipLike
}

async function makeHostXlsx(): Promise<Uint8Array> {
  const z = new JSZip()
  z.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet.main+xml"/></Types>',
  )
  z.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  )
  z.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>',
  )
  z.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  )
  z.file(
    'xl/worksheets/sheet1.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>',
  )
  z.file(
    'xl/worksheets/_rels/sheet1.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings" Target="../printerSettings/printerSettings1.bin"/></Relationships>',
  )
  return z.generateAsync({ type: 'uint8array' })
}

async function makeAttachDocx(payload = 'move me'): Promise<Uint8Array> {
  const z = new JSZip()
  z.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  )
  z.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${payload}</w:t></w:r></w:p></w:body></w:document>`,
  )
  return z.generateAsync({ type: 'uint8array' })
}

async function makeHostDocx3(): Promise<Uint8Array> {
  const z = new JSZip()
  z.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  )
  z.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  )
  z.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>para0</w:t></w:r></w:p><w:p><w:r><w:t>para1</w:t></w:r></w:p><w:p><w:r><w:t>para2</w:t></w:r></w:p></w:body></w:document>',
  )
  z.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  )
  return z.generateAsync({ type: 'uint8array' })
}

function oleAnchorOf(sheetXml: string): number[] | null {
  const m = /<oleObject[^>]*>([\s\S]*?)<\/oleObject>/.exec(sheetXml)
  if (!m) return null
  const a = /<anchor[^>]*>([\s\S]*?)<\/anchor>/.exec(m[1])
  if (!a) return null
  const nums = [...a[1].matchAll(/<(?:\w+:)?(?:col|row|colOff|rowOff)[^>]*>(\d+)</g)].map((n) => Number(n[1]))
  return nums.length >= 8 ? nums.slice(0, 8) : null
}

describe('moveXlsxEmbed', () => {
  it('앵커 셀을 옮기고 크기를 유지한다 (3곳 동기화)', async () => {
    const host = await makeHostXlsx()
    const attach = await makeAttachDocx('ZZ move xlsx')
    const once = await assembleXlsxEmbed(zipLoad, {
      hostBytes: host,
      attachBytes: attach,
      attachName: 'm.docx',
      attachKind: 'docx',
      sheet: 0,
      cellCol: 1,
      cellRow: 7,
    })
    const moved = await moveXlsxEmbed(zipLoad, once, 'xl/embeddings/m.docx', { sheet: 0, col: 5, row: 20 })
    expect(moved.found).toBe(true)
    const z = await zipLoad(moved.bytes)
    // objectPr 앵커: from=(5,20), 크기 유지 to=(6,23).
    const sheet = (await z.files['xl/worksheets/sheet1.xml']!.async('string')) as string
    expect(oleAnchorOf(sheet)).toEqual([5, 0, 20, 0, 6, 0, 23, 0])
    // drawing 앵커도 같은 셀로.
    const drawing = (await z.files['xl/drawings/drawing1.xml']!.async('string')) as string
    const dm = /<xdr:from>([\s\S]*?)<\/xdr:from>/.exec(drawing)
    expect(dm).not.toBeNull()
    const dnums = [...dm![1].matchAll(/<(?:\w+:)?(?:col|row|colOff|rowOff)[^>]*>(\d+)</g)].map((n) => Number(n[1]))
    expect(dnums.slice(0, 4)).toEqual([5, 0, 20, 0])
    // 임베딩 바이트는 그대로.
    expect(Buffer.from(await z.files['xl/embeddings/m.docx']!.async('uint8array'))).toEqual(Buffer.from(attach))
  })

  it('없는 파트는 found=false', async () => {
    const host = await makeHostXlsx()
    const attach = await makeAttachDocx('ZZ move xlsx miss')
    const once = await assembleXlsxEmbed(zipLoad, {
      hostBytes: host, attachBytes: attach, attachName: 'm.docx', attachKind: 'docx',
    })
    const moved = await moveXlsxEmbed(zipLoad, once, 'xl/embeddings/none.docx', { sheet: 0, col: 2, row: 3 })
    expect(moved.found).toBe(false)
  })
})

describe('moveDocxEmbed', () => {
  it('w:object 문단을 지정 블록 뒤로 옮긴다', async () => {
    const host = await makeHostDocx3()
    const attach = await makeAttachDocx('ZZ move docx')
    const once = await assembleDocxEmbed(zipLoad, {
      hostBytes: host, attachBytes: attach, attachName: 'm.docx', attachKind: 'docx',
    })
    // 조립분은 맨 끝(para0,1,2 다음)에 있다.
    let doc = (await (await zipLoad(once)).files['word/document.xml']!.async('string')) as string
    expect(topLevelBlocks(doc).length).toBe(4)
    const moved = await moveDocxEmbed(zipLoad, once, 'word/embeddings/m.docx', { block: 0 })
    expect(moved.found).toBe(true)
    doc = (await (await zipLoad(moved.bytes)).files['word/document.xml']!.async('string')) as string
    const blocks = topLevelBlocks(doc)
    expect(blocks.length).toBe(4)
    // para0 다음이 w:object 문단이어야 한다.
    expect(blocks[0]!.text).toContain('para0')
    expect(doc.slice(blocks[1]!.start, blocks[1]!.end)).toContain('<w:object')
    expect(blocks[3]!.text).toContain('para2')
    // 임베딩 바이트는 그대로.
    const z = await zipLoad(moved.bytes)
    expect(Buffer.from(await z.files['word/embeddings/m.docx']!.async('uint8array'))).toEqual(Buffer.from(attach))
  })

  it('없는 파트는 found=false, 범위 밖 블록은 throw', async () => {
    const host = await makeHostDocx3()
    const attach = await makeAttachDocx('ZZ move docx miss')
    const once = await assembleDocxEmbed(zipLoad, {
      hostBytes: host, attachBytes: attach, attachName: 'm.docx', attachKind: 'docx',
    })
    const miss = await moveDocxEmbed(zipLoad, once, 'word/embeddings/none.docx', { block: 0 })
    expect(miss.found).toBe(false)
    await expect(moveDocxEmbed(zipLoad, once, 'word/embeddings/m.docx', { block: 99 })).rejects.toThrow()
  })

  it('텍스트가 맞으면 텍스트 위치로 옮긴다 (인덱스보다 우선)', async () => {
    const z0 = new JSZip()
    z0.file(
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    )
    z0.file(
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    )
    z0.file(
      'word/document.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>alpha one</w:t></w:r></w:p><w:p><w:r><w:t>beta two target here</w:t></w:r></w:p><w:p><w:r><w:t>gamma three</w:t></w:r></w:p></w:body></w:document>',
    )
    z0.file(
      'word/_rels/document.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    )
    const host = await z0.generateAsync({ type: 'uint8array' })
    const attach = await makeAttachDocx('ZZ move docx text')
    const once = await assembleDocxEmbed(zipLoad, {
      hostBytes: host, attachBytes: attach, attachName: 'm.docx', attachKind: 'docx',
    })
    // 텍스트로 beta 단락 뒤를 지정 (인덱스는 일부러 틀리게).
    const moved = await moveDocxEmbed(zipLoad, once, 'word/embeddings/m.docx', { block: 0, blockText: 'beta two target here and more words' })
    expect(moved.found).toBe(true)
    const doc = (await (await zipLoad(moved.bytes)).files['word/document.xml']!.async('string')) as string
    const betaIdx = doc.indexOf('beta two target here')
    const gammaIdx = doc.indexOf('gamma three')
    const objIdx = doc.indexOf('<w:object')
    // beta 단락 뒤, gamma 단락 앞에 w:object 문단이 와야 한다.
    expect(objIdx).toBeGreaterThan(betaIdx)
    expect(objIdx).toBeLessThan(gammaIdx)
  })
})
