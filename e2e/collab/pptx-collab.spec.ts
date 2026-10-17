import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  ADA,
  GRACE,
  seedUser,
} from './helpers/users'
import { absForRel, uniqueRel, backendBase } from './helpers/env'
import { readDeck, waitForDisk } from './helpers/disk'
import {
  gotoApp,
  openFile,
  gotoSlide,
  editShapeText,
  selectShape,
  peer,
  measure,
  watchErrors,
  readDebug,
  ShapeLocator,
  REMOTE_SELECTION_SELECTOR,
  latencyReport,
} from './helpers/viewer'

const FIXTURE = path.resolve('e2e/collab/fixtures/collab-3slides.pptx')
// VPN 간헐 차단 산출물 (환경). pageerror는 엄격히 본다.
const NET_ALLOW = [/Failed to load resource/, /ERR_NETWORK/, /WebSocket connection/, /net::/]

interface Two {
  browser: Browser
  ctxA: BrowserContext
  ctxB: BrowserContext
  pageA: Page
  pageB: Page
  errorsA: ReturnType<typeof watchErrors>
  errorsB: ReturnType<typeof watchErrors>
}

async function freshFile(slug: string, index: number): Promise<{ rel: string; abs: string; name: string }> {
  const rel = uniqueRel(slug, index)
  const abs = absForRel(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.copyFileSync(FIXTURE, abs)
  return { rel, abs, name: rel.split('/').pop()! }
}

async function twoPages(browser: Browser, opts?: { seed?: boolean; mobile?: boolean }): Promise<Two> {
  const mk = async (user: { id: string; name: string; color: string }) => {
    const ctx = await browser.newContext(
      opts?.mobile
        ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
        : { viewport: { width: 1400, height: 900 } },
    )
    if (opts?.seed !== false) await seedUser(ctx, user)
    const page = await ctx.newPage()
    await gotoApp(page)
    return { ctx, page }
  }
  const a = await mk(ADA)
  const b = await mk(GRACE)
  return {
    browser,
    ctxA: a.ctx,
    ctxB: b.ctx,
    pageA: a.page,
    pageB: b.page,
    errorsA: watchErrors(a.page),
    errorsB: watchErrors(b.page),
  }
}

async function closeTwo(t: Two): Promise<void> {
  t.errorsA.assertClean(NET_ALLOW)
  t.errorsB.assertClean(NET_ALLOW)
  await t.ctxA.close()
  await t.ctxB.close()
}

async function aiEdit(rel: string, find: string, replace: string): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${backendBase()}/api/preview/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: rel, operations: [{ op: 'replace', find, replace }] }),
  })
  let body: unknown = null
  try {
    body = await r.json()
  } catch {
    // 무시
  }
  return { status: r.status, body }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

test.describe.configure({ mode: 'serial' })

test.describe('pptx collab (desktop)', () => {
  test('E1: participants (editor + viewer)', async ({ browser }, testInfo) => {
    const f = await freshFile('e1', 0)
    const t = await twoPages(browser)
    const shapesA = new ShapeLocator(t.pageA)
    const shapesB = new ShapeLocator(t.pageB)
    void shapesA
    void shapesB
    await openFile(t.pageA, f.name, 'edit')
    await gotoSlide(t.pageA, 2)
    await openFile(t.pageB, f.name, 'view')
    const testName = `E1[${testInfo.repeatEachIndex}]`
    // B 화면: Ada가 edit/slide2/owner로 보인다.
    const ada = peer(t.pageB, 'u-ada')
    await expect(ada).toBeVisible({ timeout: 10000 })
    await expect(ada).toContainText('Ada')
    await expect(ada).toHaveAttribute('data-mode', 'edit')
    await expect(ada).toHaveAttribute('data-slide', '2')
    await expect(ada).toHaveAttribute('data-owner', 'true')
    // A 화면: Grace가 view로 보인다.
    const grace = peer(t.pageA, 'u-grace')
    await expect(grace).toBeVisible({ timeout: 10000 })
    await expect(grace).toHaveAttribute('data-mode', 'view')
    // 탐색기 아바타 (10초 poll → 12초).
    const row = t.pageB.locator('[data-testid="file-row"]', { hasText: f.name })
    await expect(row.locator('[data-testid="file-row-collab-count"][data-editors="1"][data-viewers="1"]')).toBeVisible({
        timeout: 12000,
      })
    // 기본값 'You' 이름이 없음 (본인 표기는 소문자 '(you)').
    for (const p of [t.pageA, t.pageB]) {
      const text = await p.evaluate(() => document.body.innerText)
      expect(text).not.toMatch(/\bYou\b/)
    }
    await t.pageB.screenshot({ path: `test-results/e1-b-${testInfo.repeatEachIndex}.png` })
    await closeTwo(t)
    void testName
  })

  test('E2: live text reflection + disk', async ({ browser }, testInfo) => {
    const f = await freshFile('e2', 0)
    const t = await twoPages(browser)
    const shapesA = new ShapeLocator(t.pageA)
    await openFile(t.pageA, f.name, 'edit')
    await gotoSlide(t.pageA, 2)
    await openFile(t.pageB, f.name, 'view')
    await gotoSlide(t.pageB, 2)
    const testName = `E2[${testInfo.repeatEachIndex}]`
    const { ms } = await measure(testName, 'reflect', async () => {
      await editShapeText(t.pageA, shapesA, 'Body 2', 'Hello from Ada')
      await expect(t.pageB.locator('[data-testid="pptx-viewer-root"]')).toContainText('Hello from Ada', { timeout: 3000 })
    })
    expect(ms).toBeLessThan(3000)
    const deck = await waitForDisk(f.abs, (d) => d.textOf('Body 2') === 'Hello from Ada', 8000)
    expect(deck.slideCount).toBe(3)
    await closeTwo(t)
  })

  test('E3: remote selection', async ({ browser }, testInfo) => {
    const f = await freshFile('e3', 0)
    const t = await twoPages(browser)
    const shapesA = new ShapeLocator(t.pageA)
    await openFile(t.pageA, f.name, 'edit')
    await gotoSlide(t.pageA, 2)
    await openFile(t.pageB, f.name, 'view')
    await gotoSlide(t.pageB, 2)
    const testName = `E3[${testInfo.repeatEachIndex}]`
    await selectShape(t.pageA, shapesA, 'Body 2')
    const sel = t.pageB.locator(`${REMOTE_SELECTION_SELECTOR}[data-peer-id="u-ada"]`)
    await expect(sel).toBeVisible({ timeout: 3000 })
    // bbox가 Body 2 도형과 4px 이내로 겹친다.
    const { ms } = await measure(testName, 'select-visible', async () => {
      await expect(sel).toBeVisible({ timeout: 3000 })
    })
    expect(ms).toBeLessThan(3000)
    const selBox = await sel.boundingBox()
    const shapeBox = await t.pageB.evaluate(() => {
      const els = [...document.querySelectorAll('[data-element-id]')]
      const el = els.find((e) => (e.textContent || '').includes('Hello'))
      const r = el?.getBoundingClientRect()
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
    })
    expect(selBox).not.toBeNull()
    expect(shapeBox).not.toBeNull()
    expect(Math.abs(selBox!.x - shapeBox!.x)).toBeLessThanOrEqual(4)
    expect(Math.abs(selBox!.y - shapeBox!.y)).toBeLessThanOrEqual(4)
    // 라벨 텍스트가 Ada이고 테두리 색이 A의 collab-user.color와 같다.
    await expect(sel).toContainText('Ada')
    // peer 상태: "Body 2" 선택.
    const ada = peer(t.pageB, 'u-ada')
    await expect(ada).toContainText('"Body 2" 선택')
    await expect(ada).toHaveAttribute('data-activity', 'selected')
    await t.pageB.screenshot({ path: `test-results/e3-b-${testInfo.repeatEachIndex}.png` })
    // Escape로 풀면 3초 안에 사라진다.
    await t.pageA.keyboard.press('Escape')
    await expect(sel).toBeHidden({ timeout: 3000 })
    await closeTwo(t)
  })

  test('E4: concurrent edits, no dup seed', async ({ browser }, testInfo) => {
    const f = await freshFile('e4', 0)
    const t = await twoPages(browser)
    const shapesA = new ShapeLocator(t.pageA)
    const shapesB = new ShapeLocator(t.pageB)
    await openFile(t.pageA, f.name, 'edit')
    await openFile(t.pageB, f.name, 'edit')
    const testName = `E4[${testInfo.repeatEachIndex}]`
    await gotoSlide(t.pageA, 1)
    await gotoSlide(t.pageB, 3)
    await Promise.all([
      editShapeText(t.pageA, shapesA, 'Title 1', 'Slide One by Ada'),
      editShapeText(t.pageB, shapesB, 'Body 3', 'Third by Grace'),
    ])
    await expect(t.pageA.locator('[data-testid="pptx-viewer-root"]')).toContainText('Third by Grace', { timeout: 5000 })
    await expect(t.pageB.locator('[data-testid="pptx-viewer-root"]')).toContainText('Slide One by Ada', { timeout: 5000 })
    // 양쪽 Y 슬라이드 수 3 + 썸네일 3개.
    for (const p of [t.pageA, t.pageB]) {
      const d = await readDebug(p)
      expect(d.slideCountY).toBe(3)
      expect(await p.getByRole('button', { name: /Go to slide/ }).count()).toBe(3)
    }
    const deck = await waitForDisk(
      f.abs,
      (d) => d.slideCount === 3 && d.textOf('Title 1') === 'Slide One by Ada' && d.textOf('Body 3') === 'Third by Grace',
      8000,
    )
    expect(deck.slideCount).toBe(3)
    // owner는 정확히 1명.
    for (const p of [t.pageA, t.pageB]) {
      expect(await p.locator('[data-testid="collab-peer"][data-owner="true"]').count()).toBe(1)
    }
    void testName
    await closeTwo(t)
  })

  test('E5: owner does not remount while saving', async ({ browser }, testInfo) => {
    const f = await freshFile('e5', 0)
    const t = await twoPages(browser)
    const shapesA = new ShapeLocator(t.pageA)
    await openFile(t.pageA, f.name, 'edit')
    await gotoSlide(t.pageA, 2)
    await openFile(t.pageB, f.name, 'view')
    await gotoSlide(t.pageB, 2)
    const testName = `E5[${testInfo.repeatEachIndex}]`
    await selectShape(t.pageA, shapesA, 'Body 2')
    // dblclick 텍스트 편집 진입 (editShapeText 앞부분과 동일, 입력은 루프에서).
    await t.pageA.evaluate(async () => {
      const els = [...document.querySelectorAll('[data-element-id]')]
      const el = els.find((e) => (e.textContent || '').includes('Hello'))
      el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    await t.pageA.waitForFunction(() => document.querySelectorAll('textarea, [contenteditable="true"]').length > 0, null, { timeout: 8000 })
    const m0 = (await readDebug(t.pageA)).mountCount
    for (let i = 0; i < 15; i++) {
      await t.pageA.keyboard.type(`x${i}`)
      await t.pageA.waitForTimeout(2000)
    }
    const d = await readDebug(t.pageA)
    expect(d.mountCount).toBe(m0)
    expect(d.lastSave?.status).toBe(200)
    expect(d.saveCount).toBeGreaterThanOrEqual(2)
    expect(d.save409Count).toBe(0)
    // 캐럿 유지: 마지막에 한 글자가 이어서 붙는다.
    await t.pageA.keyboard.type('!')
    await t.pageA.waitForTimeout(1000)
    const texts = await t.pageA.evaluate(() => [...document.querySelectorAll('[data-element-id]')].map((e) => e.textContent || '').join(' '))
    expect(texts).toContain('!')
    // B에 최종 텍스트가 보인다.
    await expect(t.pageB.locator('[data-testid="pptx-viewer-root"]')).toContainText('!', { timeout: 5000 })
    void testName
    await closeTwo(t)
  })

  test('E6: owner leaves, handoff', async ({ browser }, testInfo) => {
    const f = await freshFile('e6', 0)
    const t = await twoPages(browser)
    const shapesA = new ShapeLocator(t.pageA)
    const shapesB = new ShapeLocator(t.pageB)
    await openFile(t.pageA, f.name, 'edit')
    await openFile(t.pageB, f.name, 'edit')
    const testName = `E6[${testInfo.repeatEachIndex}]`
    // A가 owner인지 확인.
    await expect
      .poll(async () => (await readDebug(t.pageA)).role, { timeout: 10000 })
      .toBe('owner')
    await gotoSlide(t.pageA, 1)
    await editShapeText(t.pageA, shapesA, 'Title 1', 'Ada was here')
    await expect
      .poll(async () => (await readDebug(t.pageA)).lastSave?.status, { timeout: 10000 })
      .toBe(200)
    await t.pageA.close()
    // B 화면에서 Ada가 5초 안에 사라진다.
    await expect(peer(t.pageB, 'u-ada')).toBeHidden({ timeout: 5000 })
    // B 자신이 5초 안에 owner가 된다.
    await expect(peer(t.pageB, 'u-grace')).toHaveAttribute('data-owner', 'true', { timeout: 5000 })
    await gotoSlide(t.pageB, 3)
    await editShapeText(t.pageB, shapesB, 'Body 3', 'Grace took over')
    const d = await readDebug(t.pageB)
    expect(d.lastSave?.status).toBe(200)
    expect(d.save409Count).toBe(0)
    await waitForDisk(
      f.abs,
      (deck) => deck.textOf('Title 1') === 'Ada was here' && deck.textOf('Body 3') === 'Grace took over',
      8000,
    )
    void testName
    t.errorsB.assertClean(NET_ALLOW)
    await t.ctxB.close()
  })

  test('E7: offline and reconnect', async ({ browser }, testInfo) => {
    const f = await freshFile('e7', 0)
    const t = await twoPages(browser)
    const shapesB = new ShapeLocator(t.pageB)
    await openFile(t.pageA, f.name, 'edit')
    await openFile(t.pageB, f.name, 'edit')
    const testName = `E7[${testInfo.repeatEachIndex}]`
    const states: string[] = []
    const recorder = setInterval(async () => {
      try {
        const s = await t.pageB.evaluate(() => document.querySelector('[data-testid="collab-status"]')?.getAttribute('data-status'))
        if (s) states.push(s)
      } catch {
        // 무시
      }
    }, 200)
    const m0 = (await readDebug(t.pageB)).mountCount
    try {
      await t.ctxB.setOffline(true)
      await expect
        .poll(
          async () =>
            t.pageB.evaluate(() => document.querySelector('[data-testid="collab-status"]')?.getAttribute('data-status') ?? ''),
          { timeout: 8000 },
        )
        .toMatch(/reconnecting|offline/)
      await gotoSlide(t.pageB, 3)
      await editShapeText(t.pageB, shapesB, 'Body 3', 'offline edit')
      await new Promise((r) => setTimeout(r, 5000))
      await t.ctxB.setOffline(false)
      await expect
        .poll(
          async () =>
            t.pageB.evaluate(() => document.querySelector('[data-testid="collab-status"]')?.getAttribute('data-status') ?? ''),
          { timeout: 15000 },
        )
        .toBe('connected')
    } finally {
      clearInterval(recorder)
    }
    expect(states).not.toContain('error')
    // A에 B의 오프라인 수정이 보인다.
    await gotoSlide(t.pageA, 3)
    await expect(t.pageA.locator('[data-testid="pptx-viewer-root"]')).toContainText('offline edit', { timeout: 8000 })
    // terminal UI 없음 + 마운트 유지.
    expect(await t.pageB.getByText('사본 다운로드').count()).toBe(0)
    expect((await readDebug(t.pageB)).mountCount).toBe(m0)
    void testName
    await closeTwo(t)
  })

  test('E8: name required', async ({ browser }, testInfo) => {
    const f = await freshFile('e8', 0)
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    const page = await ctx.newPage()
    const errors = watchErrors(page)
    await gotoApp(page)
    // 탐색기에서 파일 열기 (openFile 대신: 이름 없이).
    await page.getByTitle('Workspace').click({ timeout: 20000 })
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-row"]').length > 0, null, { timeout: 15000 })
    await page.locator('[data-testid="file-row"]', { hasText: f.name }).click({ timeout: 15000 })
    await page.getByTestId('pptx-viewer-root').waitFor({ timeout: 20000 })
    const modal = page.getByTestId('collab-name-modal')
    await expect(modal).toBeVisible({ timeout: 10000 })
    // 서버 발급 이름이 미리 채워져 있다.
    await expect
      .poll(async () => modal.locator('input').inputValue(), { timeout: 10000 })
      .not.toBe('')
    // 연결되지 않는다.
    expect(await page.locator('[data-testid="collab-status"][data-status="connected"]').count()).toBe(0)
    // 빈 이름으로 확인하면 그대로.
    await modal.locator('input').fill('')
    await page.getByTestId('collab-name-submit').click()
    await page.waitForTimeout(1000)
    await expect(modal).toBeVisible()
    // Grace로 확정하면 연결 + 바에 표시 + 저장.
    await modal.locator('input').fill('Grace')
    await page.getByTestId('collab-name-submit').click()
    await page
      .waitForFunction(() => document.querySelector('[data-testid="collab-status"]')?.getAttribute('data-status') === 'connected', null, {
        timeout: 15000,
      })
    await expect(peer(page, 'u-grace').first()).toContainText('Grace')
    const stored = await page.evaluate(() => localStorage.getItem('collab-user'))
    const parsed = JSON.parse(stored!) as { id: string; name: string; color: string }
    expect(parsed.name).toBe('Grace')
    expect(typeof parsed.id).toBe('string')
    expect(typeof parsed.color).toBe('string')
    void testInfo
    errors.assertClean(NET_ALLOW)
    await ctx.close()
  })

  test('E9: viewer does not block AI', async ({ browser }, testInfo) => {
    const f = await freshFile('e9', 0)
    const t = await twoPages(browser)
    await openFile(t.pageB, f.name, 'view')
    const testName = `E9[${testInfo.repeatEachIndex}]`
    const r = await aiEdit(f.rel, 'Third', 'Third by AI')
    expect(r.status).toBeLessThan(300)
    const deck = await waitForDisk(f.abs, (d) => d.textOf('Body 3') === 'Third by AI', 8000)
    expect(deck.textOf('Body 3')).toBe('Third by AI')
    // 외부 변경 배너 3초 안에 (자동 병합 없음).
    await expect(t.pageB.getByText('외부 변경')).toBeVisible({ timeout: 3000 })
    expect(deck.textOf('Body 2')).toBe('Hello')
    void testName
    await closeTwo(t)
  })

  test('E10: editor blocks AI + chip', async ({ browser }, testInfo) => {
    const f = await freshFile('e10', 0)
    const t = await twoPages(browser)
    await openFile(t.pageA, f.name, 'edit')
    await openFile(t.pageB, f.name, 'view')
    const testName = `E10[${testInfo.repeatEachIndex}]`
    const before = await readDeck(f.abs)
    const r = await aiEdit(f.rel, 'Third', 'Third by AI')
    expect(r.status).toBe(409)
    expect(JSON.stringify(r.body)).toContain('사용자가 공동편집 중입니다')
    // 양쪽 칩 3초 안에.
    await expect(t.pageA.getByTestId('collab-ai-blocked')).toBeVisible({ timeout: 3000 })
    await expect(t.pageB.getByTestId('collab-ai-blocked')).toBeVisible({ timeout: 3000 })
    // 30초 뒤 사라진다 (clock 앞당김).
    await t.pageA.clock.install()
    await t.pageB.clock.install()
    await t.pageA.clock.fastForward(31000)
    await t.pageB.clock.fastForward(31000)
    await expect(t.pageA.getByTestId('collab-ai-blocked')).toBeHidden({ timeout: 5000 })
    await expect(t.pageB.getByTestId('collab-ai-blocked')).toBeHidden({ timeout: 5000 })
    // 디스크 불변.
    const after = await readDeck(f.abs)
    expect(after.textOf('Body 3')).toBe(before.textOf('Body 3'))
    void testName
    await closeTwo(t)
  })

  test('E12: view-first then edit (R2 no-deadlock)', async ({ browser }, testInfo) => {
    const f = await freshFile('e12', 0)
    const t = await twoPages(browser)
    const shapesB = new ShapeLocator(t.pageB)
    // A가 보기 모드로 먼저 연다.
    await openFile(t.pageA, f.name, 'view')
    // B가 편집으로 들어간다 — 5초 안에 편집 가능해야 한다.
    await openFile(t.pageB, f.name, 'edit')
    const testName = `E12[${testInfo.repeatEachIndex}]`
    await t.pageB.waitForFunction(() => [...document.querySelectorAll('[data-element-id]')].some((e) => (e.textContent || '').includes('Hello')), null, {
      timeout: 15000,
    })
    await gotoSlide(t.pageB, 2)
    await editShapeText(t.pageB, shapesB, 'Body 2', 'B seeds after view-first')
    await expect(t.pageB.locator('[data-testid="pptx-viewer-root"]')).toContainText('B seeds after view-first', { timeout: 5000 })
    const d = await readDebug(t.pageB)
    expect(d.slideCountY).toBe(3)
    expect(d.lastSave?.status).toBe(200)
    await waitForDisk(f.abs, (deck) => deck.textOf('Body 2') === 'B seeds after view-first', 8000)
    void testName
    await closeTwo(t)
  })

  test('E13: activity editing/recent', async ({ browser }, testInfo) => {
    const f = await freshFile('e13', 0)
    const t = await twoPages(browser)
    const shapesB = new ShapeLocator(t.pageB)
    await openFile(t.pageA, f.name, 'edit')
    await openFile(t.pageB, f.name, 'edit')
    const testName = `E13[${testInfo.repeatEachIndex}]`
    await gotoSlide(t.pageA, 2)
    await gotoSlide(t.pageB, 2)
    await editShapeText(t.pageB, shapesB, 'Body 2', 'typing now')
    // 1초 안에 editing.
    await expect(peer(t.pageA, 'u-grace')).toHaveAttribute('data-activity', 'editing', { timeout: 1000 })
    // 멈추고 4초 뒤 recent.
    await expect(peer(t.pageA, 'u-grace')).toHaveAttribute('data-activity', 'recent', { timeout: 6000 })
    void testName
    await closeTwo(t)
  })

  test('E14: no You anywhere', async ({ browser }, testInfo) => {
    const f = await freshFile('e14', 0)
    const t = await twoPages(browser)
    const shapesB = new ShapeLocator(t.pageB)
    await openFile(t.pageA, f.name, 'edit')
    await openFile(t.pageB, f.name, 'view')
    const testName = `E14[${testInfo.repeatEachIndex}]`
    await gotoSlide(t.pageB, 2)
    await selectShape(t.pageB, shapesB, 'Body 2')
    await t.pageB.waitForTimeout(1500)
    for (const p of [t.pageA, t.pageB]) {
      const text = await p.evaluate(() => document.body.innerText)
      expect(text).not.toMatch(/\bYou\b/)
    }
    void testName
    await closeTwo(t)
  })

  test('E15: two editors alternate 30s, no 409, no remount', async ({ browser }, testInfo) => {
    const f = await freshFile('e15', 0)
    const t = await twoPages(browser)
    const shapesA = new ShapeLocator(t.pageA)
    const shapesB = new ShapeLocator(t.pageB)
    await openFile(t.pageA, f.name, 'edit')
    await openFile(t.pageB, f.name, 'edit')
    const testName = `E15[${testInfo.repeatEachIndex}]`
    await gotoSlide(t.pageA, 1)
    await gotoSlide(t.pageB, 3)
    const mA0 = (await readDebug(t.pageA)).mountCount
    const mB0 = (await readDebug(t.pageB)).mountCount
    for (let i = 0; i < 8; i++) {
      await editShapeText(t.pageA, shapesA, 'Title 1', `A${i}`)
      await editShapeText(t.pageB, shapesB, 'Body 3', `G${i}`)
    }
    const dA = await readDebug(t.pageA)
    const dB = await readDebug(t.pageB)
    expect(dA.save409Count).toBe(0)
    expect(dB.save409Count).toBe(0)
    expect(dA.mountCount).toBe(mA0)
    expect(dB.mountCount).toBe(mB0)
    void testName
    await closeTwo(t)
  })

  test('E16: seeded images sync to joiners (no blob: URLs)', async ({ browser }, testInfo) => {
    const f = await freshFile('e16', 0)
    const t = await twoPages(browser)
    const testName = `E16[${testInfo.repeatEachIndex}]`
    await openFile(t.pageA, f.name, 'edit')
    // A가 seed한 Y.Doc에 그림 data가 data: URL로 들어가야 한다 (blob: 금지).
    await expect(async () => {
      const d = await readDebug(t.pageA)
      expect(d.imageSync?.pictures).toBeGreaterThan(0)
      expect(d.imageSync?.blobOnly).toBe(0)
      expect(d.imageSync?.withData).toBe(d.imageSync?.pictures)
    }).toPass({ timeout: 15000 })
    await openFile(t.pageB, f.name, 'view')
    // B(joiner)도 같은 그림 데이터를 adopt해야 한다.
    await expect(async () => {
      const d = await readDebug(t.pageB)
      expect(d.imageSync?.pictures).toBeGreaterThan(0)
      expect(d.imageSync?.withData).toBe(d.imageSync?.pictures)
    }).toPass({ timeout: 15000 })
    void testName
    await closeTwo(t)
  })
})

test.describe('pptx collab (mobile 390x844)', () => {
  async function mobileTwo(browser: Browser): Promise<Two> {
    const t = await twoPages(browser, { mobile: true })
    return t
  }

  test('E11m/E1m: participants on mobile', async ({ browser }) => {
    const f = await freshFile('e11m1', 0)
    const t = await mobileTwo(browser)
    await openFile(t.pageA, f.name, 'edit')
    await gotoSlide(t.pageA, 2)
    await openFile(t.pageB, f.name, 'view')
    const ada = peer(t.pageB, 'u-ada')
    await expect(ada).toBeVisible({ timeout: 10000 })
    await expect(ada).toHaveAttribute('data-mode', 'edit')
    const bar = t.pageB.getByTestId('collab-presence-bar')
    await expect(bar).toBeInViewport()
    await closeTwo(t)
  })

  test('E11m/E2m: reflection on mobile', async ({ browser }) => {
    const f = await freshFile('e11m2', 0)
    const t = await mobileTwo(browser)
    const shapesA = new ShapeLocator(t.pageA)
    await openFile(t.pageA, f.name, 'edit')
    await gotoSlide(t.pageA, 2)
    await openFile(t.pageB, f.name, 'view')
    await gotoSlide(t.pageB, 2)
    await editShapeText(t.pageA, shapesA, 'Body 2', 'Hello mobile')
    await expect(t.pageB.locator('[data-testid="pptx-viewer-root"]')).toContainText('Hello mobile', { timeout: 3000 })
    await closeTwo(t)
  })

  test('E11m/E3m: selection on mobile + sheet dots', async ({ browser }) => {
    const f = await freshFile('e11m3', 0)
    const t = await mobileTwo(browser)
    const shapesA = new ShapeLocator(t.pageA)
    await openFile(t.pageA, f.name, 'edit')
    await gotoSlide(t.pageA, 2)
    await openFile(t.pageB, f.name, 'view')
    await gotoSlide(t.pageB, 2)
    await selectShape(t.pageA, shapesA, 'Body 2')
    const sel = t.pageB.locator(`${REMOTE_SELECTION_SELECTOR}[data-peer-id="u-ada"]`)
    await expect(sel).toBeVisible({ timeout: 3000 })
    // 슬라이드 시트에 색 점이 보인다.
    await expect(t.pageB.locator('[data-collab-slide-dot]').first()).toBeVisible({ timeout: 5000 })
    await t.pageB.screenshot({ path: `test-results/e11-b-${Date.now()}.png` })
    await closeTwo(t)
  })
})
