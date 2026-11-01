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
