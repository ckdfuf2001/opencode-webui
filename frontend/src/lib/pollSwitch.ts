/**
 * M7-4 측정 스위치: `?poll=0`
 *
 * 세션 상태(1200ms)·헬스체크(3000ms)·채팅 큐(2000ms) 폴링을 끈다.
 * 편집 모드 잔여 메모리 증가의 원인이 폴링인지 판정하기 위한 용도다(M7-4 2절).
 *
 * 규칙:
 *  - 기본값은 켜짐(현행 동작 그대로).
 *  - ?poll=0 은 dev 서버에서만, 그리고 memDebug=1 과 함께 켜졌을 때만 작동한다.
 *    (prod 빌드/일반 사용자에게는 영향을 주지 않는다)
 */
export function pollDisabled(): boolean {
  if (!import.meta.env.DEV) return false
  try {
    const q = new URLSearchParams(window.location.search)
    return q.get('memDebug') === '1' && q.get('poll') === '0'
  } catch {
    return false
  }
}