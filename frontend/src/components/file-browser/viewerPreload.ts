import { loadPptxViewer, loadSpreadsheetEditor, loadVisioViewer, loadWordEditor } from './viewerLoaders'

const loaders = [loadPptxViewer, loadSpreadsheetEditor, loadWordEditor, loadVisioViewer]

/**
 * 문서 뷰어 청크 유휴 예열.
 * 정적 import는 초기 로드 전체에 뷰어 수 MB를 얹으므로 쓰지 않고,
 * 앱 부팅 후 한가할 때 dynamic import를 미리 당겨둔다.
 * 파일 오픈 시점에는 모듈 캐시에서 바로 나와서 fetch 레이스가 없다.
 * 실패하면 조용히 포기한다 (오픈 시 lazy+재시도가 그대로 받는다).
 */
export function preloadViewers(): void {
  const warm = (attempt: number) => {
    void Promise.allSettled(
      loaders.map((load) =>
        load().then(
          () => true,
          () => false,
        ),
      ),
    ).then((results) => {
      if (attempt < 2 && results.some((r) => r.status === 'rejected' || r.value === false)) {
        setTimeout(() => warm(attempt + 1), 4000 * (attempt + 1))
      }
    })
  }
  const kick = () => setTimeout(() => warm(0), 1500)
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void
  }).requestIdleCallback
  if (typeof ric === 'function') {
    ric(() => kick(), { timeout: 8000 })
  } else {
    kick()
  }
}
