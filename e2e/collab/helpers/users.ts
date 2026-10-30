import type { BrowserContext } from '@playwright/test'

export const ADA = { id: 'u-ada', name: 'Ada', color: '#2563eb' }
export const GRACE = { id: 'u-grace', name: 'Grace', color: '#059669' }

/**
 * E8 제외 전 케이스: 스토리지 분리된 컨텍스트에 사용자 미리 주입.
 * C3: 이름 변경 후 reload해도 유지되어야 하므로, 키가 없을 때만 심는다
 * (매 내비게이션 덮어쓰면 rename 유지 단언이 하네스 때문에 깨진다).
 */
export async function seedUser(context: BrowserContext, user: { id: string; name: string; color: string }): Promise<void> {
  await context.addInitScript((u) => {
    try {
      if (window.location.protocol.startsWith('http') && !localStorage.getItem('collab-user'))
        localStorage.setItem('collab-user', JSON.stringify(u))
    } catch {
      // about:blank에서는 무시.
    }
  }, user)
}
