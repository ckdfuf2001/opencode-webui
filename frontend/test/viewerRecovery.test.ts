import { describe, expect, it } from 'vitest'
import { VIEWER_RETRY_MAX, consumeRetryBudget } from '../src/lib/viewerRecovery'

/**
 * C7m: Retry 버튼 1클릭 → 최대 3회 자동 재시도 (무한 루프 금지).
 * - red: 헬퍼가 아직 없어 import 자체가 실패한다.
 */
describe('viewerRecovery', () => {
  it('예산 상수는 3이다', () => {
    expect(VIEWER_RETRY_MAX).toBe(3)
  })

  it('예산이 남았으면 1회 소진하고 재시도한다', () => {
    expect(consumeRetryBudget(3)).toEqual({ retry: true, left: 2 })
    expect(consumeRetryBudget(1)).toEqual({ retry: true, left: 0 })
  })

  it('예산이 바닥나면 재시도하지 않는다', () => {
    expect(consumeRetryBudget(0)).toEqual({ retry: false, left: 0 })
    expect(consumeRetryBudget(-5)).toEqual({ retry: false, left: 0 })
  })
})
