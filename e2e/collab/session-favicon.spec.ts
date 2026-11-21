import { test, expect, type Browser } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { backendBase, workspaceDir } from './helpers/env'
import { gotoApp } from './helpers/viewer'
import { ADA, seedUser } from './helpers/users'

/**
 * F1-4: 세션 상태별 탭 파비콘 색상 (헤더 배지와 같은 판정).
 * /api/session-status를 목으로 working → 승인 대기 → 취소 → idle 순환하며
 * link[rel=icon] href가 바뀌는지, 다른 페이지로 이동하면 복원되는지 확인.
 */
type Stage = 'idle' | 'working' | 'pending' | 'cancelled'

test.describe('session favicon', () => {
  test('F4: 상태별 파비콘 변경 + 이탈 복원', async ({ browser }: { browser: Browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    try {
      // 레포를 등록하고 UI에서 세션을 만든다 (host 세션은 목록에 안 뜬다).
      const seg = `f4-${Date.now().toString(36)}`
      const mk = await page.request.post(`${backendBase()}/api/repos`, { data: { localPath: seg }, timeout: 60000 }).then((r) => r.json())
      const repoId = (mk as { id: number }).id
      expect(repoId, 'repo created').toBeTruthy()
      fs.mkdirSync(path.join(workspaceDir(), 'repos', seg), { recursive: true })
      await gotoApp(page)
      await page.goto(`/repos/${repoId}?collabDebug=1&e2e=1`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.getByRole('button', { name: 'Session', exact: true }).first().click({ timeout: 30000 })
      await page.waitForURL(/\/sessions\/[^/?]+/, { timeout: 30000 })
      const sessionId = page.url().split('/').pop()!.split('?')[0]!
      await page.locator('textarea').first().waitFor({ timeout: 60000 })
      let stage: Stage = 'idle'
      const payload = () => {
        if (stage === 'idle') return []
        if (stage === 'working') return [{ sessionId, directory: workspaceDir(), repoId: null, status: 'busy', pendingPermissions: 0, updatedAt: Date.now() }]
        if (stage === 'pending') return [{ sessionId, directory: workspaceDir(), repoId: null, status: 'idle', pendingPermissions: 2, updatedAt: Date.now() }]
        return [{ sessionId, directory: workspaceDir(), repoId: null, status: 'idle', pendingPermissions: 0, isCancelled: true, updatedAt: Date.now() }]
      }
      await page.route('**/api/session-status', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload()) })
      })
      const hrefOf = (): Promise<string | null> =>
        page.evaluate(() => document.querySelector('link[rel="icon"]')?.getAttribute('href') ?? null)
      // idle: 기본 아이콘.
      await expect.poll(hrefOf, { timeout: 15000 }).toContain('favicon.svg')
      const reloadStage = async (s: Stage): Promise<void> => {
        stage = s
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
        await page.locator('textarea').first().waitFor({ timeout: 60000 })
      }
      // working: 파랑.
      await reloadStage('working')
      await expect.poll(hrefOf, { timeout: 20000 }).toContain('data:image/svg+xml')
      expect(await hrefOf()).toContain('%233B82F6')
      // 승인 대기: 주황.
      await reloadStage('pending')
      await expect.poll(hrefOf, { timeout: 20000 }).toContain('%23F59E0B')
      // 취소 배지는 메시지가 있어야 뜬다: 한 번 보내고 완료까지 기다린다.
      await page.locator('textarea').first().fill('favicon probe')
      await page.getByRole('button', { name: 'Send', exact: true }).click({ timeout: 15000 })
      await expect.poll(async () => {
        const list = await page.request.get(`${backendBase()}/api/opencode/session/${sessionId}/message?limit=10`).then((r) => r.json()).catch(() => [])
        const arr = list as Array<{ info?: { role?: string; time?: { completed?: number } } }>
        const assistants = arr.filter((m) => m.info?.role === 'assistant')
        return arr.length >= 2 && assistants.length > 0 && assistants.every((m) => !!(m.info?.time as { completed?: number } | undefined)?.completed)
      }, { timeout: 300000, intervals: [5000] }).toBe(true)
      // 취소: 회색.
      await reloadStage('cancelled')
      await expect.poll(hrefOf, { timeout: 20000 }).toContain('%239CA3AF')
      // idle: 복원 (성공 마무리는 취소 배지를 남기지 않는다).
      await reloadStage('idle')
      await expect.poll(hrefOf, { timeout: 15000 }).toContain('favicon.svg')
      // 다른 페이지로 이동: 기본 아이콘으로 복원.
      await page.goto(`/?collabDebug=1&e2e=1`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await expect.poll(hrefOf, { timeout: 15000 }).toContain('favicon.svg')
    } finally {
      await ctx.close().catch(() => {})
    }
  })
})
