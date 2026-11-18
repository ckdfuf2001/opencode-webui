/**
 * C7m: 뷰어 Retry 버튼의 자동 재시도 예산 (수동 1클릭 → 최대 3회 시도).
 * - 예산은 클릭할 때마다 새로 채워진다. 자동 시도 사이에는 종료 판정 없이
 *   멈추지 않는다 (성공하면 settle 타이머가 예산을 회수한다).
 * - 예산이 바닥나면 재시도하지 않고 에러 UI를 유지한다 (무한 루프 금지).
 */
export const VIEWER_RETRY_MAX = 3

export function consumeRetryBudget(left: number): { retry: boolean; left: number } {
  if (left <= 0) return { retry: false, left: 0 }
  return { retry: true, left: left - 1 }
}
