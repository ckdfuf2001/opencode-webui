import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { absForRel, uniqueRel, uniqueRelWithExt } from './helpers/env'
import { gotoApp, openFile } from './helpers/viewer'
import { ADA, GRACE, seedUser } from './helpers/users'

/**
 * C1: 접속자 표시 통일 (CollabPresence, PPT/XLSX).
 *
 * P-1 PPT에 통합 presence 컨테이너(`collab-presence`)가 있다.
 * P-2 XLSX people이 role+sheet+range를 싣는다.
 * P-3 XLSX에도 통합 presence 바(`collab-presence`)가 있다.
 * P-4 ooxml-ui presence 패치 표식(`uiXlsxPresence`)이 로드된다.
 *
 * 전부 red 선행 — 구현 전에는 실패해야 한다.
 */

const PPTX_FIXTURE = path.resolve('e2e/collab/fixtures/collab-3slides.pptx')
const XLSX_FIXTURE = path.resolve('e2e/collab/fixtures/collab-features.xlsx')

interface Two {
  ctxA: BrowserContext
  ctxB: BrowserContext
  pageA: Page
  pageB: Page
}

async function twoPages(browser: Browser): Promise<Two> {
  const mk = async (user: { id: string; name: string; color: string }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, user)
    const page = await ctx.newPage()
    await gotoApp(page)
    return { ctx, page }
  }
  const a = await mk(ADA)
  const b = await mk(GRACE)
  return { ctxA: a.ctx, ctxB: b.ctx, pageA: a.page, pageB: b.page }
}

async function freshPptx(slug: string, index: number): Promise<{ name: string }> {
  const rel = uniqueRel(slug, index)
  const abs = absForRel(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.copyFileSync(PPTX_FIXTURE, abs)
  return { name: rel.split('/').pop()! }
}

function freshXlsx(slug: string, index: number): { name: string } {
  const rel = uniqueRelWithExt(slug, index, '.xlsx')
  const abs = absForRel(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.copyFileSync(XLSX_FIXTURE, abs)
  return { name: rel.split('/').pop()! }
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

test.describe('C1 presence unification', () => {
  test('P-1: PPT shows unified collab-presence container', async ({ browser }) => {
    const f = await freshPptx('c1p1', 0)
    const t = await twoPages(browser)
    try {
      await openFile(t.pageA, f.name, 'edit')
      await openFile(t.pageB, f.name, 'view')
      await expect(t.pageB.getByTestId('collab-presence')).toBeVisible({ timeout: 30000 })
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('P-2: XLSX people carries role+sheet+range', async ({ browser }) => {
    const f = freshXlsx('c1p2', 0)
    const t = await twoPages(browser)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)
      await expect
        .poll(
          async () =>
            t.pageA.evaluate(() => {
              const el = document.querySelector('xlsx-editor') as unknown as {
                collaborationState?: { active: boolean; people?: Array<Record<string, unknown>> }
              } | null
              return (el?.collaborationState?.people?.length ?? 0) as number
            }),
          { timeout: 30000, intervals: [500] },
        )
        .toBeGreaterThanOrEqual(2)
      const list = await t.pageA.evaluate(() => {
        const el = document.querySelector('xlsx-editor') as unknown as {
          collaborationState?: { active: boolean; people?: Array<Record<string, unknown>> }
        } | null
        return (el?.collaborationState?.people ?? null) as Array<Record<string, unknown>> | null
      })
      expect(list).not.toBeNull()
      expect(list!.length).toBeGreaterThanOrEqual(2)
      for (const p of list!) {
        expect(p).toHaveProperty('role')
        expect(p).toHaveProperty('sheet')
        expect(p).toHaveProperty('range')
      }
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('P-3: XLSX shows unified collab-presence bar', async ({ browser }) => {
    const f = freshXlsx('c1p3', 0)
    const t = await twoPages(browser)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await expect(t.pageA.getByTestId('collab-presence')).toBeVisible({ timeout: 30000 })
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('P-4: ooxml-ui presence patch marker loaded', async ({ browser }) => {
    const f = freshXlsx('c1p4', 0)
    const t = await twoPages(browser)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await expect
        .poll(
          () =>
            t.pageA.evaluate(
              () => (globalThis as unknown as { __ooxmlPatches?: { uiXlsxPresence?: string } }).__ooxmlPatches?.uiXlsxPresence ?? null,
            ),
          { timeout: 15000, intervals: [300] },
        )
        .toBe('X2a-presence')
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })
})
