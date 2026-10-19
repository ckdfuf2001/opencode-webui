/**
 * D29: 세션 상태 폴링 주기 규칙 (순수 함수).
 *
 * 같은 query key의 폴링 주체는 Pollers.tsx 한 곳뿐이다(D29). 여기서는 "어떤 주기로
 * 돌 것인가"만 결정하고, 실제로 타이머를 만드는 곳은 Pollers.tsx다.
 *
 * 근거: M7-4 실측에서 observer 9개 × 1.2s = interval 실행 7.9/s였고,
 * 단일 폴러로 합친 뒤 편집 모드 증가율이 +0.42 → +0.26MB/s로 내려갔다.
 */

export const SESSION_STATUS_BUSY_INTERVAL_MS = 1200;
export const SESSION_STATUS_IDLE_INTERVAL_MS = 5000;

/**
 * busy 세션이 하나라도 있으면 1200ms(빠른 지연 표시), 아니면 5000ms(유휴 부하 감소).
 */
export function sessionStatusRefetchInterval(
  rows: Array<{ status?: string }> | undefined,
): number {
  return rows?.some((r) => r?.status === "busy")
    ? SESSION_STATUS_BUSY_INTERVAL_MS
    : SESSION_STATUS_IDLE_INTERVAL_MS;
}
