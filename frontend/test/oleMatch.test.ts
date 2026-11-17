import { describe, it, expect } from 'vitest'
import { normName, frameFileNames, entryNameHit, textContainsName, progIdOfText, extOf, OLE_PROG_EXT } from '../src/lib/oleMatch'

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

  it('부분 문자열 포함만으로는 매칭되지 않는다 (report vs report-final)', () => {
    const report = { displayName: 'report.docx', fallbackName: 'report.docx' }
    const reportFinal = { displayName: 'report-final.docx', fallbackName: 'report-final.docx' }
    // 후보가 항목 줄기를 포함해도 다른 파일이면 안 된다 (가로채기 방지).
    expect(entryNameHit('report-final.docx', report)).toBe(false)
    // 반대 방향(항목이 후보 줄기를 포함)은 약어 허용을 위해 true일 수 있으나,
    // 오버레이의 exact-first + claimed-set이 가로채기를 막는다 (정확 일치가 먼저 점유).
    expect(entryNameHit('report.docx', reportFinal)).toBe(true)
    // 정확한 건 여전히 된다.
    expect(entryNameHit('report.docx', report)).toBe(true)
    expect(entryNameHit('report-final.docx', reportFinal)).toBe(true)
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

  it('lib 전체 텍스트에 파일명이 그대로 있으면 매칭된다 (WORD 접두사 등)', () => {
    const icf = { displayName: 'Icf.docx', fallbackName: 'Icf.docx' }
    expect(textContainsName('WORDIcf.docx (348.8 KB)Download', icf)).toBe(true)
    expect(textContainsName('Icf.docx (348.8 KB)Download', icf)).toBe(true)
    // 다른 파일의 부분 문자열만으로는 안 된다 (확장자까지 온전해야 함).
    const report = { displayName: 'report.docx', fallbackName: 'report.docx' }
    expect(textContainsName('report-final.docx (10 KB)Download', report)).toBe(false)
    expect(textContainsName('my report.docx final version', report)).toBe(true)
  })

  it('lib이 짧은 자동 이름으로 렌더해도 파일명 전체가 한쪽에 들어있으면 매칭된다', () => {
    // C7m red: lib 프레임 "WORDDocument.docx" vs part "Microsoft_Word_Document.docx".
    expect(textContainsName('WORDDocument.docx (35.7 KB)Download', docxPkg)).toBe(true)
  })

  it('양방향 포함이라도 확장자까지 온전하지 않으면 매칭되지 않는다', () => {
    const report = { displayName: 'report.docx', fallbackName: 'report.docx' }
    const reportFinal = { displayName: 'report-final.docx', fallbackName: 'report-final.docx' }
    // 어느 쪽도 다른 쪽 파일명 전체(확장자 포함)를 포함하지 않는다.
    expect(textContainsName('report.docx (10 KB)Download', reportFinal)).toBe(false)
    expect(textContainsName('report-final.docx (10 KB)Download', report)).toBe(false)
  })
})
