import type { BrowserContext } from '@playwright/test'

export const ADA = { id: 'u-ada', name: 'Ada', color: '#2563eb' }
export const GRACE = { id: 'u-grace', name: 'Grace', color: '#059669' }

/** E8 제외 전 케이스: 스토리지 분리된 컨텍스트에 사용자 미리 주입. */
export async function seedUser(context: BrowserContext, user: { id: string; name: string; color: string }): Promise<void> {
  await context.addInitScript((u) => {
    localStorage.setItem('collab-user', JSON.stringify(u))
  }, user)
}
