/**
 * C7m swap 가드 (순수 함수 — DOM 조작은 OleAttachmentOverlay가 담당).
 * - 실패한 img에는 SWAP_FAILED_ATTR를 남기고 다시 swap하지 않는다
 *   (onerror 복원 → MutationObserver → update → 재swap 무한 루프 방지, D35).
 * - 이미 swap한 img(SWAPPED_ATTR)도 건너뛴다.
 *   lib이 img를 다시 그리면 새 요소라 표식이 없어 1회 swap된다 (정상 동작).
 */

export const SWAP_FAILED_ATTR = 'data-ole-swap-failed'
export const SWAPPED_ATTR = 'data-ole-swapped'

/** 우리 아이콘 URL 판별 (이미 swap된 src는 건너뛴다). */
export const EMBED_ICON_PATH = '/api/collab/embed/icon'

export function shouldSwapOleImg(src: string, failed: boolean, swapped: boolean): boolean {
  if (failed || swapped) return false
  if (!src || src.includes(EMBED_ICON_PATH)) return false
  return true
}

/**
 * 동일값 setState 스킵 (D35 유휴 렌더 0회).
 * JSON이 같으면 이전 객체를 그대로 돌려줘 리렌더를 막는다.
 */
export function mergePosMap<T extends Record<string, unknown>>(prev: T, next: T): T {
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next
}
