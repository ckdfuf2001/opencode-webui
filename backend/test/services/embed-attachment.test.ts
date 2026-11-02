import { describe, expect, it, beforeEach } from 'vitest'
import JSZip from 'jszip'
import {
  acquireEmbedLock,
  clearEmbedLocksForTest,
  getEmbedLock,
  releaseEmbedLock,
  sanitizeHolderName,
  EMBED_LOCK_TTL_MS,
} from '../../src/services/embed-locks'
import {
  normalizeEmbedPart,
  readEmbedPart,
  replaceEmbedPart,
  resolveRelTarget,
  listEmbedParts,
  type ZipLike,
} from '../../src/services/office-embed'

const zipLoad = async (b: Uint8Array): Promise<ZipLike> => {
  const z = await JSZip.loadAsync(b)
  return z as unknown as ZipLike
}

function expectEmbedError(fn: () => unknown, code: string, status?: number): void {
  try {
    fn()
  } catch (e) {
    expect(e).toMatchObject({ code })
    if (status !== undefined) expect((e as { statusCode?: number }).statusCode).toBe(status)
    return
  }
  throw new Error(`expected throw ${code}`)
}

async function expectEmbedErrorAsync(fn: () => Promise<unknown>, code: string, status?: number): Promise<void> {
  try {
    await fn()
  } catch (e) {
    expect(e).toMatchObject({ code })
    if (status !== undefined) expect((e as { statusCode?: number }).statusCode).toBe(status)
    return
  }
  throw new Error(`expected throw ${code}`)
}

/** 최소 xlsx 호스트: 시트 rels에 package 임베딩 1개. */
async function makeHostXlsxWithPackage(partName = 'report.docx', partBytes?: Uint8Array): Promise<Uint8Array> {
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
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</is></c></row></sheetData></worksheet>',
  )
  z.file(
    'xl/worksheets/_rels/sheet1.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/${partName}"/></Relationships>`,
  )
  z.file(`xl/embeddings/${partName}`, partBytes ?? new Uint8Array([1, 2, 3, 4]))
  return z.generateAsync({ type: 'uint8array' })
}

describe('normalizeEmbedPart', () => {
  it('정상 경로는 그대로 둔다', () => {
    expect(normalizeEmbedPart('xl/embeddings/a.docx')).toBe('xl/embeddings/a.docx')
    expect(normalizeEmbedPart('ppt/embeddings/a-2.docx')).toBe('ppt/embeddings/a-2.docx')
  })
  it('역참조·절대경로·빈 조각을 거부한다', () => {
    expectEmbedError(() => normalizeEmbedPart('../evil.docx'), 'bad_part', 400)
    expectEmbedError(() => normalizeEmbedPart('xl/embeddings/../../evil.docx'), 'bad_part', 400)
    expectEmbedError(() => normalizeEmbedPart('/xl/embeddings/a.docx'), 'bad_part', 400)
    expectEmbedError(() => normalizeEmbedPart('xl//embeddings/a.docx'), 'bad_part', 400)
    expectEmbedError(() => normalizeEmbedPart(''), 'bad_part', 400)
    expectEmbedError(() => normalizeEmbedPart('xl\\embeddings\\..\\evil.docx'), 'bad_part', 400)
  })
})

describe('resolveRelTarget', () => {
  it('상대 Target을 rels 기준으로 푼다', () => {
    expect(resolveRelTarget('xl/worksheets/_rels/sheet1.xml.rels', '../embeddings/a.docx')).toBe(
      'xl/embeddings/a.docx',
    )
    expect(resolveRelTarget('ppt/slides/_rels/slide1.xml.rels', '../embeddings/b.pptx')).toBe(
      'ppt/embeddings/b.pptx',
    )
  })
  it('루트 탈출·이상 Target은 거부한다', () => {
    expect(resolveRelTarget('xl/worksheets/_rels/sheet1.xml.rels', '../../../../evil.docx')).toBe(null)
    expect(resolveRelTarget('xl/worksheets/_rels/sheet1.xml.rels', '..\\evil.docx')).toBe(null)
    expect(resolveRelTarget('no-rels-here', '../embeddings/a.docx')).toBe(null)
  })
})

describe('listEmbedParts', () => {
  it('rels 기준 임베딩 목록을 중복 없이 모은다', async () => {
    const host = await makeHostXlsxWithPackage()
    const parts = await listEmbedParts(zipLoad, host)
    expect(parts).toEqual([
      { part: 'xl/embeddings/report.docx', relType: 'package', target: '../embeddings/report.docx' },
    ])
  })
  it('깨진 zip은 bad_host', async () => {
    await expectEmbedErrorAsync(() => listEmbedParts(zipLoad, new Uint8Array([1, 2, 3])), 'bad_host', 400)
  })
})

describe('readEmbedPart / replaceEmbedPart', () => {
  it('읽기는 바이트와 이름을 돌려준다', async () => {
    const host = await makeHostXlsxWithPackage('report.docx', new Uint8Array([9, 9, 9]))
    const r = await readEmbedPart(zipLoad, host, 'xl/embeddings/report.docx')
    expect(r.name).toBe('report.docx')
    expect(r.relType).toBe('package')
    expect(Buffer.from(r.bytes)).toEqual(Buffer.from([9, 9, 9]))
  })
  it('없는 파트는 bad_part(404)', async () => {
    const host = await makeHostXlsxWithPackage()
    await expectEmbedErrorAsync(() => readEmbedPart(zipLoad, host, 'xl/embeddings/nope.docx'), 'bad_part', 404)
    await expectEmbedErrorAsync(() => replaceEmbedPart(zipLoad, host, 'xl/embeddings/nope.docx', new Uint8Array([1])), 'bad_part', 404)
  })
  it('교체는 해당 파트만 바꾸고 나머지는 바이트 동일', async () => {
    const host = await makeHostXlsxWithPackage('report.docx', new Uint8Array([1, 1, 1]))
    const next = new Uint8Array([7, 7, 7, 7])
    const out = await replaceEmbedPart(zipLoad, host, 'xl/embeddings/report.docx', next)
    const z0 = await JSZip.loadAsync(host)
    const z1 = await JSZip.loadAsync(out)
    expect(Object.keys(z1.files).sort()).toEqual(Object.keys(z0.files).sort())
    for (const n of Object.keys(z1.files)) {
      const b0 = Buffer.from(await z0.files[n]!.async('uint8array'))
      const b1 = Buffer.from(await z1.files[n]!.async('uint8array'))
      if (n === 'xl/embeddings/report.docx') {
        expect(b1.equals(Buffer.from(next))).toBe(true)
        expect(b1.equals(b0)).toBe(false)
      } else {
        expect(b1.equals(b0), `${n} unchanged`).toBe(true)
      }
    }
  })
  it('역참조 교체는 400 bad_part', async () => {
    const host = await makeHostXlsxWithPackage()
    await expectEmbedErrorAsync(
      () => replaceEmbedPart(zipLoad, host, '../evil.docx', new Uint8Array([1])),
      'bad_part',
      400,
    )
  })
})

describe('embed locks', () => {
  beforeEach(() => {
    clearEmbedLocksForTest()
  })

  it('acquire → renew(같은 token) → release', () => {
    const a = acquireEmbedLock('/r/a.xlsx', 'xl/embeddings/r.docx', 'Ada', 'tok-a')
    expect(a.ok).toBe(true)
    if (!a.ok) throw new Error('unreachable')
    const firstId = a.lockId
    const r = acquireEmbedLock('/r/a.xlsx', 'xl/embeddings/r.docx', 'Ada', 'tok-a', { lockId: firstId })
    expect(r).toMatchObject({ ok: true, lockId: firstId, renewed: true })
    expect(releaseEmbedLock('/r/a.xlsx', 'xl/embeddings/r.docx', firstId, 'tok-a')).toEqual({ ok: true })
    expect(getEmbedLock('/r/a.xlsx', 'xl/embeddings/r.docx')).toBe(null)
  })

  it('다른 holder는 locked + holderName', () => {
    const a = acquireEmbedLock('/r/a.xlsx', 'xl/embeddings/r.docx', 'Ada', 'tok-a')
    expect(a.ok).toBe(true)
    const b = acquireEmbedLock('/r/a.xlsx', 'xl/embeddings/r.docx', 'Grace', 'tok-b')
    expect(b).toMatchObject({ ok: false, code: 'locked', holderName: 'Ada' })
  })

  it('lockId가 다르면 해제 불가', () => {
    const a = acquireEmbedLock('/r/a.xlsx', 'xl/embeddings/r.docx', 'Ada', 'tok-a')
    expect(a.ok).toBe(true)
    if (!a.ok) throw new Error('unreachable')
    expect(releaseEmbedLock('/r/a.xlsx', 'xl/embeddings/r.docx', 'wrong-id', 'tok-a')).toEqual({
      ok: false,
      code: 'not_holder',
    })
    expect(releaseEmbedLock('/r/a.xlsx', 'xl/embeddings/r.docx', a.lockId, 'tok-other')).toEqual({
      ok: false,
      code: 'not_holder',
    })
    expect(getEmbedLock('/r/a.xlsx', 'xl/embeddings/r.docx')).not.toBe(null)
  })

  it('만료된 락은 자동 해제되고 재취득된다', () => {
    const a = acquireEmbedLock('/r/a.xlsx', 'xl/embeddings/r.docx', 'Ada', 'tok-a', { ttlMs: 1, now: 1000 })
    expect(a.ok).toBe(true)
    const b = acquireEmbedLock('/r/a.xlsx', 'xl/embeddings/r.docx', 'Grace', 'tok-b', { now: 1000 + EMBED_LOCK_TTL_MS + 1 })
    expect(b.ok).toBe(true)
    if (!b.ok) throw new Error('unreachable')
    expect(b.renewed).toBe(false)
  })

  it('holder 이름은 살균된다', () => {
    expect(sanitizeHolderName('  Ada  ')).toBe('Ada')
    expect(sanitizeHolderName('')).toBe('user')
    expect(sanitizeHolderName('x'.repeat(200))).toHaveLength(40)
  })
})
