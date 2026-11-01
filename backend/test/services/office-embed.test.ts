import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import {
  assemblePptxEmbed,
  attachKindOf,
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
