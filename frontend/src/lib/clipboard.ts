/**
 * 클립보드 복사. navigator.clipboard는 보안 컨텍스트(https/localhost)에서만
 * 존재하므로 http IP 접속 등에서는 구방식(textarea+execCommand)으로 폴백한다.
 * 성공 여부를 반환 — 호출 측에서 토스트를 띄운다.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 권한 거부 등은 아래 폴백으로 이어간다
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}
