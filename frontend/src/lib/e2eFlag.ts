/**
 * M9/6절: E2E 하네스 복구용 앱 플래그.
 *
 * `?e2e=1` 쿼리 파라미터 또는 `VITE_E2E=1` 빌드 환경변수로 켠다.
 * (E2E webServer 는 vite 를 `VITE_E2E=1` 로 띄운다 → 스펙이 어떤 URL 로 가든 적용된다.
 *  쿼리 파라미터만 쓰면 스펙마다 URL 을 바꿔야 해서 놓치기 쉽다.)
 *
 * 켜지는 것:
 * - 토스트/오버레이(알림 배너) 숨김 — Playwright 액션이 가로채지 않게 한다.
 * - 선택적 fetch 실패(명령 목록 등)의 console.error 를 console.warn 으로 낮춘다.
 *   환경 문제(예: opencode 서버 인스턴스 로드 타임아웃)로 실패해도 E2E 의
 *   엄격한 콘솔 검사(하네스 전용)가 테스트를 죽이지 않게 한다.
 *
 * 프로덕션 동작은 바뀌지 않는다(플래그가 없으면 원래대로).
 */
export function isE2EFlag(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get('e2e') === '1') return true
  } catch {
    // window 가 없으면 env 만 확인한다.
  }
  try {
    return import.meta.env?.VITE_E2E === '1'
  } catch {
    return false
  }
}
