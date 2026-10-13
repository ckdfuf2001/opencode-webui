import JSZip from 'jszip'

/**
 * 편집용 살균: 뷰어 저장 패치가 거부하는 인라인 OOXML을 렌더링 동등하게 정리한다.
 * - w:proofErr (맞춤법 잔재) 제거
 * - w:lastRenderedPageBreak (인쇄 잔재) 제거
 * - run 안의 mc:AlternateContent → Choice 내용물로 교체 (Fallback VML 제거)
 * - drawing/pict + 텍스트 혼합 run → 분리
 * 보기 모드는 원본 그대로 쓴다. 저장 실패
 * ("Cannot edit paragraph ... cannot safely relocate") 방지용.
 */

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

const EDITABLE_PARTS = [/^word\/document\.xml$/, /^word\/header\d*\.xml$/, /^word\/footer\d*\.xml$/]

function elChildren(el: Element): Element[] {
  return Array.from(el.childNodes).filter(
    (n): n is Element => n.nodeType === 1,
  ) as Element[]
}

function sanitizeDocument(doc: XMLDocument): number {
  let changed = 0
  const all = (tag: string): Element[] => Array.from(doc.getElementsByTagNameNS(W_NS, tag))

  // 1) 맞춤법·인쇄 잔재 제거.
  for (const tag of ['proofErr', 'lastRenderedPageBreak']) {
    for (const el of all(tag)) {
      el.parentNode?.removeChild(el)
      changed++
    }
  }

  // 2) run 안의 AlternateContent → Choice 내용물로 교체.
  const runs = all('r')
  for (const run of runs) {
    const ac = elChildren(run).find((e) => e.namespaceURI === MC_NS && e.localName === 'AlternateContent')
    if (!ac) continue
    const choice = elChildren(ac).find(
      (e) => e.namespaceURI === MC_NS && e.localName === 'Choice',
    )
    if (!choice) continue
    for (const kid of elChildren(choice)) {
      run.insertBefore(kid, ac)
    }
    run.removeChild(ac)
    changed++
  }

  // 3) drawing/pict + 텍스트 혼합 run 분리 (rPr 복제).
  for (const run of all('r')) {
    const kids = elChildren(run).filter((e) => e.localName !== 'rPr' || e.namespaceURI !== W_NS)
    const hasGraphic = kids.some(
      (e) => e.namespaceURI === W_NS && (e.localName === 'drawing' || e.localName === 'pict'),
    )
    const hasOther = kids.some(
      (e) => !(e.namespaceURI === W_NS && (e.localName === 'drawing' || e.localName === 'pict')),
    )
    if (!hasGraphic || !hasOther) continue
    const rPr = elChildren(run).find((e) => e.namespaceURI === W_NS && e.localName === 'rPr')
    const parent = run.parentNode
    if (!parent) continue
    let cur: Element | null = null
    let curGraphic: boolean | null = null
    for (const kid of kids) {
      const g =
        kid.namespaceURI === W_NS && (kid.localName === 'drawing' || kid.localName === 'pict')
      if (cur === null || g !== curGraphic) {
        cur = doc.createElementNS(W_NS, 'w:r')
        if (rPr) cur.appendChild(rPr.cloneNode(true))
        parent.insertBefore(cur, run)
        curGraphic = g
      }
      cur.appendChild(kid)
    }
    parent.removeChild(run)
    changed++
  }
  return changed
}

export async function sanitizeDocxForEdit(bytes: Uint8Array): Promise<Uint8Array> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    return bytes
  }
  let touched = false
  for (const name of Object.keys(zip.files)) {
    if (!EDITABLE_PARTS.some((re) => re.test(name))) continue
    const file = zip.file(name)
    if (!file) continue
    let xml: string
    try {
      xml = await file.async('string')
    } catch {
      continue
    }
    let doc: XMLDocument
    try {
      doc = new DOMParser().parseFromString(xml, 'application/xml')
    } catch {
      continue
    }
    if (doc.getElementsByTagName('parsererror').length > 0) continue
    let changed = 0
    try {
      changed = sanitizeDocument(doc)
    } catch {
      continue
    }
    if (!changed) continue
    // XMLSerializer는 원본에 있던 선언을 그대로 싣고 나온다.
    // 그대로 앞에 선언을 붙이면 선언이 2개(두 번째가 문서 중간)가 돼서
    // "xml declaration which is only at the start"로 파싱이 죽는다.
    // (?<=\s로 선언문만 벗긴다 — xml-stylesheet 같은 PI는 건드리지 않는다.)
    const serialized = new XMLSerializer().serializeToString(doc).replace(/^<\?xml\s[^?]*\?>\s*/, '')
    const out = XML_DECL + serialized
    zip.file(name, out)
    touched = true
  }
  if (!touched) return bytes
  return zip.generateAsync({ type: 'uint8array' })
}
