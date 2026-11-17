import type { OleEmbeddingRef } from './oleAttachments'

/**
 * lib가 렌더한 OLE 도형과 임베딩 항목 매칭 (순수 함수).
 * - PPTX ole 프레임 / DOCX ole placeholder 안에 표시되는 파일명으로 항목을 찾는다.
 * - lib 렌더명은 원본과 철자가 다를 수 있어 (WORDDocument.docx vs
 *   Microsoft_Word_Document.docx) 정규화(소문자+영숫자) 후 부분일치로 판정한다.
 * - CFB 등 파일명이 없는 자리 표시자는 여기서 못 찾는다 (위치 폴백이 담당).
 */

function stemOf(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,8}$/, '')
}

/** 비교용 정규화 (소문자+영숫자만 — 공백·구분자 차이 무시). */
export function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** 텍스트에서 임베딩 파일명 후보를 뽑는다 (lib 렌더 라벨/푸터용). */
export function frameFileNames(text: string): string[] {
  const out: string[] = []
  const re = /[\w\-.~ ]+\.(docx|xlsx|pptx|ppt|pdf|bin)\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push(m[0].trim().toLowerCase())
  return out
}

/** 후보 파일명이 이 항목의 표시명/대체명과 같은 문서인지 (어느 쪽이든 포함). */
export function entryNameHit(candidateFile: string, entry: Pick<OleEmbeddingRef, 'displayName' | 'fallbackName'>, exact = false): boolean {
  const raws = [entry.displayName, entry.fallbackName].filter((s): s is string => !!s)
  const f = normName(candidateFile)
  const fs = normName(stemOf(candidateFile))
  if (!f) return false
  return raws.some((raw) => {
    const n = normName(raw)
    if (!n) return false
    if (n === f) return true
    if (exact) return false
    return fs.length >= 4 && n.includes(fs)
  })
}

/**
 * lib 텍스트 전체에 항목 파일명(확장자 포함)이 그대로 들어있는지.
 * ("WORDIcf.docx (348.8 KB)Download" 안에 "Icf.docx"가 있는 경우.
 * report/report-final처럼 다른 파일은 확장자까지 일치해야 하므로 걸러진다.)
 * C7m: lib이 progId식 짧은 자동 이름(WORDDocument.docx)으로 렌더하고
 * part는 전체 이름(Microsoft_Word_Document.docx)인 경우도 같은 문서로 본다.
 * 어느 한쪽이 다른 쪽 파일명 전체(확장자 포함)를 포함하면 매칭한다.
 * (report.docx vs report-final.docx는 어느 쪽도 상대 전체를 포함하지 않아 제외.)
 */
export function textContainsName(haystack: string, entry: Pick<OleEmbeddingRef, 'displayName' | 'fallbackName'>): boolean {
  const hay = normName(haystack)
  if (!hay) return false
  const cands = frameFileNames(haystack).map((c) => normName(c)).filter((c) => c.length >= 8)
  const raws = [entry.displayName, entry.fallbackName].filter((s): s is string => !!s)
  return raws.some((raw) => {
    const n = normName(raw)
    if (!n) return false
    if (hay.includes(n)) return true
    if (n.length < 8) return false
    return cands.some((c) => n.includes(c) || c.includes(n))
  })
}

/** progId → 확장자 (dve-ole-placeholder 매칭용). */
export const OLE_PROG_EXT: Record<string, string> = {
  'word.document.12': 'docx',
  'excel.sheet.12': 'xlsx',
  'powerpoint.show.12': 'pptx',
  'powerpoint.slide.12': 'pptx',
}

export function progIdOfText(text: string): string {
  const m = /([A-Za-z]+\.[A-Za-z]+\.\d+|Package)/.exec(text)
  return (m?.[1] ?? '').toLowerCase()
}

export function extOf(name: string | undefined): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name ?? '')
  return (m?.[1] ?? '').toLowerCase()
}
