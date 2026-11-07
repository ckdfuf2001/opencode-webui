import { describe, it, expect } from 'vitest'
import { normName, frameFileNames, entryNameHit, progIdOfText, extOf, OLE_PROG_EXT } from '../src/lib/oleMatch'

/**
 * lib 렌더 OLE 도형 ↔ 임베딩 항목 매칭 (순수).
 * - C6d: 여러 임베딩이 있을 때 첫 도형에 꽂히는 게 아니라 파일명으로 항목을 가린다.
 */
describe('oleMatch', () => {
  const docxPkg = { displayName: 'Microsoft_Word_Document.docx', fallbackName: 'oleObject1.bin' }
  const inserted = { displayName: 'embed-docx.docx', fallbackName: 'embed-docx.docx' }

  it('정확한 파일명이면 매칭된다', () => {
    expect(entryNameHit('embed-docx.docx', inserted)).toBe(true)
  })

  it('lib 렌더명이 달라도 줄기가 겹치면 매칭된다 (WORDDocument.docx vs Microsoft_...)', () => {
    expect(entryNameHit('WORDDocument.docx', docxPkg)).toBe(true)
    expect(entryNameHit('Document.docx', docxPkg)).toBe(true)
  })

  it('다른 파일이면 매칭되지 않는다', () => {
    expect(entryNameHit('payload.pdf', inserted)).toBe(false)
    expect(entryNameHit('report.xlsx', docxPkg)).toBe(false)
    expect(entryNameHit('', inserted)).toBe(false)
  })

  it('프레임 텍스트에서 파일명 후보를 뽑는다', () => {
    expect(frameFileNames('WORDDocument.docx (35.7 KB)Download')).toContain('worddocument.docx')
    expect(frameFileNames('OLEpayload.pdf (591 bytes)DownloadOpen')).toContain('olepayload.pdf')
    expect(frameFileNames('그냥 텍스트')).toEqual([])
  })

  it('progId에서 확장자를 읽는다', () => {
    expect(OLE_PROG_EXT[progIdOfText('Word.Document.12')]).toBe('docx')
    expect(OLE_PROG_EXT[progIdOfText('Excel.Sheet.12')]).toBe('xlsx')
    expect(progIdOfText('그냥 텍스트')).toBe('')
  })

  it('normName은 구분자를 무시한다', () => {
    expect(normName('Microsoft_Word_Document.docx')).toBe('microsoftworddocumentdocx')
    expect(extOf('a.XLSX')).toBe('xlsx')
    expect(extOf(undefined)).toBe('')
  })
})
