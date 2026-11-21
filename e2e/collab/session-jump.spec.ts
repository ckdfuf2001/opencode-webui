import { test, expect, type Browser, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { backendBase, workspaceDir } from './helpers/env'
import { gotoApp } from './helpers/viewer'
import { ADA, seedUser } from './helpers/users'

/**
 * F1-2: 검색 3단계 펼침 (SessionJumpDialog).
 * - 기본: 사용자 메시지만 + "응답에서 일치" 배지.
 * - 클릭: 마지막 assistant 응답 펼침.
 * - 상세: 턴 전체(도구 호출 포함)를 그때 불러옴. 상세 전에는 DOM에 없음.
 */
type OpMsg = {
  info?: { role?: string; time?: { completed?: number } }
  parts?: Array<{ type?: string; text?: string; tool?: string; filename?: string; output?: unknown }>
}

function partText(p: NonNullable<OpMsg['parts']>[number]): string {
  const bits: string[] = []
  if (typeof p.text === 'string') bits.push(p.text)
  if (typeof p.tool === 'string') bits.push(`[tool:${p.tool}]`)
  if (typeof p.filename === 'string') bits.push(p.filename)
  if (p.output != null) {
    try {
      bits.push(JSON.stringify(p.output).slice(0, 2000))
    } catch { /* 무시 */ }
  }
  return bits.join('\n')
}

async function openJumpDialog(page: Page): Promise<void> {
  await page.getByTitle('More actions (search / jump / download)').first().click({ timeout: 15000 })
  await page.getByRole('menuitem', { name: /Search \/ Go to message/ }).click({ timeout: 10000 })
  await expect(page.getByRole('dialog')).toContainText(/Search \/ Go to message/, { timeout: 15000 })
}

test.describe('session jump stages', () => {
  test('F2: 사용자만 → 마지막 응답 → 상세(도구 호출 포함)', async ({ browser }: { browser: Browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    try {
      // 레포+세션.
      const seg = `f2-${Date.now().toString(36)}`
      const mk = await page.request.post(`${backendBase()}/api/repos`, { data: { localPath: seg }, timeout: 60000 }).then((r) => r.json())
      const repoId = (mk as { id: number }).id
      expect(repoId, 'repo created').toBeTruthy()
      fs.mkdirSync(path.join(workspaceDir(), 'repos', seg), { recursive: true })
      fs.writeFileSync(path.join(workspaceDir(), 'repos', seg, 'f2marker-abc.txt'), 'hello f2')
      await gotoApp(page)
      await page.goto(`/repos/${repoId}?collabDebug=1&e2e=1`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.getByRole('button', { name: 'Session', exact: true }).first().click({ timeout: 30000 })
      await page.waitForURL(/\/sessions\/[^/?]+/, { timeout: 30000 })
      const sessionId = page.url().split('/').pop()!.split('?')[0]!
      await page.locator('textarea').first().waitFor({ timeout: 60000 })
      // 도구 호출을 유도하는 질문 → 완료까지 대기. 도구 출력에서 따온
      // 토큰을 검색어로 쓴다 (없으면 마커 파일명으로 폴백).
      await page.locator('textarea').first().fill('glob 도구로 현재 폴더의 txt 파일 목록을 보여줘')
      await page.getByRole('button', { name: 'Send', exact: true }).click({ timeout: 15000 })
      const toolToken: string = await expect.poll(async () => {
        const list = (await page.request.get(`${backendBase()}/api/opencode/session/${sessionId}/message?limit=50`).then((r) => r.json()).catch(() => [])) as OpMsg[]
        const assts = list.filter((m) => m.info?.role === 'assistant')
        const done = assts.length > 0 && assts.every((m) => (m.info?.time as { completed?: number } | undefined)?.completed)
        if (!done) return ''
        for (const m of assts) {
          for (const p of m.parts ?? []) {
            if (p.type === 'tool') {
              const t = partText(p)
              const f = t.match(/[\w-]+\.(?:txt|md|json|ts|tsx|js)\b/)
              if (f) return f[0]
              return '[tool]'
            }
          }
        }
        return ''
      }, { timeout: 420000, intervals: [5000] }).not.toBe('')
      const queryToken = toolToken === '[tool]' ? 'f2marker-abc.txt' : toolToken
      await openJumpDialog(page)
      const dialog = page.getByRole('dialog')
      await dialog.locator('input[placeholder*="Search"]').fill(queryToken)
      const turnRow = dialog.getByTestId('jump-turn-row').first()
      await expect(turnRow).toBeVisible({ timeout: 60000 })
      // 0단계: 사용자 메시지만 보이고 "응답에서 일치" 배지가 있다.
      await expect(turnRow).toContainText('txt 파일 목록', { timeout: 10000 })
      await expect(turnRow.getByText('응답에서 일치')).toBeVisible({ timeout: 10000 })
      // 상세 전에는 중간 내용이 DOM에 없다.
      await expect(dialog.getByTestId('jump-turn-detail')).toHaveCount(0)
      // 1단계: 클릭하면 마지막 assistant 응답이 보인다.
      await turnRow.click({ timeout: 10000 })
      await expect(dialog.getByTestId('jump-turn-last')).toBeVisible({ timeout: 10000 })
      // 2단계: 상세를 누르면 도구 호출 포함 전체가 보인다.
      await dialog.getByTestId('jump-turn-detail-btn').first().click({ timeout: 10000 })
      await expect(dialog.getByTestId('jump-turn-detail')).toBeVisible({ timeout: 15000 })
      await expect(dialog.getByTestId('jump-turn-detail')).toContainText(queryToken, { timeout: 10000 })
    } finally {
      await ctx.close().catch(() => {})
    }
  })
})
