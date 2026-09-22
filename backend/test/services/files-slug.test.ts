import { describe, it, expect } from 'vitest'
import { slugUploadName } from '../../src/services/files'

describe('slugUploadName (T15)', () => {
  it('normalizes spaces and parens', () => {
    expect(slugUploadName('image (4).png')).toBe('image_4.png')
    expect(slugUploadName('my doc final.PDF')).toBe('my_doc_final.pdf')
  })
  it('keeps korean filenames', () => {
    expect(slugUploadName('보고서 초안.docx')).toBe('보고서_초안.docx')
  })
  it('leaves clean names alone', () => {
    expect(slugUploadName('a-b_c.ts')).toBe('a-b_c.ts')
  })
  it('falls back to file for empty base', () => {
    expect(slugUploadName('...')).toBe('file')
    // 선행 점은 확장자로 보지 않는다(path.extname 규칙) — basename 정리 결과
    expect(slugUploadName('.png')).toBe('png')
  })
})
