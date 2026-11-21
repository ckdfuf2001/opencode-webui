import { test, expect, type Browser } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { backendBase, workspaceDir } from './helpers/env'
import { gotoApp } from './helpers/viewer'
import { ADA, seedUser } from './helpers/users'

/**
 * F1-3 채팅 큐 전체 내용 보기.
 * - hover: 미리보기 영역에 전문 표시, 떼면 닫힘.
 * - click: 고정 (mouse 이동 후에도 유지), 다시 클릭/다른 항목/Escape으로 전환·해제.
 * - 행 버튼(재시도/위로/맨 위로/X)은 미리보기를 열지 않음 (전파 차단).
 * - 고정 항목 삭제 시 미리보기 자동 닫힘.
 * - sending 항목·접힌 칩의 "Sending..."에도 같은 미리보기.
 */
const LONG_A = `Q3-PREVIEW-A-` + `가나다라마바사아자차카타파하`.repeat(20)
const LONG_B = `Q3-PREVIEW-B-` + `ABCDEFGH`.repeat(30)

async function api(path: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${backendBase()}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`)
  return res.json().catch(() => null)
}

test.describe('chat queue preview', () => {
  test('Q3: hover 전문·클릭 고정·버튼 전파차단·삭제 닫힘', async ({ browser }: { browser: Browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    try {
      // 레포를 등록하고 RepoDetail에서 세션을 만든다.
      const seg = `q3-${Date.now().toString(36)}`
      const mk = await page.request.post(`${backendBase()}/api/repos`, { data: { localPath: seg }, timeout: 60000 }).then((r) => r.json())
      const repoId = (mk as { id: number }).id
      expect(repoId, 'repo created').toBeTruthy()
      fs.mkdirSync(path.join(workspaceDir(), 'repos', seg), { recursive: true })
      await gotoApp(page)
      await page.goto(`/repos/${repoId}?collabDebug=1&e2e=1`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.getByRole('button', { name: 'Session', exact: true }).first().click({ timeout: 30000 })
      await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30000 })
      const sessionId = page.url().split('/').pop()!.split('?')[0]!
      await page.locator('textarea').first().waitFor({ timeout: 60000 })
      // 자동 발송 방지: 일시정지 후 2건 적재.
      await page.evaluate(([sid]) => localStorage.setItem(`queue-paused:${sid}`, '1'), [sessionId])
      await api(`/api/chat-queue/${encodeURIComponent(sessionId)}/paused`, 'POST', { paused: true })
      await api(`/api/chat-queue/${encodeURIComponent(sessionId)}`, 'POST', { text: LONG_A })
      await api(`/api/chat-queue/${encodeURIComponent(sessionId)}`, 'POST', { text: LONG_B })
      await page.evaluate(([sid]) => localStorage.setItem(`queue-paused:${sid}`, '1'), [sessionId])
      await page.reload({ waitUntil: 'domcontentloaded' })
      // 큐 펼치기 (접힌 칩에 개수 표시).
      const expand = page.locator('button', { hasText: 'Queue held' }).first()
      await expand.waitFor({ timeout: 30000 })
      await expand.click({ timeout: 10000 })
      const rowA = page.locator('li', { hasText: 'Q3-PREVIEW-A-' }).first()
      const rowB = page.locator('li', { hasText: 'Q3-PREVIEW-B-' }).first()
      await expect(rowA).toBeVisible({ timeout: 30000 })
      await expect(rowB).toBeVisible({ timeout: 15000 })
      // hover: 전문 미리보기가 보인다.
      await rowA.hover()
      const preview = page.getByTestId('queue-preview')
      await expect(preview).toBeVisible({ timeout: 5000 })
      await expect(preview).toContainText(LONG_A.slice(0, 60))
      // 마우스를 떼면 닫힌다.
      await page.mouse.move(10, 10)
      await expect(preview).toBeHidden({ timeout: 5000 })
      // 클릭: 고정된다 (마우스를 떼도 유지).
      await rowA.click({ timeout: 10000 })
      await expect(preview).toBeVisible({ timeout: 5000 })
      await page.mouse.move(10, 10)
      await expect(preview).toBeVisible({ timeout: 5000 })
      await expect(preview).toContainText(LONG_A.slice(0, 60))
      // 다른 항목 클릭: 미리보기가 B로 전환된다.
      await rowB.click({ timeout: 10000 })
      await expect(preview).toContainText(LONG_B.slice(0, 60))
      // 행 버튼은 미리보기를 열지 않는다 (전파 차단): B 고정 상태에서
      // A의 위로 버튼을 눌러도 미리보기는 B 그대로다.
      await rowA.getByRole('button', { name: 'Move up one' }).click({ timeout: 10000 })
      await expect(preview).toContainText(LONG_B.slice(0, 60))
      // 고정 항목 삭제: 미리보기가 자동으로 닫힌다.
      await rowB.getByRole('button', { name: 'Remove queued message' }).click({ timeout: 10000 })
      await expect(rowB).toHaveCount(0, { timeout: 10000 })
      await expect(preview).toBeHidden({ timeout: 5000 })
      // Escape: 미리보기를 닫는다 (A 다시 고정 후).
      await rowA.click({ timeout: 10000 })
      await expect(preview).toBeVisible({ timeout: 5000 })
      await page.keyboard.press('Escape')
      await expect(preview).toBeHidden({ timeout: 5000 })
    } finally {
      await ctx.close().catch(() => {})
    }
  })
})
