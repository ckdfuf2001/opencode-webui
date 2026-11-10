import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import {
  assembleDocxEmbed,
  assemblePptxEmbed,
  assembleXlsxEmbed,
  attachKindOf,
  checkBalancedXml,
  EMBED_MAX_BYTES,
  genericIconPng,
  sanitizeEmbedName,
  type ZipLike,
} from '../../src/services/office-embed'

const zipLoad = async (b: Uint8Array): Promise<ZipLike> => {
  const z = await JSZip.loadAsync(b)
  return z as unknown as ZipLike
}

async function makeHostPptx(): Promise<Uint8Array> {
  const z = new JSZip()
  z.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide.main+xml"/></Types>',
  )
  z.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
  )
  z.file(
    'ppt/presentation.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></p:sldIdLst></p:presentation>',
  )
  z.file(
    'ppt/_rels/presentation.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
  )
  z.file(
    'ppt/slides/slide1.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld></p:sld>',
  )
  z.file(
    'ppt/slides/_rels/slide1.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>',
  )
  return z.generateAsync({ type: 'uint8array' })
}

async function makeAttachDocx(payload = 'hello attach'): Promise<Uint8Array> {
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

describe('office-embed helpers', () => {
  it('sanitizeEmbedName은 경로를 벗기고 확장자를 유지한다', () => {
    expect(sanitizeEmbedName('C:\\Users\\oh\\a b.docx', 'docx')).toBe('a_b.docx')
    expect(sanitizeEmbedName('../../evil.exe', 'docx')).toBe('evil.exe')
    expect(sanitizeEmbedName('noext', 'xlsx')).toBe('noext.xlsx')
  })
  it('attachKindOf는 docx/xlsx/pptx만 받는다', () => {
    expect(attachKindOf('a.docx')).toBe('docx')
    expect(attachKindOf('A.XLSX')).toBe('xlsx')
    expect(attachKindOf('a.pdf')).toBe(null)
  })
  it('genericIconPng는 유효한 PNG다 (시그니처+IHDR)', () => {
    const png = genericIconPng()
    expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(png.length).toBeGreaterThan(100)
    expect(Buffer.from(genericIconPng())).toEqual(Buffer.from(png))
  })
  it('EMBED_MAX_BYTES는 20MB다', () => {
    expect(EMBED_MAX_BYTES).toBe(20 * 1024 * 1024)
  })
  it('checkBalancedXml은 어긋난 태그를 거부한다', () => {
    expect(() => checkBalancedXml('<a><b></a></b>', 't')).toThrowError(/nbalanced/)
    expect(() => checkBalancedXml('<a><b></b>', 't')).toThrowError(/nbalanced/)
    expect(() => checkBalancedXml('<a><br/><b>x</b></a>', 't')).not.toThrow()
    expect(() => checkBalancedXml('<a><!-- <b> --><b>x</b></a>', 't')).not.toThrow()
  })
})

describe('assemblePptxEmbed', () => {
  it('docx를 ole 프레임으로 넣는다 (embeddings+rels+contenttypes+progId)', async () => {
    const host = await makeHostPptx()
    const attach = await makeAttachDocx()
    const out = await assemblePptxEmbed(zipLoad, {
      hostBytes: host,
      attachBytes: attach,
      attachName: 'report.docx',
      attachKind: 'docx',
      slide: 1,
    })
    const z = await JSZip.loadAsync(out)
    const names = Object.keys(z.files).filter((n) => !z.files[n]!.dir)
    // embeddings 원본 그대로.
    const emb = names.filter((n) => n.startsWith('ppt/embeddings/'))
    expect(emb).toEqual(['ppt/embeddings/report.docx'])
    expect(Buffer.from(await z.files[emb[0]!]!.async('uint8array'))).toEqual(Buffer.from(attach))
    // 미리보기 PNG.
    expect(names.some((n) => n === 'ppt/media/image1.png')).toBe(true)
    // slide 프레임 + rels.
    const slide = await z.files['ppt/slides/slide1.xml']!.async('string')
    expect(slide).toContain('presentationml/2006/ole')
    expect(slide).toContain('progId="Word.Document.12"')
    expect(slide).toContain('name="report"')
    // graphicFrame 지오메트리는 p:xfrm (a:가 아니라 PowerPoint 네이티브).
    expect(slide).toContain('<p:xfrm><a:off')
    const rels = await z.files['ppt/slides/_rels/slide1.xml.rels']!.async('string')
    expect(rels).toContain('/package')
    expect(rels).toContain('../embeddings/')
    expect(rels).toContain('../media/image1.png')
    // content types.
    const ct = await z.files['[Content_Types].xml']!.async('string')
    expect(ct).toContain('Extension="png"')
    expect(ct).toContain('ppt/embeddings/')
  })

  it('ole 프레임은 아이콘 크기다 (xlsx 앵커와 동급)', async () => {
    const host = await makeHostPptx()
    const attach = await makeAttachDocx()
    const out = await assemblePptxEmbed(zipLoad, {
      hostBytes: host,
      attachBytes: attach,
      attachName: 'a.docx',
      attachKind: 'docx',
      slide: 1,
    })
    const z = await JSZip.loadAsync(out)
    const slide = await z.files['ppt/slides/slide1.xml']!.async('string')
    expect(slide).toContain('cx="1296000"')
    expect(slide).toContain('cy="648000"')
    // 미리보기 PNG는 프레임과 같은 2:1 (192x96) — 찌그러짐 없음.
    const png = await z.files['ppt/media/image1.png']!.async('uint8array')
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength)
    expect(dv.getUint32(16)).toBe(192)
    expect(dv.getUint32(20)).toBe(96)
  })

  it('같은 이름이 있으면 -2를 붙인다', async () => {
    const host = await makeHostPptx()
    const attach = await makeAttachDocx()
    const once = await assemblePptxEmbed(zipLoad, {
      hostBytes: host,
      attachBytes: attach,
      attachName: 'a.docx',
      attachKind: 'docx',
    })
    const twice = await assemblePptxEmbed(zipLoad, {
      hostBytes: once,
      attachBytes: attach,
      attachName: 'a.docx',
      attachKind: 'docx',
    })
    const z = await JSZip.loadAsync(twice)
    const emb = Object.keys(z.files).filter((n) => n.startsWith('ppt/embeddings/') && !z.files[n]!.dir)
    expect(emb.length).toBe(2)
    // 두 첨부 모두 원본 그대로.
    for (const n of emb) {
      expect(Buffer.from(await z.files[n]!.async('uint8array'))).toEqual(Buffer.from(attach))
    }
  })

  it('잘못된 호스트는 bad_host, 없는 슬라이드는 bad_slide', async () => {
    await expect(
      assemblePptxEmbed(zipLoad, {
        hostBytes: new Uint8Array([1, 2, 3]),
        attachBytes: await makeAttachDocx(),
        attachName: 'a.docx',
        attachKind: 'docx',
      }),
    ).rejects.toMatchObject({ code: 'bad_host' })
    await expect(
      assemblePptxEmbed(zipLoad, {
        hostBytes: await makeHostPptx(),
        attachBytes: await makeAttachDocx(),
        attachName: 'a.docx',
        attachKind: 'docx',
        slide: 9,
      }),
    ).rejects.toMatchObject({ code: 'bad_slide' })
  })
})

async function makeHostXlsx(withDrawings: boolean): Promise<Uint8Array> {
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
  if (withDrawings) {
    z.file(
      'xl/drawings/drawing1.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:sp><xdr:nvSpPr><xdr:cNvPr id="1" name="pic"/></xdr:nvSpPr></xdr:sp><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>',
    )
    z.file(
      'xl/worksheets/_rels/sheet1.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings" Target="../printerSettings/printerSettings1.bin"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>',
    )
  }
  return z.generateAsync({ type: 'uint8array' })
}

describe('assembleXlsxEmbed', () => {
  it('빈 시트에 docx를 넣는다 (3곳 일치+progId+PNG)', async () => {
    const host = await makeHostXlsx(false)
    const attach = await makeAttachDocx('ZZ xlsx attach')
    const out = await assembleXlsxEmbed(zipLoad, {
      hostBytes: host,
      attachBytes: attach,
      attachName: 'a.docx',
      attachKind: 'docx',
    })
    const z = await JSZip.loadAsync(out)
    // embeddings 원본.
    expect(Buffer.from(await z.files['xl/embeddings/a.docx']!.async('uint8array'))).toEqual(Buffer.from(attach))
    // 미리보기 PNG.
    expect(Object.keys(z.files).some((n) => n === 'xl/media/image1.png')).toBe(true)
    // sheet 3곳: drawing ref + legacyDrawing ref + oleObjects.
    const sheet = await z.files['xl/worksheets/sheet1.xml']!.async('string')
    expect(/<drawing\b[^>]*r:id="/.test(sheet)).toBe(true)
    expect(/legacyDrawing\b[^>]*r:id="/.test(sheet)).toBe(true)
    expect(sheet).toContain('<oleObjects')
    expect(sheet).toContain('progId="Word.Document.12"')
    // drawing anchor (pic: lib 네이티브 렌더) + VML shape.
    const drawing = await z.files['xl/drawings/drawing1.xml']!.async('string')
    expect(drawing.match(/<xdr:twoCellAnchor/g)?.length).toBe(1)
    expect(drawing).toContain('<xdr:pic>')
    expect(drawing).toContain('name="a"')
    expect(drawing).toContain('r:embed="rId1"')
    expect(sheet).toContain('DVASPECT_ICON')
    const drawingRels = await z.files['xl/drawings/_rels/drawing1.xml.rels']!.async('string')
    expect(drawingRels).toContain('/image')
    const vmlNames = Object.keys(z.files).filter((n) => n.endsWith('.vml'))
    expect(vmlNames.length).toBe(1)
    const vml = await z.files[vmlNames[0]!]!.async('string')
    expect(vml).toContain('<v:shape')
    expect(vml).toContain('o:relid="rId')
    // rels + content types.
    const rels = await z.files['xl/worksheets/_rels/sheet1.xml.rels']!.async('string')
    expect(rels).toContain('/oleObject')
    expect(rels).toContain('/image')
    expect(rels).toContain('/drawing')
    expect(rels).toContain('/vmlDrawing')
    const ct = await z.files['[Content_Types].xml']!.async('string')
    expect(ct).toContain('Extension="png"')
    expect(ct).toContain('xl/embeddings/a.docx')
  })

  it('그림 있는 시트에도 추가된다', async () => {
    const host = await makeHostXlsx(true)
    const attach = await makeAttachDocx()
    const out = await assembleXlsxEmbed(zipLoad, {
      hostBytes: host,
      attachBytes: attach,
      attachName: 'b.xlsx',
      attachKind: 'xlsx',
    })
    const z = await JSZip.loadAsync(out)
    expect(Buffer.from(await z.files['xl/embeddings/b.xlsx']!.async('uint8array'))).toEqual(Buffer.from(attach))
    const sheet = await z.files['xl/worksheets/sheet1.xml']!.async('string')
    expect(sheet).toContain('progId="Excel.Sheet.12"')
    const drawing = await z.files['xl/drawings/drawing1.xml']!.async('string')
    expect(drawing.match(/<xdr:twoCellAnchor/g)?.length).toBe(2)
  })

  it('oleObjects가 이미 있으면 덧붙여도 xdr 네임스페이스가 유효하다 (lib 저장본 append)', async () => {
    // lib 저장본 형태: oleObjects는 xmlns:x14만 선언, 기존 anchor의 xdr은 인라인 선언.
    const host0 = await makeHostXlsx(false)
    const z0 = await JSZip.loadAsync(host0)
    const sheet0 = await z0.files['xl/worksheets/sheet1.xml']!.async('string')
    const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    const XD = 'xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"'
    const libForm = sheet0.replace(
      '</worksheet>',
      `<oleObjects xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><oleObject progId="Word.Document.12" dvAspect="DVASPECT_ICON" shapeId="1024" r:id="rId9" ${R}><objectPr defaultSize="0" r:id="rId9"><anchor moveWithCells="1"><from><xdr:col ${XD}>0</xdr:col></from></anchor></objectPr></oleObject></oleObjects></worksheet>`,
    )
    z0.file('xl/worksheets/sheet1.xml', libForm)
    const host = await z0.generateAsync({ type: 'uint8array' })
    const out = await assembleXlsxEmbed(zipLoad, {
      hostBytes: host,
      attachBytes: await makeAttachDocx(),
      attachName: 'c.docx',
      attachKind: 'docx',
    })
    const z = await JSZip.loadAsync(out)
    const sheet = await z.files['xl/worksheets/sheet1.xml']!.async('string')
    // 새로 덧붙인 oleObject는 xdr 선언을 스스로 가진다 (호스트 선언과 무관).
    const added = sheet.match(/<oleObject[^>]*shapeId="1025"[^>]*>/)?.[0] ?? ''
    expect(added).toContain('xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"')
  })

  it('잘못된 호스트/시트는 거부된다', async () => {
    await expect(
      assembleXlsxEmbed(zipLoad, {
        hostBytes: new Uint8Array([1, 2, 3]),
        attachBytes: await makeAttachDocx(),
        attachName: 'a.docx',
        attachKind: 'docx',
      }),
    ).rejects.toMatchObject({ code: 'bad_host' })
    await expect(
      assembleXlsxEmbed(zipLoad, {
        hostBytes: await makeHostXlsx(false),
        attachBytes: await makeAttachDocx(),
        attachName: 'a.docx',
        attachKind: 'docx',
        sheet: 4,
      }),
    ).rejects.toMatchObject({ code: 'bad_sheet' })
  })
})

async function makeHostDocx(): Promise<Uint8Array> {
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
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>host</w:t></w:r></w:p></w:body></w:document>',
  )
  z.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  )
  return z.generateAsync({ type: 'uint8array' })
}

describe('assembleDocxEmbed', () => {
  it('문서 끝에 xlsx를 넣는다 (embeddings+rels+progId+PNG)', async () => {
    const host = await makeHostDocx()
    const attach = await makeAttachDocx('ZZ docx attach')
    const out = await assembleDocxEmbed(zipLoad, {
      hostBytes: host,
      attachBytes: attach,
      attachName: 's.xlsx',
      attachKind: 'xlsx',
    })
    const z = await JSZip.loadAsync(out)
    expect(Buffer.from(await z.files['word/embeddings/s.xlsx']!.async('uint8array'))).toEqual(Buffer.from(attach))
    expect(Object.keys(z.files).some((n) => n === 'word/media/image1.png')).toBe(true)
    const doc = await z.files['word/document.xml']!.async('string')
    expect(doc).toContain('<w:object')
    expect(doc).toContain('ProgID="Excel.Sheet.12"')
    expect(doc).toContain('DrawAspect="Icon"')
    expect(doc).toContain('<o:FieldCodes>\\s</o:FieldCodes>')
    const rels = await z.files['word/_rels/document.xml.rels']!.async('string')
    expect(rels).toContain('/package')
    expect(rels).toContain('/image')
    const ct = await z.files['[Content_Types].xml']!.async('string')
    expect(ct).toContain('Extension="png"')
    expect(ct).toContain('word/embeddings/s.xlsx')
  })

  it('잘못된 호스트는 거부된다', async () => {
    await expect(
      assembleDocxEmbed(zipLoad, {
        hostBytes: new Uint8Array([1, 2, 3]),
        attachBytes: await makeAttachDocx(),
        attachName: 'a.docx',
        attachKind: 'docx',
      }),
    ).rejects.toMatchObject({ code: 'bad_host' })
  })
})

/**
 * 리뷰 보완: 네임스페이스 선언 행렬.
 * lib 저장본은 루트 선언을 걷어낼 수 있다 (xlsx: 루트 xmlns:xdr 소실 확인).
 * 조립 출력물의 엘리먼트/어트리뷰트 이름 접두사는 모두 선언돼 있어야 한다
 * (DOMParser NamespaceError 방지). 형식 3종 x 입력 3종(Office 원본/관찰된 lib 저장본/서버 조립본 재투입).
 */
function undeclaredPrefixes(xml: string): string[] {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '')
  const used = new Set<string>()
  for (const m of body.matchAll(/<(\/?)([A-Za-z_][\w.-]*):/g)) used.add(m[2]!)
  for (const m of body.matchAll(/[\s{]([A-Za-z_][\w.-]*):[\w.-]+\s*=/g)) used.add(m[1]!)
  return [...used].filter((p) => p !== 'xml' && p !== 'xmlns' && !body.includes(`xmlns:${p}=`))
}

function expectPrefixesDeclared(part: string, xml: string): void {
  expect(undeclaredPrefixes(xml), `${part} undeclared`).toEqual([])
}

const RNS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const XDR_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'

/** Office 원본 형태 xlsx 호스트: 루트가 xdr 선언, oleObjects는 선언 없이 AlternateContent. */
async function makeHostXlsxOfficeAttach(): Promise<Uint8Array> {
  const z = await JSZip.loadAsync(await makeHostXlsx(false))
  const sheet = (await z.files['xl/worksheets/sheet1.xml']!.async('string'))
    .replace('<worksheet xmlns=', `<worksheet xmlns:xdr="${XDR_NS}" xmlns=`)
    .replace(
      '</worksheet>',
      `<oleObjects><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="x14"><oleObject progId="Package" dvAspect="DVASPECT_ICON" shapeId="1024" r:id="rId4" ${RNS}><objectPr defaultSize="0" r:id="rId5"><anchor moveWithCells="1"><from><xdr:col>0</xdr:col></from></anchor></objectPr></oleObject></mc:Choice><mc:Fallback><oleObject progId="Package" dvAspect="DVASPECT_ICON" shapeId="1024" r:id="rId4"/></mc:Fallback></mc:AlternateContent></oleObjects></worksheet>`,
    )
  z.file('xl/worksheets/sheet1.xml', sheet)
  return z.generateAsync({ type: 'uint8array' })
}

/** Office 원본 형태 pptx 호스트: 기존 oleObj+프레임 보유, 루트 p/a/r 선언. */
async function makeHostPptxOfficeAttach(): Promise<Uint8Array> {
  const z = await JSZip.loadAsync(await makeHostPptx())
  const slide = (await z.files['ppt/slides/slide1.xml']!.async('string')).replace(
    '</p:spTree>',
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="old"/><p:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole"><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:v="urn:schemas-microsoft-com:vml" Requires="v"><p:oleObj spid="_x0000_s1026" name="old" showAsIcon="1" r:id="rId2" imgW="100" imgH="100" progId="Package" ${RNS}><p:embed/></p:oleObj></mc:Choice><mc:Fallback><p:oleObj name="old" showAsIcon="1" r:id="rId2" imgW="100" imgH="100" progId="Package"/></mc:Fallback></mc:AlternateContent></a:graphicData></a:graphic></p:graphicFrame></p:spTree>`,
  )
  z.file('ppt/slides/slide1.xml', slide)
  const rels = await z.files['ppt/slides/_rels/slide1.xml.rels']!.async('string')
  z.file(
    'ppt/slides/_rels/slide1.xml.rels',
    rels.replace(
      '</Relationships>',
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="../embeddings/old.pdf"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/old.png"/></Relationships>',
    ),
  )
  z.file('ppt/embeddings/old.pdf', new Uint8Array([37, 80, 68, 70]))
  z.file('ppt/media/old.png', genericIconPng())
  return z.generateAsync({ type: 'uint8array' })
}

/** Office 원본 형태 docx 호스트: 기존 w:object 보유, 루트 w/r/o 선언. */
async function makeHostDocxOfficeAttach(): Promise<Uint8Array> {
  const z = await JSZip.loadAsync(await makeHostDocx())
  const VO = 'xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"'
  const doc = (await z.files['word/document.xml']!.async('string'))
    .replace('<w:document xmlns:w=', `<w:document ${RNS} ${VO} xmlns:w=`)
    .replace(
      '</w:body>',
      `<w:p><w:r><w:object><v:shape id="_x0000_i1025" type="#_x0000_t75" ${VO} o:ole=""><v:imagedata r:id="rId2" o:title="" ${RNS}/></v:shape><o:OLEObject Type="Embed" ProgID="Package" ShapeID="_x0000_i1025" DrawAspect="Icon" ObjectID="1" r:id="rId3" ${VO} ${RNS}></o:OLEObject></w:object></w:r></w:p></w:body>`,
    )
  z.file('word/document.xml', doc)
  return z.generateAsync({ type: 'uint8array' })
}

describe('assemble prefix matrix (office/lib/refeed)', () => {
  it('xlsx office 원본 + lib 저장본 + 재투입: sheet/drawing/vml 선언 유효', async () => {
    const attach = await makeAttachDocx()
    // 1) Office 원본 형태 (루트 xdr 선언).
    const office = await makeHostXlsxOfficeAttach()
    const out1 = await assembleXlsxEmbed(zipLoad, { hostBytes: office, attachBytes: attach, attachName: 'a.docx', attachKind: 'docx' })
    const z1 = await JSZip.loadAsync(out1)
    const sheet1 = await z1.files['xl/worksheets/sheet1.xml']!.async('string')
    expectPrefixesDeclared('xlsx-office sheet', sheet1)
    // Office 원본은 x14를 Requires 값으로만 참조한다 (이름 선언 없음 — 실물과 동일).
    for (const p of ['mc', 'r', 'xdr']) expect(sheet1).toContain(`xmlns:${p}=`)
    // 2) 관찰된 lib 저장본 형태 (루트 xdr 소실, xmlns:x14만).
    const lib0 = await makeHostXlsx(false)
    const lz = await JSZip.loadAsync(lib0)
    const XD = `xmlns:xdr="${XDR_NS}"`
    const libSheet = (await lz.files['xl/worksheets/sheet1.xml']!.async('string')).replace(
      '</worksheet>',
      `<oleObjects xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="x14"><oleObject progId="Package" dvAspect="DVASPECT_ICON" shapeId="1024" r:id="rId4" ${RNS}><objectPr defaultSize="0" r:id="rId5"><anchor moveWithCells="1"><from><xdr:col ${XD}>0</xdr:col></from></anchor></objectPr></oleObject></mc:Choice><mc:Fallback><oleObject progId="Package" dvAspect="DVASPECT_ICON" shapeId="1024" r:id="rId4"/></mc:Fallback></mc:AlternateContent></oleObjects></worksheet>`,
    )
    lz.file('xl/worksheets/sheet1.xml', libSheet)
    const out2 = await assembleXlsxEmbed(zipLoad, { hostBytes: await lz.generateAsync({ type: 'uint8array' }), attachBytes: attach, attachName: 'b.docx', attachKind: 'docx' })
    const z2 = await JSZip.loadAsync(out2)
    const sheet2 = await z2.files['xl/worksheets/sheet1.xml']!.async('string')
    expectPrefixesDeclared('xlsx-lib sheet', sheet2)
    for (const p of ['mc', 'r', 'xdr', 'x14']) expect(sheet2).toContain(`xmlns:${p}=`)
    // 3) 서버 조립본 재투입 (2회차 첨부).
    const out3 = await assembleXlsxEmbed(zipLoad, { hostBytes: out1, attachBytes: attach, attachName: 'c.docx', attachKind: 'docx' })
    const z3 = await JSZip.loadAsync(out3)
    for (const [label, files] of [['xlsx-refeed', z3]] as const) {
      const sheet = await files.files['xl/worksheets/sheet1.xml']!.async('string')
      expectPrefixesDeclared(`${label} sheet`, sheet)
      const drawing = await files.files['xl/drawings/drawing1.xml']!.async('string')
      expectPrefixesDeclared(`${label} drawing`, drawing)
      const vmlName = Object.keys(files.files).find((n) => n.endsWith('.vml'))
      expect(vmlName, 'vml exists').toBeTruthy()
      expectPrefixesDeclared(`${label} vml`, await files.files[vmlName!]!.async('string'))
    }
    // drawing/vml도 1·2회차 모두 유효.
    for (const [label, files] of [['xlsx-office', z1], ['xlsx-lib', z2]] as const) {
      expectPrefixesDeclared(`${label} drawing`, await files.files['xl/drawings/drawing1.xml']!.async('string'))
      const vmlName = Object.keys(files.files).find((n) => n.endsWith('.vml'))
      expectPrefixesDeclared(`${label} vml`, await files.files[vmlName!]!.async('string'))
    }
    // v/o는 VML에서 선언.
    const vml = await z3.files[Object.keys(z3.files).find((n) => n.endsWith('.vml'))!]!.async('string')
    for (const p of ['v', 'o']) expect(vml).toContain(`xmlns:${p}=`)
  })

  it('pptx office 원본 + 재투입: slide 선언 유효', async () => {
    const attach = await makeAttachDocx()
    const office = await makeHostPptxOfficeAttach()
    const out1 = await assemblePptxEmbed(zipLoad, { hostBytes: office, attachBytes: attach, attachName: 'a.docx', attachKind: 'docx', slide: 1 })
    const z1 = await JSZip.loadAsync(out1)
    const slide1 = await z1.files['ppt/slides/slide1.xml']!.async('string')
    expectPrefixesDeclared('pptx-office slide', slide1)
    for (const p of ['p', 'a', 'r', 'mc', 'v']) expect(slide1).toContain(`xmlns:${p}=`)
    const out2 = await assemblePptxEmbed(zipLoad, { hostBytes: out1, attachBytes: attach, attachName: 'b.docx', attachKind: 'docx', slide: 1 })
    const slide2 = await (await JSZip.loadAsync(out2)).files['ppt/slides/slide1.xml']!.async('string')
    expectPrefixesDeclared('pptx-refeed slide', slide2)
  })

  it('docx office 원본 + 재투입: document 선언 유효', async () => {
    const attach = await makeAttachDocx()
    const office = await makeHostDocxOfficeAttach()
    const out1 = await assembleDocxEmbed(zipLoad, { hostBytes: office, attachBytes: attach, attachName: 'a.xlsx', attachKind: 'xlsx' })
    const z1 = await JSZip.loadAsync(out1)
    const doc1 = await z1.files['word/document.xml']!.async('string')
    expectPrefixesDeclared('docx-office document', doc1)
    for (const p of ['w', 'r', 'v', 'o']) expect(doc1).toContain(`xmlns:${p}=`)
    const out2 = await assembleDocxEmbed(zipLoad, { hostBytes: out1, attachBytes: attach, attachName: 'b.xlsx', attachKind: 'xlsx' })
    const doc2 = await (await JSZip.loadAsync(out2)).files['word/document.xml']!.async('string')
    expectPrefixesDeclared('docx-refeed document', doc2)
  })
})
