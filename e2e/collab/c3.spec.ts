import { test, expect, type Browser, type BrowserContext, type ConsoleMessage, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { absForRel, backendBase, uniqueRel, uniqueRelWithExt } from './helpers/env'
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
    // lib 저장본은 네임스페이스 접두사를 붙인다(<xdr:row>). 픽스처 원본은
    // 접두사 없이(<row>) 저장돼 있으므로 접두사를 걷어내고도 비교한다.
    const stripped = xml.replace(/<([A-Za-z0-9_]+):/g, '<').replace(/<\/([A-Za-z0-9_]+):/g, '</')
    if (stripped.includes(needle)) return true
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

/**
 * C4: 이미지 찾고·옮기기를 한 evaluate에서 원자적으로 수행한다.
 * 읽기/쓰기를 나누면 lib 재동기화 순간에 모델이 갈아끼워져
 * index가 가리키는 그림이 사라지는 레이스가 있다. row가 기대값과 다르면
 * (이미 옮겨졌거나 모델이 비어 있으면) 건드리지 않고 보고만 한다.
 */
async function xlsxNudgeImage(page: Page, fromRow: number, dRow: number): Promise<{ moved: boolean; row: number; error?: string }> {
  return page.evaluate(
    ([fr, d]) => {
      try {
        const el = document.querySelector('xlsx-editor') as unknown as {
          core?: {
            workbook?: { sheets?: Array<{ drawings?: Array<{ kind?: string; anchor?: { from?: { row?: number } } }> }> }
            session?: { setDrawingAnchor?: (sheet: number, index: number, anchor: unknown) => void }
          }
        } | null
        const sheets = el?.core?.workbook?.sheets ?? []
        for (let s = 0; s < sheets.length; s++) {
          const drawings = sheets[s]?.drawings ?? []
          for (let i = 0; i < drawings.length; i++) {
            if (drawings[i]?.kind !== 'image') continue
            const r = drawings[i]?.anchor?.from?.row
            if (typeof r !== 'number') return { moved: false as const, row: -1 }
            if (r !== fr) return { moved: false as const, row: r }
            const anchor = drawings[i]?.anchor
            if (!anchor) return { moved: false as const, row: r }
            const next = JSON.parse(JSON.stringify(anchor)) as { from: { row: number } }
            next.from.row = r + d
            el?.core?.session?.setDrawingAnchor?.(s, i, next)
            return { moved: true as const, row: r + d }
          }
        }
        return { moved: false as const, row: -1 }
      } catch (e) {
        return { moved: false as const, row: -1, error: e instanceof Error ? e.message : String(e) }
      }
    },
    [fromRow, dRow] as const,
  )
}
/**
 * C3: lib core에 직접 닿는다 (그리드 UI와 같은 ctx.run 경로를 탄다).
 * 가드가 막으면 lib이 throw하므로 여기서 받아낸다 (거부+토스트+롤백이 정상 동작이다).
 * 성공하면 { ok: true }, 거부되면 { ok: false, error } 를 돌려준다.
 */
async function xlsxMoveImage(page: Page, sheet: number, index: number, toRow: number): Promise<{ ok: boolean; error?: string }> {
  return page.evaluate(
    ([s, i, row]) => {
      try {
        const el = document.querySelector('xlsx-editor') as unknown as {
          core?: {
            workbook?: { sheets?: Array<{ drawings?: Array<{ anchor?: unknown }> }> }
            session?: { setDrawingAnchor?: (sheet: number, index: number, anchor: unknown) => void }
          }
        } | null
        const anchor = (el?.core?.workbook?.sheets?.[s] as { drawings?: Array<{ anchor?: unknown }> } | undefined)?.drawings?.[i]?.anchor
        if (!anchor) return { ok: false as const, error: 'no drawing anchor' }
        const next = JSON.parse(JSON.stringify(anchor)) as { from: { row: number } }
        next.from.row = row
        el?.core?.session?.setDrawingAnchor?.(s, i, next)
        return { ok: true as const }
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
      }
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
      // B 화면에 2초 안에 반영된다 (팝오버 행의 이름으로 확인 — 아바타는 이니셜만 보여준다).
      await t.pageB.getByTestId('collab-avatars').click({ timeout: 10000 })
      const aRowName = t.pageB.getByTestId('collab-presence-row').filter({ hasText: 'Ada2' }).getByTestId('collab-peer-name')
      await expect(aRowName).toHaveText('Ada2', { timeout: 15000 })
      // A 화면에는 "(Me)"가 붙는다 (제출하면 팝오버가 닫히므로 다시 연다).
      await t.pageA.getByTestId('collab-avatars').click({ timeout: 10000 })
      await expect(t.pageA.getByTestId('collab-popover')).toBeVisible({ timeout: 5000 })
      await expect(t.pageA.getByText('Ada2 (Me)').first()).toBeVisible({ timeout: 5000 })
      // 새로고침해도 유지된다 (재접속 = 새 세션, 같은 이름).
      await t.pageA.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
      await gotoApp(t.pageA)
      await openFile(t.pageA, f.name, 'edit')
      await expect(t.pageB.getByTestId('collab-presence-row').filter({ hasText: 'Ada2' }).getByTestId('collab-peer-name')).toHaveText('Ada2', { timeout: 30000 })
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
      await t.pageB.getByTestId('collab-avatars').click({ timeout: 10000 })
      const bRowName = t.pageB.getByTestId('collab-presence-row').filter({ hasText: 'Ada2' }).getByTestId('collab-peer-name')
      await expect(bRowName).toHaveText('Ada2', { timeout: 15000 })
      await t.pageA.getByTestId('collab-avatars').click({ timeout: 10000 })
      await expect(t.pageA.getByTestId('collab-popover')).toBeVisible({ timeout: 5000 })
      await expect(t.pageA.getByText('Ada2 (Me)').first()).toBeVisible({ timeout: 5000 })
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
      // nav 기준점은 해제 이후에 잡는다 (그 전 A→2 이동은 정상 따라가기 1회다).
      const navBefore2 = await t.pageB.evaluate(() => (window as unknown as { __c3FollowNav?: number }).__c3FollowNav ?? 0)
      await gotoSlide(t.pageA, 3)
      await expect(peer(t.pageB, 'u-ada')).toHaveAttribute('data-slide', '3', { timeout: 15000 })
      await expect(peer(t.pageA, 'u-grace')).toHaveAttribute('data-slide', '2', { timeout: 10000 })
      const navAfter = await t.pageB.evaluate(() => (window as unknown as { __c3FollowNav?: number }).__c3FollowNav ?? 0)
      expect(navAfter).toBe(navBefore2)
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
      // 같은 userId 탭은 한 행으로 묶인다 (P-6/P-7과 같은 testid+hasText 단언).
      const tabRow = p1.getByTestId('collab-presence-row').filter({ hasText: '탭 2' })
      await expect(tabRow).toHaveCount(1, { timeout: 15000 })
      await expect(tabRow.getByTestId('collab-peer-name')).toHaveText(/탭 2/, { timeout: 5000 })
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
  test('C3-img-1: 둘이 있을 때 B가 이미지를 옮기면 A에 동기화된다 (C4 허용)', async ({ browser }) => {
    const errors: string[] = []
    const t = await twoPages(browser)
    const f = freshXlsx('c3img1', 0)
    t.pageB.on('pageerror', (e) => errors.push(String(e && (e as Error).message ? (e as Error).message : e)))
    try {
      await openXlsxEditingRetry(t.pageA, f.name)
      await openXlsxEditingRetry(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      const before = await xlsxImageAnchor(t.pageB)
      // C3: xlsx lib patches loaded (core guard + ui reveal).
      const xlsxPatches = await t.pageB.evaluate(
        () => (globalThis as unknown as { __ooxmlPatches?: Record<string, string> }).__ooxmlPatches ?? {},
      )
      expect(xlsxPatches.coreXlsx).toBe('C3-guard')
      expect(xlsxPatches.uiXlsx).toBe('X2a-ui')
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      // C4: 개체 이동은 서버 표 + 락으로 동기화된다 (차단 대신 허용).
      // B가 이미지를 옮기면 A에 반영되고, 저장하면 디스크에 남는다.
      await expect.poll(async () => xlsxImageCk(t.pageB), { timeout: 20000, intervals: [500] }).not.toBeNull()
      await expect
        .poll(async () => xlsxNudgeImage(t.pageB, before!.row, 4), { timeout: 20000, intervals: [500] })
        .toMatchObject({ moved: true })
      await expect
        .poll(async () => (await xlsxImageAnchor(t.pageA))?.row, { timeout: 15000, intervals: [500] })
        .toBe(before!.row + 4)
      await clickAppSave(t.pageA)
      await expect.poll(async () => workbookContains(f.abs, `<row>${before!.row + 4}</row>`), { timeout: 10000, intervals: [500] }).toBe(true)
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

  test('C3-undo: 이동 undo는 전파되고 양쪽이 원래대로 돌아간다 (C4 허용)', async ({ browser }) => {
    const errors: string[] = []
    const t = await twoPages(browser)
    const f = freshXlsx('c3undo', 0)
    t.pageA.on('pageerror', (e) => errors.push(String(e && (e as Error).message ? (e as Error).message : e)))
    try {
      await openXlsxEditingRetry(t.pageA, f.name)
      await expect.poll(async () => xlsxActive(t.pageA)).toBe(true)
      const before = await xlsxImageAnchor(t.pageA)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      await expect
        .poll(async () => xlsxNudgeImage(t.pageA, before!.row, 4), { timeout: 20000, intervals: [500] })
        .toMatchObject({ moved: true })
      expect((await xlsxImageAnchor(t.pageA))?.row).toBe(before!.row + 4)
      // B가 들어온 뒤 undo하면 이동이 되돌아가고 B·서버에 전파된다.
      await openXlsxEditingRetry(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      // C4: 이동 undo는 그냥 이동이라 통과한다 (삭제 undo만 막는다).
      const undone = await xlsxUndo(t.pageA)
      expect(undone.ok, `undo should pass (got: ${undone.ok ? 'ok' : undone.error})`).toBe(true)
      await expect
        .poll(async () => (await xlsxImageAnchor(t.pageA))?.row, { timeout: 15000, intervals: [500] })
        .toBe(before!.row)
      await expect
        .poll(async () => (await xlsxImageAnchor(t.pageB))?.row, { timeout: 15000, intervals: [500] })
        .toBe(before!.row)
      expect(errors.join('\n')).not.toMatch(/collab-lock/i)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('C3-undo-comment: 잠금 중 comment undo는 거부되고 토스트 1회', async ({ browser }) => {
    const errors: string[] = []
    const t = await twoPages(browser)
    const f = freshXlsx('c3undoc', 0)
    t.pageA.on('pageerror', (e) => errors.push(String(e && (e as Error).message ? (e as Error).message : e)))
    try {
      await openXlsxEditing(t.pageA, f.name)
      await expect.poll(async () => xlsxActive(t.pageA)).toBe(true)
      // 혼자 코멘트 추가 (허용). P0-1 확인용: B 참가 후 undo가 막히는지 본다.
      const beforeCount = await t.pageA.evaluate(() => {
        const el = document.querySelector('xlsx-editor') as unknown as {
          core?: { workbook?: { sheets?: Array<{ comments?: unknown[] }> } }
        } | null
        return (el?.core?.workbook?.sheets?.[0]?.comments as unknown[] | undefined)?.length ?? -1
      })
      const added = await t.pageA.evaluate(() => {
        const el = document.querySelector('xlsx-editor') as unknown as {
          core?: {
            workbook?: { sheets?: Array<{ comments?: unknown[] }> }
            session?: {
              setComment?: (s: number, at: { row: number; col: number }, text: string, author: string) => unknown
              canUndo?: () => boolean
              undoLabel?: () => string | undefined
            }
          }
        } | null
        el?.core?.session?.setComment?.(0, { row: 0, col: 0 }, 'c3-red-probe', 'Ada')
        return {
          comments: (el?.core?.workbook?.sheets?.[0]?.comments as unknown[] | undefined)?.length ?? -1,
          canUndo: el?.core?.session?.canUndo?.() ?? null,
          label: el?.core?.session?.undoLabel?.() ?? null,
        }
      })
      expect(added).toEqual({ comments: beforeCount + 1, canUndo: true, label: 'New comment' })
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      const undone = await t.pageA.evaluate(() => {
        try {
          const el = document.querySelector('xlsx-editor') as unknown as {
            core?: { session?: { undo?: () => unknown } }
          } | null
          el?.core?.session?.undo?.()
          return { ok: true as const }
        } catch (e) {
          return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
        }
      })
      expect(undone.ok, `comment undo should be blocked (got: ${undone.ok ? 'ok' : undone.error})`).toBe(false)
      await expect(t.pageA.getByText(LOCK_TOAST)).toHaveCount(1, { timeout: 8000 })
      const kept = await t.pageA.evaluate(() => {
        const el = document.querySelector('xlsx-editor') as unknown as {
          core?: {
            workbook?: { sheets?: Array<{ comments?: unknown[] }> }
            session?: { canUndo?: () => boolean; undoLabel?: () => string | undefined }
          }
        } | null
        return {
          comments: (el?.core?.workbook?.sheets?.[0]?.comments as unknown[] | undefined)?.length ?? -1,
          canUndo: el?.core?.session?.canUndo?.() ?? null,
          label: el?.core?.session?.undoLabel?.() ?? null,
        }
      })
      expect(kept).toEqual({ comments: beforeCount + 1, canUndo: true, label: 'New comment' })
      expect(errors.join('\n')).not.toMatch(/collab-lock/i)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('C3-redo-comment: 잠금 중 comment redo는 거부되고 토스트 1회', async ({ browser }) => {
    const errors: string[] = []
    const t = await twoPages(browser)
    const f = freshXlsx('c3redoc', 0)
    t.pageA.on('pageerror', (e) => errors.push(String(e && (e as Error).message ? (e as Error).message : e)))
    try {
      await openXlsxEditing(t.pageA, f.name)
      await expect.poll(async () => xlsxActive(t.pageA)).toBe(true)
      // 혼자 추가 후 혼자 undo (허용) → redo 스택에 'New comment'가 남는다.
      const beforeCount = await t.pageA.evaluate(() => {
        const el = document.querySelector('xlsx-editor') as unknown as {
          core?: { workbook?: { sheets?: Array<{ comments?: unknown[] }> } }
        } | null
        return (el?.core?.workbook?.sheets?.[0]?.comments as unknown[] | undefined)?.length ?? -1
      })
      const setup = await t.pageA.evaluate(() => {
        const el = document.querySelector('xlsx-editor') as unknown as {
          core?: {
            workbook?: { sheets?: Array<{ comments?: unknown[] }> }
            session?: {
              setComment?: (s: number, at: { row: number; col: number }, text: string, author: string) => unknown
              undo?: () => unknown
              canUndo?: () => boolean
              canRedo?: () => boolean
              redoLabel?: () => string | undefined
            }
          }
        } | null
        el?.core?.session?.setComment?.(0, { row: 1, col: 1 }, 'c3-red-probe', 'Ada')
        el?.core?.session?.undo?.()
        return {
          comments: (el?.core?.workbook?.sheets?.[0]?.comments as unknown[] | undefined)?.length ?? -1,
          canUndo: el?.core?.session?.canUndo?.() ?? null,
          canRedo: el?.core?.session?.canRedo?.() ?? null,
          label: el?.core?.session?.redoLabel?.() ?? null,
        }
      })
      expect(setup).toEqual({ comments: beforeCount, canUndo: false, canRedo: true, label: 'New comment' })
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      const redone = await t.pageA.evaluate(() => {
        try {
          const el = document.querySelector('xlsx-editor') as unknown as {
            core?: { session?: { redo?: () => unknown } }
          } | null
          el?.core?.session?.redo?.()
          return { ok: true as const }
        } catch (e) {
          return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
        }
      })
      expect(redone.ok, `comment redo should be blocked (got: ${redone.ok ? 'ok' : redone.error})`).toBe(false)
      await expect(t.pageA.getByText(LOCK_TOAST)).toHaveCount(1, { timeout: 8000 })
      const kept = await t.pageA.evaluate(() => {
        const el = document.querySelector('xlsx-editor') as unknown as {
          core?: {
            workbook?: { sheets?: Array<{ comments?: unknown[] }> }
            session?: { canRedo?: () => boolean; redoLabel?: () => string | undefined }
          }
        } | null
        return {
          comments: (el?.core?.workbook?.sheets?.[0]?.comments as unknown[] | undefined)?.length ?? -1,
          canRedo: el?.core?.session?.canRedo?.() ?? null,
          label: el?.core?.session?.redoLabel?.() ?? null,
        }
      })
      expect(kept).toEqual({ comments: beforeCount, canRedo: true, label: 'New comment' })
      expect(errors.join('\n')).not.toMatch(/collab-lock/i)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('C3-reconnect: 끊긴 동안 이동이 막히고 돌아오면 동기화된다', async ({ browser }) => {
    const errors: string[] = []
    const t = await twoPages(browser)
    const f = freshXlsx('c3recon', 0)
    t.pageA.on('pageerror', (e) => errors.push(String(e && (e as Error).message ? (e as Error).message : e)))
    try {
      await openXlsxEditingRetry(t.pageA, f.name)
      await openXlsxEditingRetry(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      const before = await xlsxImageAnchor(t.pageA)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      // 둘이 접속한 상태에서 A의 WS를 끊는다. 끊긴 동안은 서버 강제가 안 되니
      // 로컬에서 전부 막힌다 (C4 fail-closed; 조용히 발산하지 않는다).
      await t.pageA.context().setOffline(true)
      for (let i = 0; i < 6; i++) {
        const moved = await xlsxMoveImage(t.pageA, before!.sheet, before!.index, before!.row + 4)
        expect(moved.ok, `offline move ${i} should be blocked (got: ${moved.ok ? 'ok' : moved.error})`).toBe(false)
        await t.pageA.waitForTimeout(500)
      }
      const toasts = await t.pageA.getByText(LOCK_TOAST).count()
      expect(toasts).toBeGreaterThanOrEqual(1)
      // 그림이 그대로다.
      expect((await xlsxImageAnchor(t.pageA))?.row).toBe(before!.row)
      // 온라인으로 돌리면 재연결되고, 이동이 성공해 B에 동기화된다.
      await t.pageA.context().setOffline(false)
      await expect
        .poll(async () => xlsxNudgeImage(t.pageA, before!.row, 4), { timeout: 30000, intervals: [1000] })
        .toMatchObject({ moved: true })
      await expect
        .poll(async () => (await xlsxImageAnchor(t.pageB))?.row, { timeout: 15000, intervals: [500] })
        .toBe(before!.row + 4)
      expect(errors.join('\n')).not.toMatch(/collab-lock/i)
    } finally {
      await t.pageA.context().setOffline(false).catch(() => {})
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
      // 모두 나간다 (reload = 세션 종료 + 선택 해제. 모달 닫기 대신 flush 테스트와 같은 방식).
      await t.pageA.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
      await t.pageB.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
      await gotoApp(t.pageA)
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

/**
 * C4: 시트 개체 잠금·이동 (서버 표 + 락).
 * - red: 개체 op 가드 우회 경로가 없고, 서버 라운드트립이 없으면 아래가 전부 실패한다.
 *   (구 가드는 Move/Delete 를 전부 막아 move POST 0건·B 미반영·undo 미전파가 된다.)
 */
async function apiPost(p: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${backendBase()}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, json: (await r.json().catch(() => null)) as unknown }
}

async function apiGet(p: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${backendBase()}${p}`)
  return { status: r.status, json: (await r.json().catch(() => null)) as any }
}

function countRequests(page: Page, method: string, substr: string): { n: () => number } {
  let n = 0
  const h = (r: { url: () => string; method: () => string }) => {
    if (r.method() === method && r.url().includes(substr)) n += 1
  }
  page.on('request', h as never)
  return { n: () => n }
}

async function xlsxDeleteDrawing(page: Page, sheet: number, index: number): Promise<{ ok: boolean; error?: string }> {
  return page.evaluate(
    ([s, i]) => {
      try {
        const el = document.querySelector('xlsx-editor') as unknown as {
          core?: { session?: { deleteDrawing?: (sheet: number, index: number) => unknown } }
        } | null
        el?.core?.session?.deleteDrawing?.(s, i)
        return { ok: true as const }
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
      }
    },
    [sheet, index] as const,
  )
}

async function xlsxSetCell(page: Page, sheet: number, row: number, col: number, text: string): Promise<unknown> {
  return page.evaluate(
    ([s, r, c, t]) => {
      const el = document.querySelector('xlsx-editor') as unknown as {
        core?: { session?: { setCellInput?: (sheet: number, row: number, col: number, text: string) => unknown } }
      } | null
      return el?.core?.session?.setCellInput?.(s, r, c, t) ?? null
    },
    [sheet, row, col, text] as const,
  )
}

async function xlsxUndo(page: Page): Promise<{ ok: boolean; error?: string }> {
  return page.evaluate(() => {
    try {
      const el = document.querySelector('xlsx-editor') as unknown as {
        core?: { session?: { undo?: () => unknown } }
      } | null
      el?.core?.session?.undo?.()
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

async function xlsxCellValue(page: Page, sheet: number, row: number, col: number): Promise<unknown> {
  return page.evaluate(
    ([s, r, c]) => {
      const el = document.querySelector('xlsx-editor') as unknown as {
        core?: { workbook?: { sheets?: Array<{ rows?: Map<number, Map<number, { value?: unknown }>> }> } }
      } | null
      return el?.core?.workbook?.sheets?.[s]?.rows?.get(r)?.get(c)?.value ?? null
    },
    [sheet, row, col] as const,
  )
}

async function openXlsxEditingRetry(page: Page, name: string): Promise<void> {
  // C4: dev 프록시 간헐 실패(vite http proxy error)로 미리보기가 안 붙으면
  // 한 번만 새로고침 후 재시도한다 (C3 기존 헬퍼는 손대지 않는다).
  try {
    await openXlsxEditing(page, name)
    return
  } catch {
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    await openXlsxEditing(page, name)
  }
}

async function xlsxDrawingsDebug(page: Page): Promise<Array<{ kind: unknown; ck: unknown; row: unknown }>> {
  return page.evaluate(() => {
    const el = document.querySelector('xlsx-editor') as unknown as {
      core?: { workbook?: { sheets?: Array<{ drawings?: Array<{ kind?: unknown; __ck?: unknown; anchor?: { from?: { row?: unknown } } }> }> } }
    } | null
    const out: Array<{ kind: unknown; ck: unknown; row: unknown }> = []
    for (const s of el?.core?.workbook?.sheets ?? []) {
      for (const d of s?.drawings ?? []) out.push({ kind: d?.kind, ck: (d as { __ck?: unknown })?.__ck ?? null, row: d?.anchor?.from?.row ?? null })
    }
    return out
  })
}

/** 앱 콘솔에서 특정 문구를 기다린다 (mismatch 확정 같은 내부 상태 관측용). */
function waitConsole(page: Page, needle: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      page.off('console', h)
      reject(new Error(`console never saw within ${timeoutMs}ms: ${needle}`))
    }, timeoutMs)
    const h = (m: ConsoleMessage) => {
      try {
        if (m.text().includes(needle)) {
          clearTimeout(timer)
          page.off('console', h)
          resolve()
        }
      } catch {
        /* 무시 */
      }
    }
    page.on('console', h)
  })
}

/** 이미지 drawings의 __ck (서버 키). kind 어휘와 무관하게 이미지를 직접 찾는다. */
async function xlsxImageCk(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector('xlsx-editor') as unknown as {
      core?: { workbook?: { sheets?: Array<{ drawings?: Array<{ kind?: unknown; __ck?: unknown }> }> } }
    } | null
    for (const s of el?.core?.workbook?.sheets ?? []) {
      for (const d of s?.drawings ?? []) {
        if (d?.kind === 'image' && typeof d.__ck === 'string') return d.__ck as string
      }
    }
    return null
  })
}

/** 개체 DOM에 진짜 pointerdown을 날린다 (앱의 캡처 리스너 → activeKey + 락 요청). */
async function xlsxPointerDownObject(page: Page, index: number): Promise<boolean> {
  return page.evaluate(
    (i) => {
      try {
        const el = document.querySelector('xlsx-editor') as unknown as { shadowRoot?: ShadowRoot | null } | null
        const root = el?.shadowRoot ?? document
        const target = root.querySelector(`.xg-obj[data-index="${i}"]`)
        if (!target) return false
        target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
        return true
      } catch {
        return false
      }
    },
    index as const,
  )
}

/** rooms 목록에서 rel로 roomId를 찾는다 (읽기 전용, 방 생성 없음). */
async function roomIdByRel(rel: string): Promise<string> {
  const r = await apiGet('/api/collab/rooms')
  expect(r.status).toBe(200)
  const list = (r.json as { rooms?: Array<{ roomId?: unknown; rel?: unknown; path?: unknown }> }).rooms ?? []
  const leaf = rel.split('/').pop()
  const hit = list.find((x) => x.rel === rel || (typeof x.path === 'string' && x.path.replace(/\\/g, '/').endsWith(`/${leaf}`)))
  expect(hit?.roomId, `room for ${rel} should exist`).toBeTruthy()
  return hit?.roomId as string
}

test.describe('C4: 개체 잠금·이동 (서버 표 + 락)', () => {
  test('C4-mismatch: 순서가 어긋나면 개체 op 전부 막고 move 요청 0건', async ({ browser }) => {
    const f = freshXlsx('c4mis', 0)
    // 방을 먼저 열고 서버에 잘못된 순서를 심는다 (첫 기록자 승리).
    // 해시는 session 응답의 lastHash를 그대로 쓴다 (앱의 baseHash와 동일 보장).
    const sess = await apiPost('/api/collab/session', { path: f.abs })
    expect(sess.status).toBe(200)
    const sessBody = sess.json as { roomId?: unknown; lastHash?: unknown }
    const roomId = sessBody.roomId
    const lastHash = sessBody.lastHash
    expect(typeof roomId === 'string' && roomId, 'session returns roomId').toBeTruthy()
    expect(typeof lastHash === 'string' && lastHash, 'session returns lastHash').toBeTruthy()
    const poison = await apiPost(`/api/collab/${roomId}/objects/register`, {
      hash: lastHash,
      // 개수 자체가 어긋나게 2건을 심는다 (kind 어휘와 무관하게 확정 mismatch).
      items: [
        { sheet: 0, kind: 'chart' },
        { sheet: 0, kind: 'chart' },
      ],
    })
    expect(poison.status).toBe(200)
    const t = await twoPages(browser)
    // 앱은 GET으로 독순서를 읽고 어긋나면 등록 POST 없이 mismatch 확정한다.
    const getObjects = countRequests(t.pageA, 'GET', '/objects')
    const movePosts = countRequests(t.pageA, 'POST', '/move')
    // mismatch 확정(console.warn)을 먼저 기다린다 (등록 재시도 레이스 제거).
    const mismatchSeen = waitConsole(t.pageA, 'order mismatch', 25000)
    try {
      await openXlsxEditingRetry(t.pageA, f.name)
      await openXlsxEditingRetry(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(() => Promise.resolve(getObjects.n()), { timeout: 15000, intervals: [500] }).toBeGreaterThanOrEqual(1)
      await mismatchSeen
      const before = await xlsxImageAnchor(t.pageA)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      // 가드가 막으므로 이동 시도는 거부된다.
      const moved = await xlsxMoveImage(t.pageA, before!.sheet, before!.index, before!.row + 4)
      expect(moved.ok, `mismatch move should be blocked (got: ${moved.ok ? 'ok' : moved.error})`).toBe(false)
      // 모델 교체 순간 빈 읽기를 흡수하려고 poll로 확인한다.
      await expect
        .poll(async () => (await xlsxImageAnchor(t.pageA))?.row, { timeout: 10000, intervals: [500] })
        .toBe(before!.row)
      // move 요청은 한 건도 나가지 않는다 (서버 truth와 무관하게 클라이언트가 막는다).
      await expect.poll(() => Promise.resolve(movePosts.n()), { timeout: 5000, intervals: [250] }).toBe(0)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('C4-move: A가 이미지를 옮기면 B에 반영되고 서버 anchor가 바뀐다', async ({ browser }) => {
    const f = freshXlsx('c4move', 0)
    const t = await twoPages(browser)
    const movePostsA = countRequests(t.pageA, 'POST', '/move')
    const movePostsB = countRequests(t.pageB, 'POST', '/move')
    try {
      await openXlsxEditingRetry(t.pageA, f.name)
      await openXlsxEditingRetry(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      // 양쪽 등록·태그 완료 대기 (서버 순서 확정 후 __ck 부착).
      await expect.poll(async () => xlsxImageCk(t.pageA), { timeout: 20000, intervals: [500] }).not.toBeNull()
      await expect.poll(async () => xlsxImageCk(t.pageB), { timeout: 20000, intervals: [500] }).not.toBeNull()
      const key = await xlsxImageCk(t.pageA)
      const before = await xlsxImageAnchor(t.pageA)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      // 원자 nudge를 poll한다 (lib 재동기화 순간 모델 교체 레이스 흡수).
      await expect
        .poll(async () => xlsxNudgeImage(t.pageA, before!.row, 4), { timeout: 20000, intervals: [500] })
        .toMatchObject({ moved: true })
      expect((await xlsxImageAnchor(t.pageA))?.row).toBe(before!.row + 4)
      // 서버로 move가 전송된다 (디바운스 500ms + 체인).
      await expect.poll(() => Promise.resolve(movePostsA.n()), { timeout: 15000, intervals: [500] }).toBeGreaterThanOrEqual(1)
      // 서버 truth 먼저: 같은 방 GET으로 anchor 확인 (성공 여부와 B 반영을 분리한다).
      const roomId = await roomIdByRel(f.rel)
      await expect
        .poll(async () => {
          const st = await apiGet(`/api/collab/${roomId}/objects`)
          if (st.status !== 200) return -2
          const objs = (st.json as { objects?: Array<{ key?: unknown; anchor?: { from?: { row?: unknown } } }> }).objects ?? []
          return objs.find((o) => o.key === key)?.anchor?.from?.row ?? -1
        }, { timeout: 15000, intervals: [500] })
        .toBe(before!.row + 4)
      // B에 반영된다 (WS 102 → in-place anchor 교체).
      await expect
        .poll(async () => (await xlsxImageAnchor(t.pageB))?.row, { timeout: 15000, intervals: [500] })
        .toBe(before!.row + 4)
      // 메아리 없음: B는 받아서 적용만 하고 절대 다시 보내지 않는다.
      expect(movePostsB.n(), 'B must not echo object moves').toBe(0)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('C4-lock: 남이 잡은 개체는 거부·토스트·원복되고, 풀면 성공한다', async ({ browser }) => {
    const f = freshXlsx('c4lock', 0)
    const t = await twoPages(browser)
    const movePostsA = countRequests(t.pageA, 'POST', '/move')
    try {
      await openXlsxEditingRetry(t.pageA, f.name)
      await openXlsxEditingRetry(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxImageCk(t.pageA), { timeout: 20000, intervals: [500] }).not.toBeNull()
      await expect.poll(async () => xlsxImageCk(t.pageB), { timeout: 20000, intervals: [500] }).not.toBeNull()
      // 홀더 이름 토스트를 위해 presence 동기화를 기다린다 (XLSX peer id는 숫자 clientId).
      await expect
        .poll(async () => t.pageA.getByTestId('collab-peer').count(), { timeout: 15000, intervals: [500] })
        .toBe(2)
      const key = await xlsxImageCk(t.pageA)
      const before = await xlsxImageAnchor(t.pageA)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      const roomId = await roomIdByRel(f.rel)
      // B가 개체를 직접 눌러 락을 잡는다 (진짜 pointerdown 경로: activeKey + 락 요청).
      await expect
        .poll(async () => xlsxPointerDownObject(t.pageB, before!.index), { timeout: 15000, intervals: [500] })
        .toBe(true)
      await expect
        .poll(async () => {
          const st = await apiGet(`/api/collab/${roomId}/objects`)
          if (st.status !== 200) return 0
          const objs = (st.json as { objects?: Array<{ key?: unknown; lock?: { clientId?: unknown } | null }> }).objects ?? []
          const got = objs.find((o) => o.key === key)?.lock?.clientId
          return typeof got === 'number' ? got : 0
        }, { timeout: 15000, intervals: [500] })
        .toBeGreaterThan(0)
      // A는 로컬로 옮겨지지만 서버 409 → 토스트 + 원복된다.
      const target = before!.row + 4
      const serverAnchorOf = async (): Promise<unknown> => {
        const st = await apiGet(`/api/collab/${roomId}/objects`)
        const objs = (st.json as { objects?: Array<{ key?: unknown; anchor?: unknown }> }).objects ?? []
        return objs.find((o) => o.key === key)?.anchor ?? null
      }
      const serverBefore = JSON.stringify(await serverAnchorOf())
      const tried = await xlsxNudgeImage(t.pageA, before!.row, 4)
      expect(tried.moved, `local move should apply (got ${JSON.stringify(tried)})`).toBe(true)
      await expect.poll(() => Promise.resolve(movePostsA.n()), { timeout: 15000, intervals: [500] }).toBeGreaterThanOrEqual(1)
      await expect(t.pageA.getByText('Grace가 편집 중입니다')).toHaveCount(1, { timeout: 10000 })
      await expect
        .poll(async () => (await xlsxImageAnchor(t.pageA))?.row, { timeout: 15000, intervals: [500] })
        .toBe(before!.row)
      // 서버 anchor는 그대로다 (등록 직후 null일 수도 있다).
      expect(JSON.stringify(await serverAnchorOf())).toBe(serverBefore)
      // B가 풀면 A가 옮겨진다 (서버가 준 lockId로 해제).
      const stAfter = await apiGet(`/api/collab/${roomId}/objects`)
      const objsAfter = (stAfter.json as { objects?: Array<{ key?: unknown; lock?: { lockId?: unknown } | null }> }).objects ?? []
      const lockId = objsAfter.find((o) => o.key === key)?.lock?.lockId
      expect(typeof lockId === 'string' && lockId).toBeTruthy()
      const unlock = await (async () => {
        const r = await fetch(`${backendBase()}/api/collab/${roomId}/objects/${key}/lock`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lockId }),
        })
        return { status: r.status, json: (await r.json().catch(() => null)) as unknown }
      })()
      expect(unlock.status).toBe(200)
      await expect
        .poll(async () => xlsxNudgeImage(t.pageA, before!.row, 4), { timeout: 20000, intervals: [500] })
        .toMatchObject({ moved: true })
      await expect
        .poll(async () => (await xlsxImageAnchor(t.pageB))?.row, { timeout: 15000, intervals: [500] })
        .toBe(target)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('C4-delete: A가 이미지를 지우면 B에 반영되고 서버가 deleted를 기록', async ({ browser }) => {
    const f = freshXlsx('c4del', 0)
    const t = await twoPages(browser)
    try {
      await openXlsxEditingRetry(t.pageA, f.name)
      await openXlsxEditingRetry(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxImageCk(t.pageA), { timeout: 20000, intervals: [500] }).not.toBeNull()
      await expect.poll(async () => xlsxImageCk(t.pageB), { timeout: 20000, intervals: [500] }).not.toBeNull()
      const key = await xlsxImageCk(t.pageA)
      const before = await xlsxImageAnchor(t.pageA)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      const del = await xlsxDeleteDrawing(t.pageA, before!.sheet, before!.index)
      expect(del.ok, `delete should pass (got: ${del.ok ? 'ok' : del.error})`).toBe(true)
      await expect.poll(async () => xlsxImageAnchor(t.pageA), { timeout: 10000, intervals: [500] }).toBeNull()
      // 서버 truth: deleted 플래그.
      const roomId = await roomIdByRel(f.rel)
      await expect
        .poll(async () => {
          const st = await apiGet(`/api/collab/${roomId}/objects`)
          if (st.status !== 200) return 'no-room'
          const objs = (st.json as { objects?: Array<{ key?: unknown; deleted?: unknown }> }).objects ?? []
          return objs.find((o) => o.key === key)?.deleted ?? 'no-key'
        }, { timeout: 15000, intervals: [500] })
        .toBe(true)
      // B에 반영된다.
      await expect.poll(async () => xlsxImageAnchor(t.pageB), { timeout: 15000, intervals: [500] }).toBeNull()
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('C4-move-undo: 이동 undo가 전파되고 메아리가 없다', async ({ browser }) => {
    const f = freshXlsx('c4undo', 0)
    const t = await twoPages(browser)
    const movePostsA = countRequests(t.pageA, 'POST', '/move')
    const movePostsB = countRequests(t.pageB, 'POST', '/move')
    try {
      await openXlsxEditingRetry(t.pageA, f.name)
      await openXlsxEditingRetry(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxImageCk(t.pageA), { timeout: 20000, intervals: [500] }).not.toBeNull()
      await expect.poll(async () => xlsxImageCk(t.pageB), { timeout: 20000, intervals: [500] }).not.toBeNull()
      const key = await xlsxImageCk(t.pageA)
      const before = await xlsxImageAnchor(t.pageA)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      const target = before!.row + 4
      await expect
        .poll(async () => xlsxNudgeImage(t.pageA, before!.row, 4), { timeout: 20000, intervals: [500] })
        .toMatchObject({ moved: true })
      await expect
        .poll(async () => (await xlsxImageAnchor(t.pageB))?.row, { timeout: 15000, intervals: [500] })
        .toBe(target)
      // A가 undo하면 이동이 되돌아가고 B·서버에 전파된다 (undo도 그냥 이동).
      const undone = await xlsxUndo(t.pageA)
      expect(undone.ok, `undo should pass (got: ${undone.ok ? 'ok' : undone.error})`).toBe(true)
      await expect
        .poll(async () => (await xlsxImageAnchor(t.pageA))?.row, { timeout: 15000, intervals: [500] })
        .toBe(before!.row)
      await expect
        .poll(async () => (await xlsxImageAnchor(t.pageB))?.row, { timeout: 15000, intervals: [500] })
        .toBe(before!.row)
      const roomId = await roomIdByRel(f.rel)
      await expect
        .poll(async () => {
          const st = await apiGet(`/api/collab/${roomId}/objects`)
          if (st.status !== 200) return -2
          const objs = (st.json as { objects?: Array<{ key?: unknown; anchor?: { from?: { row?: unknown } } }> }).objects ?? []
          return objs.find((o) => o.key === key)?.anchor?.from?.row ?? -1
        }, { timeout: 15000, intervals: [500] })
        .toBe(before!.row)
      // 이동 1 + undo 1 = A 2건, B는 0건 (메아리 없음).
      expect(movePostsA.n()).toBeGreaterThanOrEqual(2)
      expect(movePostsB.n(), 'B must not echo object moves').toBe(0)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('C4-delete-undo-blocked: 삭제 undo는 막히고 삭제가 유지된다', async ({ browser }) => {
    const f = freshXlsx('c4delu', 0)
    const t = await twoPages(browser)
    try {
      await openXlsxEditingRetry(t.pageA, f.name)
      await openXlsxEditingRetry(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxImageCk(t.pageA), { timeout: 20000, intervals: [500] }).not.toBeNull()
      await expect.poll(async () => xlsxImageCk(t.pageB), { timeout: 20000, intervals: [500] }).not.toBeNull()
      const before = await xlsxImageAnchor(t.pageA)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      const del = await xlsxDeleteDrawing(t.pageA, before!.sheet, before!.index)
      expect(del.ok, `delete should pass (got: ${del.ok ? 'ok' : del.error})`).toBe(true)
      await expect.poll(async () => xlsxImageAnchor(t.pageA), { timeout: 10000, intervals: [500] }).toBeNull()
      // 삭제 undo는 가드가 막는다 (서버 부활 API 없이 되살리면 발산).
      const undone = await xlsxUndo(t.pageA)
      expect(undone.ok, 'delete undo should be blocked').toBe(false)
      await expect(t.pageA.getByText(LOCK_TOAST)).toHaveCount(1, { timeout: 8000 })
      await expect.poll(async () => xlsxImageAnchor(t.pageA), { timeout: 10000, intervals: [500] }).toBeNull()
      await expect.poll(async () => xlsxImageAnchor(t.pageB), { timeout: 10000, intervals: [500] }).toBeNull()
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('C4-late-join: 늦게 들어와도 서버 진실을 따라잡는다', async ({ browser }) => {
    const f = freshXlsx('c4late', 0)
    const t = await twoPages(browser)
    const ctxC = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    try {
      await seedUser(ctxC, { id: 'u-ivan', name: 'Ivan', color: '#9333ea' })
      const pageC = await ctxC.newPage()
      await gotoApp(pageC)
      await openXlsxEditingRetry(t.pageA, f.name)
      await openXlsxEditingRetry(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxImageCk(t.pageA), { timeout: 20000, intervals: [500] }).not.toBeNull()
      const before = await xlsxImageAnchor(t.pageA)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      const target = before!.row + 4
      await expect
        .poll(async () => xlsxNudgeImage(t.pageA, before!.row, 4), { timeout: 20000, intervals: [500] })
        .toMatchObject({ moved: true })
      const key = await xlsxImageCk(t.pageA)
      const roomId = await roomIdByRel(f.rel)
      await expect
        .poll(async () => {
          const st = await apiGet(`/api/collab/${roomId}/objects`)
          if (st.status !== 200) return -2
          const objs = (st.json as { objects?: Array<{ key?: unknown; anchor?: { from?: { row?: unknown } } }> }).objects ?? []
          return objs.find((o) => o.key === key)?.anchor?.from?.row ?? -1
        }, { timeout: 15000, intervals: [500] })
        .toBe(target)
      // C가 늦게 들어온다: 디스크·참가 시점과 무관하게 서버 진실로 수렴한다.
      await openXlsxEditingRetry(pageC, f.name)
      await expect.poll(async () => xlsxActive(pageC), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect
        .poll(async () => (await xlsxImageAnchor(pageC))?.row, { timeout: 20000, intervals: [500] })
        .toBe(target)
      // 같은 순서 → 같은 키를 공유한다.
      await expect.poll(async () => xlsxImageCk(pageC), { timeout: 20000, intervals: [500] }).toBe(key)
    } finally {
      await ctxC.close().catch(() => {})
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('C4-leave-release: 탭을 닫으면 락이 풀려 상대가 옮길 수 있다', async ({ browser }) => {
    const f = freshXlsx('c4leave', 0)
    const t = await twoPages(browser)
    const movePostsA = countRequests(t.pageA, 'POST', '/move')
    try {
      await openXlsxEditingRetry(t.pageA, f.name)
      await openXlsxEditingRetry(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxImageCk(t.pageA), { timeout: 20000, intervals: [500] }).not.toBeNull()
      await expect.poll(async () => xlsxImageCk(t.pageB), { timeout: 20000, intervals: [500] }).not.toBeNull()
      await expect
        .poll(async () => t.pageA.getByTestId('collab-peer').count(), { timeout: 15000, intervals: [500] })
        .toBe(2)
      const key = await xlsxImageCk(t.pageA)
      const before = await xlsxImageAnchor(t.pageA)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      const target = before!.row + 4
      const roomId = await roomIdByRel(f.rel)
      // B가 개체를 직접 눌러 락을 잡는다 (진짜 pointerdown 경로).
      await expect
        .poll(async () => xlsxPointerDownObject(t.pageB, before!.index), { timeout: 15000, intervals: [500] })
        .toBe(true)
      await expect
        .poll(async () => {
          const st = await apiGet(`/api/collab/${roomId}/objects`)
          if (st.status !== 200) return 0
          const objs = (st.json as { objects?: Array<{ key?: unknown; lock?: { clientId?: unknown } | null }> }).objects ?? []
          const got = objs.find((o) => o.key === key)?.lock?.clientId
          return typeof got === 'number' ? got : 0
        }, { timeout: 15000, intervals: [500] })
        .toBeGreaterThan(0)
      // 먼저 경합을 확정한다 (B가 잡은 동안 A는 409 + 토스트 + 원복).
      const tried = await xlsxNudgeImage(t.pageA, before!.row, target - before!.row)
      expect(tried.moved, `local move should apply (got ${JSON.stringify(tried)})`).toBe(true)
      await expect.poll(() => Promise.resolve(movePostsA.n()), { timeout: 15000, intervals: [500] }).toBeGreaterThanOrEqual(1)
      await expect(t.pageA.getByText('Grace가 편집 중입니다')).toHaveCount(1, { timeout: 10000 })
      await expect
        .poll(async () => (await xlsxImageAnchor(t.pageA))?.row, { timeout: 15000, intervals: [500] })
        .toBe(before!.row)
      // B가 탭을 닫으면 awareness 소멸 → B의 락이 풀린다.
      await t.ctxB.close()
      // A는 풀린 뒤에 옮겨진다 (스스로 재시도).
      await expect
        .poll(
          async () => {
            const cur = await xlsxImageAnchor(t.pageA)
            if (cur && cur.row !== target) await xlsxNudgeImage(t.pageA, cur.row, target - cur.row)
            const st = await apiGet(`/api/collab/${roomId}/objects`)
            if (st.status !== 200) return -2
            const objs = (st.json as { objects?: Array<{ key?: unknown; anchor?: { from?: { row?: unknown } } }> }).objects ?? []
            return objs.find((o) => o.key === key)?.anchor?.from?.row ?? -1
          },
          { timeout: 30000, intervals: [1000] },
        )
        .toBe(target)
    } finally {
      await t.ctxB.close().catch(() => {})
      await t.ctxA.close()
    }
  })
})
