/**
 * 세션 모델 오버라이드 (localStorage).
 * opencode API에는 세션 모델 변경 엔드포인트가 없어서
 * (POST /session/:id/model 호출은 HTML 200으로 무시된다)
 * 사용자가 고른 모델을 세션별로 따로 기억하고 전송마다 명시한다.
 * 서버 session.model이 오래된(제공 중지된) 값이어도
 * 컴포저·전송·컨텍스트 표시는 오버라이드를 우선한다.
 */
const keyOf = (sessionId: string) => `opencode-session-model:${sessionId}`

export function getSessionModelOverride(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null
  try {
    const v = localStorage.getItem(keyOf(sessionId))
    return v && v.includes('/') ? v : null
  } catch {
    return null
  }
}

export function setSessionModelOverride(sessionId: string | null | undefined, model: string): void {
  if (!sessionId) return
  try {
    if (model && model.includes('/')) localStorage.setItem(keyOf(sessionId), model)
    else localStorage.removeItem(keyOf(sessionId))
  } catch {
    // 무시 (private mode 등)
  }
}
