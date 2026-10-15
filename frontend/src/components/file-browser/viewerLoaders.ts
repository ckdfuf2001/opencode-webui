/**
 * 문서 뷰어 dynamic import 팩토리 (컴포넌트 없음 — HMR 안전).
 * DocumentPreview의 lazy 인스턴스가 같은 팩토리를 쓴다.
 * 예열(preloadViewers)은 하지 않는다 — 필요한 타입의 청크만 로드한다.
 */
export const loadSpreadsheetEditor = () =>
  import('@christophervr/xlsx-react-viewer').then((m) => ({ default: m.SpreadsheetEditor }))

export const loadPptxViewer = () => import('./PptxViewer')

export const loadWordEditor = () =>
  import('docx-react-viewer').then((m) => ({ default: m.WordEditor }))

export const loadVisioViewer = () =>
  import('visio-react-viewer').then((m) => ({ default: m.VisioViewer }))
