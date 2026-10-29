import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { absForRel, uniqueRel, uniqueRelWithExt } from './helpers/env'
import { gotoApp, openFile, gotoSlide, peer } from './helpers/viewer'
import { ADA, GRACE, seedUser } from './helpers/users'

/**
 * C3: 접속자 표시 통일 완성 (팝오버 + "(Me)" + 따라가기 + 이미지 잠금).
 *
 * P-5: 팝오버 열기/닫기 (PPT/XLSX).
 * P-6: 이름 변경 + "(Me)" 표시 규칙 (PPT/XLSX).
 * P-7: 따라가기 유지/해제/상호 팔로우 상한 (PPT/XLSX).
 * P-8: 같은 userId 탭 묶음 (getByRole 기준).
 * P-9: 상단 표기 정리 (viewer/editor/"나:" 0개, collab-presence 1개, data-owner 유지).
 * C3-img-1/2: 동시편집 중 이미지 편집 차단 (유실 2경로 red).
 * C3-flush: 1→2 참가 시 owner 즉시 저장 (디바운스 건너뜀, POST 1건).
 * C3-undo: 잠금 중 undo 우회 불가.
 * C3-release: 잠금 해제 후 단독 편집 허용.
 *
 * red 기준: 팝오버·가드·reveal이 없으므로 관련 단언이 실패한다.
 */

const PPTX_FIXTURE = path.resolve('e2e/collab/fixtures/collab-3slides.pptx')
const XLSX_FIXTURE = path.resolve('e2e/collab/fixtures/collab-features.xlsx')
const LOCK_TOAST = '동시편집 중에는 이 편집을 지원하지 않습니다'

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

function freshPptx(slug: string, index: number): { rel: string; abs: string; name: string } {
  const rel = uniqueRel(slug, index)
  const abs = absForRel(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.copyFileSync(PPTX_FIXTURE, abs)
  return { rel, abs, name: rel.split('/').pop()! }
}

function freshXlsx(slug: string, index: number): { rel: string; abs: string; name: string } {
  const rel = uniqueRelWithExt(slug, index, '.xlsx')
  const abs = absForRel(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.copyFileSync(XLSX_FIXTURE, abs)
  return { rel, abs, name: rel.split('/').pop()! }
}

/** 앱 헤더의 Save(덮어쓰기). */
async function clickAppSave(page: Page): Promise<void> {
  const save = page.locator('[data-testid="preview-doc-header"]').getByRole('button', { name: 'Save', exact: true })
  await save.waitFor({ timeout: 20000 })
  await save.click({ timeout: 20000 })
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

async function xlsxActive(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector('xlsx-editor') as unknown as {
      collaborationState?: { active: boolean }
    } | null
    return el?.collaborationState?.active ?? false
  })
}

async function closeXlsxPreview(page: Page): Promise<void> {
  const btn = page.locator('[aria-label="Close explorer"]')
  if (await btn.count()) {
    await btn.first().click({ timeout: 10000 })
  } else {
    await page.keyboard.press('Escape')
  }
  await expect.poll(async () => page.locator('.xlsxengine-host').count(), { timeout: 10000, intervals: [300] }).toBe(0)
}

async function clickDone(page: Page): Promise<void> {
  const done = page.getByRole('button', { name: 'Done', exact: true })
  await done.waitFor({ timeout: 20000 })
  await done.click({ timeout: 20000 })
}

/** 저장된 xlsx(zip) 안의 XML 어디에든 문자열이 들어 있는가. */
async function workbookContains(absPath: string, needle: string): Promise<boolean> {
  if (!fs.existsSync(absPath)) return false
  const buf = fs.readFileSync(absPath)
  const zip = await JSZip.loadAsync(buf)
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name]
    if (entry.dir || !name.endsWith('.xml')) continue
    const xml = await entry.async('string')
    if (xml.includes(needle)) return true
  }
  return false
}

/** xlsx-editor의 lib core에 직접 닿는다 (그리드 UI와 같은 ctx.run 경로를 탄다). */
async function xlsxImageAnchor(page: Page): Promise<{ sheet: number; index: number; row: number } | null> {
  return page.evaluate(() => {
    const el = document.querySelector('xlsx-editor') as unknown as {
      core?: { workbook?: { sheets?: Array<{ drawings?: Array<{ kind?: string; anchor?: { from?: { row?: number } } }> }> } }
    } | null
    const sheets = el?.core?.workbook?.sheets ?? []
    for (let s = 0; s < sheets.length; s++) {
      const drawings = sheets[s]?.drawings ?? []
      for (let i = 0; i < drawings.length; i++) {
        if (drawings[i]?.kind === 'image') {
          return { sheet: s, index: i, row: drawings[i]?.anchor?.from?.row ?? -1 }
        }
      }
    }
    return null
  })
}

async function xlsxMoveImage(page: Page, sheet: number, index: number, toRow: number): Promise<unknown> {
  return page.evaluate(
    ([s, i, row]) => {
      const el = document.querySelector('xlsx-editor') as unknown as {
        core?: {
          workbook?: { sheets?: Array<{ drawings?: Array<{ anchor?: unknown }> }> }
          session?: { setDrawingAnchor?: (sheet: number, index: number, anchor: unknown) => void }
        }
      } | null
      const anchor = (el?.core?.workbook?.sheets?.[s] as { drawings?: Array<{ anchor?: unknown }> } | undefined)?.drawings?.[i]?.anchor
      if (!anchor) throw new Error('no drawing anchor')
      const next = JSON.parse(JSON.stringify(anchor)) as { from: { row: number } }
      next.from.row = row
      return el?.core?.session?.setDrawingAnchor?.(s, i, next) ?? null
    },
    [sheet, index, toRow] as const,
  )
}

test.describe('C3 P-5: 팝오버 열기/닫기', () => {
  test('P-5a PPT: 클릭하면 열리고 바깥 클릭·Esc·재클릭으로 닫힌다', async ({ browser }) => {
    const f = await freshPptx('c3p5a', 0)
    const t = await twoPages(browser)
    try {
      await openFile(t.pageA, f.name, 'edit')
      await openFile(t.pageB, f.name, 'view')
      await expect(peer(t.pageB, 'u-ada')).toBeVisible({ timeout: 15000 })
      // 닫혀 있으면 DOM에 없다.
      await expect(t.pageB.getByTestId('collab-popover')).toHaveCount(0)
      // 클릭하면 열린다.
      await t.pageB.getByTestId('collab-avatars').click({ timeout: 10000 })
      await expect(t.pageB.getByTestId('collab-popover')).toBeVisible({ timeout: 5000 })
      // 바깥 클릭하면 닫힌다.
      await t.pageB.mouse.click(20, 400)
      await expect(t.pageB.getByTestId('collab-popover')).toHaveCount(0)
      // 다시 클릭하면 열린다.
      await t.pageB.getByTestId('collab-avatars').click({ timeout: 10000 })
      await expect(t.pageB.getByTestId('collab-popover')).toBeVisible({ timeout: 5000 })
      // Esc로 닫힌다.
      await t.pageB.keyboard.press('Escape')
      await expect(t.pageB.getByTestId('collab-popover')).toHaveCount(0)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('P-5b XLSX: 클릭하면 열리고 바깥 클릭·Esc·재클릭으로 닫힌다', async ({ browser }) => {
    const f = freshXlsx('c3p5b', 0)
    const t = await twoPages(browser)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect(t.pageA.getByTestId('collab-popover')).toHaveCount(0)
      await t.pageA.getByTestId('collab-avatars').click({ timeout: 10000 })
      await expect(t.pageA.getByTestId('collab-popover')).toBeVisible({ timeout: 5000 })
      await t.pageA.mouse.click(20, 400)
      await expect(t.pageA.getByTestId('collab-popover')).toHaveCount(0)
      await t.pageA.getByTestId('collab-avatars').click({ timeout: 10000 })
      await expect(t.pageA.getByTestId('collab-popover')).toBeVisible({ timeout: 5000 })
      await t.pageA.keyboard.press('Escape')
      await expect(t.pageA.getByTestId('collab-popover')).toHaveCount(0)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })
})

test.describe('C3 P-6: 이름 변경 + "(Me)"', () => {
  test('P-6a PPT: A가 바꾸면 B에 2초 안에 반영되고 새로고침·재접속에도 유지된다', async ({ browser }) => {
    const f = await freshPptx('c3p6a', 0)
    const t = await twoPages(browser)
    try {
      await openFile(t.pageA, f.name, 'edit')
      await openFile(t.pageB, f.name, 'view')
      await expect(peer(t.pageB, 'u-ada')).toBeVisible({ timeout: 15000 })
      // 팝오버에서 이름을 바꾼다.
      await t.pageA.getByTestId('collab-avatars').click({ timeout: 10000 })
      await t.pageA.getByTestId('collab-rename-edit').click({ timeout: 10000 })
      await t.pageA.getByTestId('collab-rename-input').fill('Ada2')
      await expect(t.pageA.getByTestId('collab-rename-submit')).toBeEnabled()
      await t.pageA.getByTestId('collab-rename-submit').click({ timeout: 10000 })
      // B 화면에 2초 안에 반영된다.
      await expect(t.pageB.getByTestId('collab-peer').filter({ hasText: 'Ada2' })).toHaveCount(1, { timeout: 15000 })
      // A 화면에는 "(Me)"가 붙는다.
      await expect(t.pageA.getByText('Ada2 (Me)').first()).toBeVisible({ timeout: 5000 })
      // B 화면의 A 행에는 "(Me)"가 없다.
      const aRowName = t.pageB.getByTestId('collab-presence-row').filter({ hasText: 'Ada2' }).getByTestId('collab-peer-name')
      await expect(aRowName).toHaveText('Ada2')
      // 새로고침해도 유지된다.
      await t.pageA.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
      await gotoApp(t.pageA)
      await openFile(t.pageA, f.name, 'edit')
      await expect(t.pageB.getByTestId('collab-peer').filter({ hasText: 'Ada2' })).toHaveCount(1, { timeout: 30000 })
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('P-6b XLSX: A가 바꾸면 B에 반영되고 "(Me)" 규칙을 지킨다. 빈 값이면 버튼이 막힌다', async ({ browser }) => {
    const f = freshXlsx('c3p6b', 0)
    const t = await twoPages(browser)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
        await t.pageA.getByTestId('collab-avatars').click({ timeout: 10000 })
        await t.pageA.getByTestId('collab-rename-edit').click({ timeout: 10000 })
        const input = t.pageA.getByTestId('collab-rename-input')
      await input.fill('')
      await expect(t.pageA.getByTestId('collab-rename-submit')).toBeDisabled()
      await input.fill('Ada2')
      await expect(t.pageA.getByTestId('collab-rename-submit')).toBeEnabled()
      await t.pageA.getByTestId('collab-rename-submit').click({ timeout: 10000 })
      await expect(t.pageB.getByTestId('collab-peer').filter({ hasText: 'Ada2' })).toHaveCount(1, { timeout: 15000 })
      await expect(t.pageA.getByText('Ada2 (Me)').first()).toBeVisible({ timeout: 5000 })
      const aRowName = t.pageB.getByTestId('collab-presence-row').filter({ hasText: 'Ada2' }).getByTestId('collab-peer-name')
      await expect(aRowName).toHaveText('Ada2')
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })
})

test.describe('C3 P-7: 따라가기', () => {
  test('P-7a PPT: A가 3번 연속 이동해도 B의 따라가기가 유지된다', async ({ browser }) => {
    const f = await freshPptx('c3p7a', 0)
    const t = await twoPages(browser)
    try {
      await openFile(t.pageA, f.name, 'edit')
      await openFile(t.pageB, f.name, 'view')
      await expect(peer(t.pageB, 'u-ada')).toBeVisible({ timeout: 15000 })
      // B가 A를 따라간다 (팝오버에서).
      await t.pageB.getByTestId('collab-avatars').click({ timeout: 10000 })
      await t.pageB.getByTestId('collab-presence-row').filter({ hasText: 'Ada' }).getByTestId('collab-follow').click({ timeout: 10000 })
      await t.pageB.keyboard.press('Escape')
      for (const n of [2, 3, 1]) {
        await gotoSlide(t.pageA, n)
        const adaOnB = peer(t.pageB, 'u-ada')
        await expect(adaOnB).toHaveAttribute('data-slide', String(n), { timeout: 15000 })
      }
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('P-7b PPT: B가 클릭하면 해제되고, A가 나가면 해제된다', async ({ browser }) => {
    const f = await freshPptx('c3p7b', 0)
    const t = await twoPages(browser)
    try {
      await openFile(t.pageA, f.name, 'edit')
      await openFile(t.pageB, f.name, 'view')
      await expect(peer(t.pageB, 'u-ada')).toBeVisible({ timeout: 15000 })
      await t.pageB.getByTestId('collab-avatars').click({ timeout: 10000 })
      await t.pageB.getByTestId('collab-presence-row').filter({ hasText: 'Ada' }).getByTestId('collab-follow').click({ timeout: 10000 })
      const navBefore = await t.pageB.evaluate(() => (window as unknown as { __c3FollowNav?: number }).__c3FollowNav ?? 0)
      await gotoSlide(t.pageA, 2)
      const adaOnB = peer(t.pageB, 'u-ada')
      await expect(adaOnB).toHaveAttribute('data-slide', '2', { timeout: 15000 })
      // B가 직접 조작하면 해제된다.
      await t.pageB.mouse.click(400, 300)
      await t.pageB.getByTestId('collab-avatars').click({ timeout: 10000 })
      const followBtn = t.pageB.getByTestId('collab-presence-row').filter({ hasText: 'Ada' }).getByTestId('collab-follow')
      await expect(followBtn).toHaveAttribute('aria-pressed', 'false', { timeout: 5000 })
      await t.pageB.keyboard.press('Escape')
      // A가 3으로 가도 B는 따라가지 않는다 (B는 2에 머문다).
      await gotoSlide(t.pageA, 3)
      await expect(peer(t.pageB, 'u-ada')).toHaveAttribute('data-slide', '3', { timeout: 15000 })
      await expect(peer(t.pageA, 'u-grace')).toHaveAttribute('data-slide', '2', { timeout: 10000 })
      const navAfter = await t.pageB.evaluate(() => (window as unknown as { __c3FollowNav?: number }).__c3FollowNav ?? 0)
      expect(navAfter).toBe(navBefore)
      // A가 나가면 B의 팔로우 대상이 사라진다.
      await t.ctxA.close()
      await t.pageB.getByTestId('collab-avatars').click({ timeout: 10000 })
      await expect(t.pageB.getByTestId('collab-presence-row').filter({ hasText: 'Ada' })).toHaveCount(0, { timeout: 20000 })
    } finally {
      await t.ctxB.close().catch(() => {})
    }
  })

  test('P-7c PPT: 서로 따라가도 5초 안에 수렴하고 멈춘다 (루프 없음)', async ({ browser }) => {
    const f = await freshPptx('c3p7c', 0)
    const t = await twoPages(browser)
    try {
      await openFile(t.pageA, f.name, 'edit')
      await openFile(t.pageB, f.name, 'edit')
      await expect(peer(t.pageB, 'u-ada')).toBeVisible({ timeout: 15000 })
      await expect(peer(t.pageA, 'u-grace')).toBeVisible({ timeout: 15000 })
      // 서로 따라간다.
      await t.pageA.getByTestId('collab-avatars').click({ timeout: 10000 })
      await t.pageA.getByTestId('collab-presence-row').filter({ hasText: 'Grace' }).getByTestId('collab-follow').click({ timeout: 10000 })
      await t.pageA.keyboard.press('Escape')
      await t.pageB.getByTestId('collab-avatars').click({ timeout: 10000 })
      await t.pageB.getByTestId('collab-presence-row').filter({ hasText: 'Ada' }).getByTestId('collab-follow').click({ timeout: 10000 })
      await t.pageB.keyboard.press('Escape')
      // A가 움직이면 둘 다 따라오고 수렴한다.
      await gotoSlide(t.pageA, 2)
      await expect(peer(t.pageA, 'u-grace')).toHaveAttribute('data-slide', '2', { timeout: 15000 })
      await expect(peer(t.pageB, 'u-ada')).toHaveAttribute('data-slide', '2', { timeout: 15000 })
      // B가 움직이면 둘 다 따라오고 수렴한다 (발진 없음).
      await gotoSlide(t.pageB, 3)
      await expect(peer(t.pageA, 'u-grace')).toHaveAttribute('data-slide', '3', { timeout: 15000 })
      await expect(peer(t.pageB, 'u-ada')).toHaveAttribute('data-slide', '3', { timeout: 15000 })
      await gotoSlide(t.pageA, 1)
      await expect(peer(t.pageA, 'u-grace')).toHaveAttribute('data-slide', '1', { timeout: 15000 })
      await expect(peer(t.pageB, 'u-ada')).toHaveAttribute('data-slide', '1', { timeout: 15000 })
      // 팔로우 이동 횟수는 상한 이하이다 (발진하면 수십 번이 된다).
      const navs = await t.pageA.evaluate(() => (window as unknown as { __c3FollowNav?: number }).__c3FollowNav ?? 0)
      const navsB = await t.pageB.evaluate(() => (window as unknown as { __c3FollowNav?: number }).__c3FollowNav ?? 0)
      expect(navs + navsB).toBeLessThanOrEqual(12)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('P-7d XLSX: 같은 시트에서 셀만 옮겨도 B 화면이 스크롤된다', async ({ browser }) => {
    const f = freshXlsx('c3p7d', 0)
    const t = await twoPages(browser)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      // B가 A를 따라간다.
      await t.pageB.getByTestId('collab-avatars').click({ timeout: 10000 })
      await t.pageB.getByTestId('collab-presence-row').filter({ hasText: 'Ada' }).getByTestId('collab-follow').click({ timeout: 10000 })
      await t.pageB.keyboard.press('Escape')
      const before = await xlsxScroll(t.pageB)
      // A가 같은 시트에서 멀리 이동한다.
      await t.pageA.evaluate(() => {
        const el = document.querySelector('xlsx-editor') as unknown as { select?: (ref: string) => void } | null
        el?.select?.('Z100')
      })
      // B 화면이 스크롤된다.
      await expect
        .poll(async () => {
          const s = await xlsxScroll(t.pageB)
          return s.top > before.top || s.left > before.left ? 'moved' : 'still'
        }, { timeout: 15000, intervals: [500] })
        .toBe('moved')
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })
})

async function xlsxScroll(page: Page): Promise<{ top: number; left: number }> {
  return page.evaluate(() => {
    const el = document.querySelector('xlsx-editor')
    const root = el?.shadowRoot
    if (!root) return { top: 0, left: 0 }
    let top = 0
    let left = 0
    root.querySelectorAll('*').forEach((n) => {
      const e = n as unknown as { scrollHeight: number; clientHeight: number; scrollTop: number; scrollWidth: number; clientWidth: number; scrollLeft: number }
      if (e.scrollHeight > e.clientHeight + 10) top = Math.max(top, e.scrollTop)
      if (e.scrollWidth > e.clientWidth + 10) left = Math.max(left, e.scrollLeft)
    })
    return { top, left }
  })
}

test.describe('C3 P-8: 탭 묶음', () => {
  test('P-8: 같은 userId 탭 2개는 한 행으로 묶이고 "탭 2"가 표시된다', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    try {
      const f = freshPptx('c3p8', 0)
      const p1 = await ctx.newPage()
      await gotoApp(p1)
      await openFile(p1, f.name, 'edit')
      const p2 = await ctx.newPage()
      await gotoApp(p2)
      await openFile(p2, f.name, 'edit')
      await expect(peer(p1, 'u-ada')).toBeVisible({ timeout: 15000 })
      await p1.getByTestId('collab-avatars').click({ timeout: 10000 })
      await expect(p1.getByRole('listitem', { name: /탭 2/ })).toBeVisible({ timeout: 15000 })
    } finally {
      await ctx.close()
    }
  })
})

test.describe('C3 P-9: 상단 표기 정리', () => {
  test('P-9a PPT: viewer/editor 숫자·"나:"가 없고 collab-presence가 1개, data-owner은 남는다', async ({ browser }) => {
    const f = await freshPptx('c3p9a', 0)
    const t = await twoPages(browser)
    try {
      await openFile(t.pageA, f.name, 'edit')
      await openFile(t.pageB, f.name, 'view')
      await expect(peer(t.pageB, 'u-ada')).toBeVisible({ timeout: 15000 })
      await expect(t.pageB.getByText('viewer -', { exact: false })).toHaveCount(0)
      await expect(t.pageB.getByText('editor -', { exact: false })).toHaveCount(0)
      await expect(t.pageB.getByText(/^나:/)).toHaveCount(0)
      await expect(t.pageB.getByTestId('collab-presence')).toHaveCount(1)
      await expect(t.pageB.locator('[data-testid="collab-peer"][data-owner]')).not.toHaveCount(0)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('P-9b XLSX: viewer/editor 숫자·"나:"가 없고 collab-presence가 1개, data-owner은 남는다', async ({ browser }) => {
    const f = freshXlsx('c3p9b', 0)
    const t = await twoPages(browser)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect(t.pageA.getByText('viewer -', { exact: false })).toHaveCount(0)
      await expect(t.pageA.getByText('editor -', { exact: false })).toHaveCount(0)
      await expect(t.pageA.getByText(/^나:/)).toHaveCount(0)
      await expect(t.pageA.getByTestId('collab-presence')).toHaveCount(1)
      await expect(t.pageA.locator('[data-testid="collab-peer"][data-owner]')).not.toHaveCount(0)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })
})

test.describe('C3-img: 동시편집 중 이미지 편집 잠금', () => {
  test('C3-img-1: 둘이 있을 때 B가 이미지를 옮기면 거부되고 토스트가 뜬다', async ({ browser }) => {
    const errors: string[] = []
    const t = await twoPages(browser)
    const f = freshXlsx('c3img1', 0)
    t.pageB.on('pageerror', (e) => errors.push(String(e && (e as Error).message ? (e as Error).message : e)))
    try {
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      const before = await xlsxImageAnchor(t.pageB)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      // B가 이미지를 옮기려 한다 → 거부된다.
      await xlsxMoveImage(t.pageB, before!.sheet, before!.index, before!.row + 4)
      await expect(t.pageB.getByText('동시편집 중에는 이 편집을 지원하지 않습니다')).toBeVisible({ timeout: 8000 })
      // B 화면의 그림은 그대로다.
      const after = await xlsxImageAnchor(t.pageB)
      expect(after?.row).toBe(before!.row)
      // B가 지금 저장해도 디스크 drawings는 그대로다.
      await clickAppSave(t.pageB)
      await expect.poll(async () => workbookContains(f.abs, `<row>${before!.row}</row>`), { timeout: 10000, intervals: [500] }).toBe(true)
      expect(errors.join('\n')).not.toMatch(/collab-lock/i)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('C3-img-2: owner 혼자 옮긴 것은 저장되고, B가 저장해도 유지된다', async ({ browser }) => {
    const errors: string[] = []
    const t = await twoPages(browser)
    const f = freshXlsx('c3img2', 0)
    t.pageA.on('pageerror', (e) => errors.push(String(e && (e as Error).message ? (e as Error).message : e)))
    try {
      // A 혼자: 이미지 이동이 허용된다 (토스트 없음).
      await openXlsxEditing(t.pageA, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      const before = await xlsxImageAnchor(t.pageA)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      await xlsxMoveImage(t.pageA, before!.sheet, before!.index, before!.row + 4)
      await expect(t.pageA.getByText('동시편집 중에는 이 편집을 지원하지 않습니다')).toHaveCount(0)
      expect((await xlsxImageAnchor(t.pageA))?.row).toBe(before!.row + 4)
      // A가 저장하면 디스크에 남는다.
      await clickAppSave(t.pageA)
      await expect
        .poll(async () => workbookContains(f.abs, `<row>${before!.row + 4}</row>`), { timeout: 20000, intervals: [500] })
        .toBe(true)
      // B가 들어와서 저장해도 유지된다.
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      await clickAppSave(t.pageB)
      await expect.poll(async () => workbookContains(f.abs, `<row>${before!.row + 4}</row>`), { timeout: 20000, intervals: [500] }).toBe(true)
      expect(errors.join('\n')).not.toMatch(/collab-lock/i)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })
})

test.describe('C3 1→2 flush + undo + 해제', () => {
  test('C3-flush: 혼자 옮기고 B가 참가하면 즉시 저장된다 (POST 1건)', async ({ browser }) => {
    const t = await twoPages(browser)
    const f = freshXlsx('c3flush', 0)
    let posts = 0
    const postTimes: number[] = []
    const t0 = Date.now()
    t.pageA.on('request', (r) => {
      if (r.url().includes('/api/collab/save') && r.method() === 'POST') {
        posts += 1
        postTimes.push(Date.now() - t0)
      }
    })
    try {
      await openXlsxEditing(t.pageA, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      const before = await xlsxImageAnchor(t.pageA)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      // A 혼자 이미지를 옮긴다 (자동 저장 예약됨).
      await xlsxMoveImage(t.pageA, before!.sheet, before!.index, before!.row + 4)
      // B가 바로 참가한다 (디바운스 만료 전).
      const joinStart = Date.now() - t0
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      // flush: 디바운스를 기다리지 않고 저장된다. POST는 1건이다.
      await expect
        .poll(async () => ((await workbookContains(f.abs, `<row>${before!.row + 4}</row>`)) ? 'saved' : ''), { timeout: 20000, intervals: [500] })
        .toBe('saved')
      expect(posts).toBe(1)
      console.log(`C3_FLUSH postTimes=${JSON.stringify(postTimes)} joinAt=${joinStart}`)
      // B가 다시 읽으면 이동된 그림이 보인다.
      await t.pageB.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      const seen = await xlsxImageAnchor(t.pageB)
      expect(seen?.row).toBe(before!.row + 4)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('C3-undo: 잠금 중 undo는 거부되고 그림이 그대로다', async ({ browser }) => {
    const errors: string[] = []
    const t = await twoPages(browser)
    const f = freshXlsx('c3undo', 0)
    t.pageA.on('pageerror', (e) => errors.push(String(e && (e as Error).message ? (e as Error).message : e)))
    try {
      await openXlsxEditing(t.pageA, f.name)
      await expect.poll(async () => xlsxActive(t.pageA)).toBe(true)
      const before = await xlsxImageAnchor(t.pageA)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      await xlsxMoveImage(t.pageA, before!.sheet, before!.index, before!.row + 4)
      expect((await xlsxImageAnchor(t.pageA))?.row).toBe(before!.row + 4)
      // B가 들어오면 잠금이 켜진다. A가 Ctrl+Z를 눌러도 되돌릴 수 없다.
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      await t.pageA.locator('xlsx-editor').click({ timeout: 10000 }).catch(() => {})
      await t.pageA.keyboard.press('Control+z')
      await expect(t.pageA.getByText('동시편집 중에는 이 편집을 지원하지 않습니다')).toBeVisible({ timeout: 8000 })
      expect((await xlsxImageAnchor(t.pageA))?.row).toBe(before!.row + 4)
      expect(errors.join('\n')).not.toMatch(/collab-lock/i)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('C3-release: 모두 나가고 혼자 다시 들어오면 이미지 이동이 허용된다', async ({ browser }) => {
    const t = await twoPages(browser)
    const f = freshXlsx('c3rel', 0)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      // 모두 나간다.
      await closeXlsxPreview(t.pageA).catch(() => {})
      await closeXlsxPreview(t.pageB).catch(() => {})
      // A 혼자 다시 들어오면 잠금이 풀려 있다.
      await openXlsxEditing(t.pageA, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      const before = await xlsxImageAnchor(t.pageA)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      await xlsxMoveImage(t.pageA, before!.sheet, before!.index, before!.row + 4)
      await expect(t.pageA.getByText('동시편집 중에는 이 편집을 지원하지 않습니다')).toHaveCount(0)
      expect((await xlsxImageAnchor(t.pageA))?.row).toBe(before!.row + 4)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })
})
