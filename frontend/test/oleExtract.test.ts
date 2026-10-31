import { describe, expect, it } from 'vitest'
import {
  extractOleAttachment,
  sanitizeOleFileName,
  OleExtractError,
} from '../src/lib/oleExtract'

/** 실물 embed-pdf.xlsx 안 xl/embeddings/oleObject1.bin 전체 (CFB, 3584B). */
const BIN_B64 = '0M8R4KGxGuEAAAAAAAAAAAAAAAAAAAAAPgADAP7/CQAGAAAAAAAAAAAAAAABAAAAAQAAAAAAAAAAEAAAAgAAAAEAAAD+////AAAAAAAAAAD////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////9/////v////7///8EAAAABQAAAP7//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////1IAbwBvAHQAIABFAG4AdAByAHkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWAAUA//////////8BAAAADAADAAAAAADAAAAAAAAARgAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAEAFAAAAAAAAAQBDAG8AbQBwAE8AYgBqAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABIAAgH/////AgAAAP////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATAAAAAAAAAABAE8AbABlADEAMABOAGEAdABpAHYAZQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGgACAP///////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAACnBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAP7///8DAAAABAAAAAUAAAAGAAAABwAAAAgAAAAJAAAACgAAAAsAAAAMAAAADQAAAA4AAAAPAAAAEAAAABEAAAASAAAAEwAAABQAAAD+//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8BAP7/AwoAAP////8MAAMAAAAAAMAAAAAAAABGDAAAAE9MRSBQYWNrYWdlAAAAAAAIAAAAUGFja2FnZQD0ObJxAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKMEAAACAHBheWxvYWQucGRmAEM6XFVzZXJzXG9oXEFwcERhdGFcTG9jYWxcVGVtcFxvcGVuY29kZVxjNS1vbGVccGF5bG9hZC5wZGYAAAADAHkAAABDOlxVc2Vyc1xvaFxBcHBEYXRhXExvY2FsXFRlbXBcezA0MjUzMjRBLUM5RTMtNDc1RC1CNzQ1LUVEMzI2OTFFQkQzNn1ce0E3NjgwOTM5LUVENUUtNDQ0NC1CQTMwLTUyNjdFMzk1RDExQn1ccGF5bG9hZC5wZGYATwIAACVQREYtMS40CjEgMCBvYmoKPDwgL1R5cGUgL0NhdGFsb2cgL1BhZ2VzIDIgMCBSID4+CmVuZG9iagoyIDAgb2JqCjw8IC9UeXBlIC9QYWdlcyAvS2lkcyBbMyAwIFJdIC9Db3VudCAxID4+CmVuZG9iagozIDAgb2JqCjw8IC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL01lZGlhQm94IFswIDAgMzAwIDE0NF0gL0NvbnRlbnRzIDQgMCBSIC9SZXNvdXJjZXMgPDwgL0ZvbnQgPDwgL0YxIDUgMCBSID4+ID4+ID4+CmVuZG9iago0IDAgb2JqCjw8IC9MZW5ndGggNDcgPj4Kc3RyZWFtCkJUIC9GMSAxOCBUZiA1MCAxMDAgVGQgKEM1LTAgcGF5bG9hZCBQREYpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzM4IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDA4CiUlRU9GCngAAABDADoAXABVAHMAZQByAHMAXABvAGgAXABBAHAAcABEAGEAdABhAFwATABvAGMAYQBsAFwAVABlAG0AcABcAHsAMAA0ADIANQAzADIANABBAC0AQwA5AEUAMwAtADQANwA1AEQALQBCADcANAA1AC0ARQBEADMAMgA2ADkAMQBFAEIARAAzADYAfQBcAHsAQQA3ADYAOAAwADkAMwA5AC0ARQBEADUARQAtADQANAA0ADQALQBCAEEAMwAwAC0ANQAyADYANwBFADMAOQA1AEQAMQAxAEIAfQBcAHAAYQB5AGwAbwBhAGQALgBwAGQAZgALAAAAcABhAHkAbABvAGEAZAAuAHAAZABmADoAAABDADoAXABVAHMAZQByAHMAXABvAGgAXABBAHAAcABEAGEAdABhAFwATABvAGMAYQBsAFwAVABlAG0AcABcAG8AcABlAG4AYwBvAGQAZQBcAGMANQAtAG8AbABlAFwAcABhAHkAbABvAGEAZAAuAHAAZABmAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

const binBytes = (): Uint8Array => {
  const bin = Buffer.from(BIN_B64, 'base64')
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.length)
}

describe('sanitizeOleFileName', () => {
  it('경로를 떼고 파일명만 남긴다', () => {
    expect(sanitizeOleFileName('C:\\Users\\oh\\payload.pdf', 'f.bin')).toBe('payload.pdf')
    expect(sanitizeOleFileName('../../evil.exe', 'f.bin')).toBe('evil.exe')
    expect(sanitizeOleFileName('/tmp/x/y.docx', 'f.bin')).toBe('y.docx')
  })
  it('위험 문자를 제거하고 빈 이름은 fallback을 쓴다', () => {
    expect(sanitizeOleFileName('a<b>:c?.pdf', 'f.bin')).toBe('abc.pdf')
    expect(sanitizeOleFileName('', 'fallback.bin')).toBe('fallback.bin')
    expect(sanitizeOleFileName('...', 'fallback.bin')).toBe('fallback.bin')
  })
})

describe('extractOleAttachment', () => {
  it('정상 CFB에서 원본 파일명과 바이트를 꺼낸다', () => {
    const out = extractOleAttachment(binBytes(), 'oleObject', 'fallback.bin')
    expect(out.fileName).toBe('payload.pdf')
    expect(out.mimeType).toBe('application/octet-stream')
    expect(out.bytes.length).toBe(591)
    expect(out.bytes[0]).toBe(0x25) // %
    expect(out.bytes[1]).toBe(0x50) // P
  })
  it('package는 파트 그대로 내려준다', () => {
    const raw = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])
    const out = extractOleAttachment(raw, 'package', 'Microsoft_Word_Document.docx')
    expect(out.fileName).toBe('Microsoft_Word_Document.docx')
    expect(out.bytes).toEqual(raw)
  })
  it('CFB가 아니면 거부한다', () => {
    expect(() => extractOleAttachment(new Uint8Array([1, 2, 3, 4]), 'oleObject', 'f.bin')).toThrowError(OleExtractError)
  })
  it('잘린 CFB는 거부한다', () => {
    const cut = binBytes().slice(0, 1000)
    expect(() => extractOleAttachment(cut, 'oleObject', 'f.bin')).toThrowError(OleExtractError)
  })
  it('거짓말하는 크기 필드는 거부한다', () => {
    // Ole10Native의 dataLen DWORD(%PDF-1.4 바로 앞 4B)를 실제보다 크게 패치한다.
    const mut = binBytes()
    const tag = [0x25, 0x50, 0x44, 0x46] // %PDF
    let idx = -1
    outer: for (let i = 0; i + 4 <= mut.length; i++) {
      for (let k = 0; k < 4; k++) if (mut[i + k] !== tag[k]) continue outer
      idx = i
      break
    }
    expect(idx, 'pdf magic found').toBeGreaterThan(4)
    mut[idx - 4] = 0xff
    mut[idx - 3] = 0xff
    mut[idx - 2] = 0xff
    mut[idx - 1] = 0x0f
    expect(() => extractOleAttachment(mut, 'oleObject', 'f.bin')).toThrowError(/bad_size/)
  })
})
