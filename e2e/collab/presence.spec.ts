import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { absForRel, uniqueRel, uniqueRelWithExt } from './helpers/env'
import { gotoApp, openEditor, openFile } from './helpers/viewer'
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

async function freshPptx(slug: string, index: number): Promise<{ name: string; rel: string }> {
  const rel = uniqueRel(slug, index)
  const abs = absForRel(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.copyFileSync(PPTX_FIXTURE, abs)
  return { name: rel.split('/').pop()!, rel }
}

function freshXlsx(slug: string, index: number): { name: string; rel: string } {
  const rel = uniqueRelWithExt(slug, index, '.xlsx')
  const abs = absForRel(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.copyFileSync(XLSX_FIXTURE, abs)
  return { name: rel.split('/').pop()!, rel }
}

async function openXlsxEditing(page: Page, rel: string): Promise<void> {
  // C5-4 flag-day: /edit/* 직접 goto (in-page Edit 폐지). rel은 repos/ 접두 포함.
  await openEditor(page, rel.replace(/^repos\//, ''))
}

test.describe('C1 presence unification', () => {
  test('P-1: PPT shows unified collab-presence container', async ({ browser }) => {
    const f = await freshPptx('c1p1', 0)
    const t = await twoPages(browser)
    try {
      await openEditor(t.pageA, f.rel.replace(/^repos\//, ''))
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
      await openXlsxEditing(t.pageA, f.rel)
      await openXlsxEditing(t.pageB, f.rel)
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
      await openXlsxEditing(t.pageA, f.rel)
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
      await openXlsxEditing(t.pageA, f.rel)
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
