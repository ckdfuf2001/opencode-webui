import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { absForRel, uniqueRelWithExt } from './helpers/env'
import { gotoApp } from './helpers/viewer'
import { ADA, GRACE, seedUser } from './helpers/users'

/**
 * C2: XLSX 동시편집 자동 복구 + 자동 저장.
 *
 * C2-a (red 먼저): non-secure context(http://IP 상당, crypto.subtle 없음)에서도
 * 2명이 같은 방에 참가하고, nohash 배너("https 또는 localhost")가 0회여야 한다.
 * 현재 코드는 hashBytesHex(crypto.subtle)가 실패하면 fail-closed로 방에 붙지 않는다.
 */

const FIXTURE = path.resolve('e2e/collab/fixtures/collab-features.xlsx')

interface Two {
  ctxA: BrowserContext
  ctxB: BrowserContext
  pageA: Page
  pageB: Page
}

async function twoPagesNoSubtle(browser: Browser): Promise<Two> {
  const mk = async (user: { id: string; name: string; color: string }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, user)
    // P0-2 재현: http://IP 접속 상당. subtle/randomUUID 없이 getRandomValues만 둔다.
    await ctx.addInitScript(() => {
      try {
        Object.defineProperty(window, 'crypto', { value: { getRandomValues: () => new Uint8Array(8) }, configurable: true })
      } catch {
        /* 무시 */
      }
    })
    const page = await ctx.newPage()
    await gotoApp(page)
    return { ctx, page }
  }
  const a = await mk(ADA)
  const b = await mk(GRACE)
  return { ctxA: a.ctx, ctxB: b.ctx, pageA: a.page, pageB: b.page }
}

function freshXlsx(slug: string, index: number): { rel: string; abs: string; name: string } {
  const rel = uniqueRelWithExt(slug, index, '.xlsx')
  const abs = absForRel(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.copyFileSync(FIXTURE, abs)
  return { rel, abs, name: rel.split('/').pop()! }
}

async function openXlsxEditing(page: Page, name: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    try {
      await page.getByTitle('Workspace').waitFor({ timeout: 12000 })
      break
    } catch {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    }
  }
  for (let i = 0; i < 5; i++) {
    await page.getByTitle('Workspace').click({ timeout: 20000 })
    const opened = await expect
      .poll(async () => page.locator('[data-testid="file-row"]').count(), { timeout: 8000, intervals: [200] })
      .toBeGreaterThan(0)
      .then(() => true)
      .catch(() => false)
    if (opened) break
    await page.keyboard.press('Escape')
  }
  await expect
    .poll(async () => page.locator('[data-testid="file-row"]').count(), { timeout: 15000, intervals: [200] })
    .toBeGreaterThan(0)
  for (let i = 0; i < 8; i++) {
    const has = await page.evaluate(
      (n) => [...document.querySelectorAll('[data-testid="file-row"]')].some((r) => (r.textContent || '').includes(n)),
      name,
    )
    if (has) break
    const folder = page.locator('[data-testid="file-row"][data-path$="collab-e2e"]')
    if ((await folder.count()) > 0) {
      await folder.locator('div.flex-1').first().click({ timeout: 10000 }).catch(() => {})
    }
    await expect
      .poll(
        async () =>
          page.evaluate(
            (n) => [...document.querySelectorAll('[data-testid="file-row"]')].some((r) => (r.textContent || '').includes(n)),
            name,
          ),
        { timeout: 8000, intervals: [300] },
      )
      .toBe(true)
      .catch(() => {})
  }
  await page.locator(`[data-testid="file-row"][data-path$="${name}"]`).locator('span', { hasText: name }).first().click({ timeout: 20000 })
  await page.waitForSelector('.xlsxengine-host', { timeout: 30000 })
  const edit = page.getByRole('button', { name: 'Edit', exact: true })
  await edit.waitFor({ timeout: 20000 })
  await edit.click({ timeout: 20000 })
  await page.waitForSelector('xlsx-editor', { timeout: 20000 })
}

async function collabState(page: Page): Promise<{ active: boolean }> {
  return page.evaluate(() => {
    const el = document.querySelector('xlsx-editor') as unknown as {
      collaborationState?: { active: boolean }
    } | null
    return { active: el?.collaborationState?.active ?? false }
  })
}

test.describe('C2-a: non-secure context 참가', () => {
  test('C2-a: subtle 없이 2명이 같은 방에 참가하고 nohash 배너가 0회다', async ({ browser }) => {
    const t = await twoPagesNoSubtle(browser)
    const f = freshXlsx('c2a', 0)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)
      // 방 참가 또는 배너 중 먼저 오는 쪽을 기다린다. 현재 코드는 배너가 온다.
      await expect
        .poll(
          async () => {
            const a = await collabState(t.pageA)
            const banner = await t.pageA.locator('[data-testid="xlsx-collab-banner"]').count()
            return a.active || banner > 0 ? 'settled' : 'waiting'
          },
          { timeout: 30000, intervals: [500] },
        )
        .toBe('settled')
      // 진단 덤프(단언 아님): 현재 코드에서 뜨는 배너 원문을 확인하려고 남긴다.
      const bannerText = await t.pageA
        .locator('[data-testid="xlsx-collab-banner"]')
        .first()
        .textContent()
        .catch(() => null)
      console.log('C2A_BANNER_A ' + JSON.stringify(bannerText))
      // C2-a 목표: subtle 없이도 방에 참가한다.
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 15000, intervals: [500] }).toBe(true)
      await expect.poll(async () => (await collabState(t.pageB)).active, { timeout: 15000, intervals: [500] }).toBe(true)
      await expect(t.pageA.getByText('https 또는 localhost')).toHaveCount(0)
      await expect(t.pageB.getByText('https 또는 localhost')).toHaveCount(0)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })
})
