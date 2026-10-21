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
  closePreview,
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

  test.describe.configure({ mode: 'default' })

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

  test('E2f-strict: 2차 편집 직후 닫아도 8초 안에 디스크 반영', async ({ browser }) => {
    // M32: 1차 편집이 디스크에 반영된 걸 확인한 **다음에** 2차 편집을 하고 곧바로 닫는다.
    // 고정 대기를 쓰지 않는다(미리보기 닫기 → 언마운트 flush 경로 검증).
    const f = await freshFile('e2fs', 0)
    const t = await twoPages(browser)
    const shapesA = new ShapeLocator(t.pageA)
    const lines: string[] = []
    t.pageA.on('console', (m) => {
      const x = m.text()
      if (x.includes('[collab-tl]')) lines.push(x)
    })
    // M35 ① 진단: 실패 지점이 1차/2차 어디인지 확정하기 위해 디스크 실제 텍스트를 남긴다.
    const dumpDisk = async (label: string) => {
      try {
        const d = await readDeck(f.abs)
        console.log(
          `E2FS-DISK ${label} body2="${d.textOf('Body 2') ?? ''}" body3="${d.textOf('Body 3') ?? ''}"`,
        )
      } catch (err) {
        console.log(`E2FS-DISK ${label} read-failed ${String(err)}`)
      }
      console.log('E2FS-TL\n' + lines.join('\n'))
    }
    await openFile(t.pageA, f.name, 'edit')
    await gotoSlide(t.pageA, 2)
    await editShapeText(t.pageA, shapesA, 'Body 2', 'First edit')
    // 1차 반영 확인
    try {
      await waitForDisk(f.abs, (d) => d.textOf('Body 2') === 'First edit', 8000)
    } catch (e) {
      await dumpDisk('1st')
      throw e
    }
    // 2차 편집 → 즉시 닫기(지연 0ms)
    await gotoSlide(t.pageA, 3)
    await editShapeText(t.pageA, shapesA, 'Body 3', 'Late edit')
    await closePreview(t.pageA)
    // 8초 안에 디스크 반영
    let deck: Awaited<ReturnType<typeof waitForDisk>>
    try {
      deck = await waitForDisk(f.abs, (d) => d.textOf('Body 3') === 'Late edit', 8000)
    } catch (e) {
      // M33 ① 판정용 출력: 실패 시 closePreview 이후 타임라인을 그대로 남긴다.
      await dumpDisk('2nd')
      throw e
    }
    expect(deck.textOf('Body 2')).toBe('First edit')
    // M32 P0-1: 마지막 저장이 A(this client) 의 것인지 확인한다.
    const start = lines.filter((l) => l.includes('"evt":"save.start"')).pop() ?? ''
    const meta = lines.filter((l) => l.includes('"evt":"meta"')).pop() ?? ''
    const startCid = /"cid":(\d+)/.exec(start)?.[1]
    const metaCid = /"clientId":(\d+)/.exec(meta)?.[1]
    expect(startCid).toBeTruthy()
    expect(startCid).toBe(metaCid)
    await closeTwo(t)
  })

  test('E2r: 원격 편집과 adopt 직후의 로컬 편집이 서로를 되돌리지 않는다', async ({ browser }) => {
    // M32: 위험한 순간(adopt 직후 수십 ms)을 노린다 → 콘솔 이벤트를 **먼저** 대기한다.
    const f = await freshFile('e2r', 0)
    const t = await twoPages(browser)
    const shapesA = new ShapeLocator(t.pageA)
    const shapesB = new ShapeLocator(t.pageB)
    await openFile(t.pageA, f.name, 'edit')
    await openFile(t.pageB, f.name, 'edit')
    await gotoSlide(t.pageA, 2)
    await gotoSlide(t.pageB, 2)
    const adopted = t.pageA.waitForEvent('console', {
      predicate: (m) => m.text().includes('pub.superseded.set'),
      timeout: 20000,
    })
    // B가 원격 편집 → A가 adopt 수신 즉시 다른 도형 편집
    await editShapeText(t.pageB, shapesB, 'Body 2', 'From Grace')
    await adopted
    await gotoSlide(t.pageA, 3)
    await editShapeText(t.pageA, shapesA, 'Body 3', 'From Ada')
    // 디스크에 두 값 모두
    const deck = await waitForDisk(
      f.abs,
      (d) => d.textOf('Body 2') === 'From Grace' && d.textOf('Body 3') === 'From Ada',
      15000,
    )
    expect(deck.textOf('Body 2')).toBe('From Grace')
    expect(deck.textOf('Body 3')).toBe('From Ada')
    // B 화면에서 'From Grace' 가 15초 동안 한 번도 사라지지 않아야 한다(고정 대기 없이).
    let vanished = false
    const deadline = Date.now() + 15000
    await expect
      .poll(
        async () => {
          const txt = await t.pageB.locator('[data-testid="pptx-viewer-root"]').innerText()
          if (!txt.includes('From Grace')) {
            vanished = true
            return 'missing'
          }
          return Date.now() < deadline ? 'pending' : 'ok'
        },
        { timeout: 30000, intervals: [200] },
      )
      .toBe('ok')
    expect(vanished).toBe(false)
    await closeTwo(t)
  })

  test.skip('E2r-legacy: superseded 되돌림(구버전 — 고정 대기 사용, M32에서 대체됨)', async ({
    browser,
  }) => {
    // M25: superseded 가드를 "직전 상태" 기준으로 바꾼 뒤 생길 수 있는 회귀 —
    // 원격 편집(B)이 adopt 된 직후 로컬 편집(A)이 원격 편집을 되돌리면 데이터 유실이다.
    const f = await freshFile('e2r', 0)
    const t = await twoPages(browser)
    const shapesA = new ShapeLocator(t.pageA)
    const shapesB = new ShapeLocator(t.pageB)
    await openFile(t.pageA, f.name, 'edit')
    await openFile(t.pageB, f.name, 'edit')
    await gotoSlide(t.pageA, 2)
    await gotoSlide(t.pageB, 2)
    // B가 슬라이드 2의 Body 2 를 수정한다(원격 편집).
    await editShapeText(t.pageB, shapesB, 'Body 2', 'From Grace')
    // A가 adopt 직후 **다른 슬라이드**(3)의 Body 3 를 편집한다(로컬 편집).
    await gotoSlide(t.pageA, 3)
    await editShapeText(t.pageA, shapesA, 'Body 3', 'From Ada')
    await t.pageA.waitForTimeout(3000)
    // B의 화면에 'From Grace' 가 유지되어야 한다(되돌림 금지).
    await expect(t.pageB.locator('[data-testid="pptx-viewer-root"]')).toContainText('From Grace', { timeout: 5000 })
    // 디스크에도 둘 다 반영되어야 한다.
    const deck = await waitForDisk(f.abs, (d) => d.textOf('Body 2') === 'From Grace', 8000)
    expect(deck.textOf('Body 3')).toBe('From Ada')
    await closeTwo(t)
  })

  test('E2: live text reflection + disk', async ({ browser }, testInfo) => {
    // M24 2절: 저장 주체(flush/debounce/앱) 표를 만들기 위해 타임라인을 수집한다.
    const tl: string[] = []
    const f = await freshFile('e2', 0)
    const t = await twoPages(browser)
    t.pageA.on('console', (m) => { const x = m.text(); if (x.includes('[collab-tl]')) tl.push(x) })
    t.pageB.on('console', (m) => { const x = m.text(); if (x.includes('[collab-tl]')) tl.push(x) })
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
    // M25 2절: 저장 직후 디스크 내용을 읽어 표에 쓸 값을 남긴다.
    const after = await readDeck(f.abs)
    console.log(
      `=== E2 saved-content === body2="${after.textOf('Body 2') ?? ''}" body3="${after.textOf('Body 3') ?? ''}" at=${Date.now()}`,
    )
    console.log('=== E2 timeline ===\n' + tl.join('\n'))
    await closeTwo(t)
  })

  test('E2c: owner in view mode + other editor -> edit reaches disk', async ({ browser }, testInfo) => {
    // M14: P0 의심 — owner 가 보기 모드면 아무도 저장하지 않는 구조인가?
    // A(먼저 접속, 보기) + B(편집) → B 의 편집이 8초 안에 디스크에 반영되어야 한다.
    const f = await freshFile('e2c', 0)
    const t = await twoPages(browser)
    const shapesB = new ShapeLocator(t.pageB)
    await openFile(t.pageA, f.name, 'view')
    await gotoSlide(t.pageA, 2)
    await openFile(t.pageB, f.name, 'edit')
    await gotoSlide(t.pageB, 2)
    await editShapeText(t.pageB, shapesB, 'Body 2', 'Hello from Ada')
    const deck = await waitForDisk(f.abs, (d) => d.textOf('Body 2') === 'Hello from Ada', 8000)
    expect(deck.slideCount).toBe(3)
    void testInfo
    await closeTwo(t)
  })

  test('E2f: close preview right after edit -> edit reaches disk', async ({ browser }, testInfo) => {
    // M22: owner 가 편집 직후 미리보기를 닫으면(언마운트) 커밋이 Y.Doc 에 반영되기 전에
    // 뷰어가 죽어 편집이 디스크에 안 갈 수 있다(조용한 유실). 닫은 뒤 8초 안에 반영돼야 한다.
const f = await freshFile('e2f', 0)
const t = await twoPages(browser)
    // M30 P0-1 증명: 언마운트 flush → writeback.enter → save.start → save.done 의 순서와
    // 서버 [applySave] b= 가 같은 바이트인지 확인한다.
      t.pageA.on('console', (m) => {
      const x = m.text()
      if (x.includes('[collab-tl]')) console.log('E2F-TL ' + x)
    })
    t.pageB.on('console', (m) => {
      const x = m.text()
      if (x.includes('[collab-tl]')) console.log('E2F-TL ' + x)
    })
    const shapesA = new ShapeLocator(t.pageA)
    await openFile(t.pageA, f.name, 'edit')
    await gotoSlide(t.pageA, 2)
    await editShapeText(t.pageA, shapesA, 'Body 2', 'Hello from Ada')
    // 100ms 안에 미리보기를 닫는다 (미리보기 닫기 = 인라인 패널의 "미리보기 닫기").
    await t.pageA.waitForTimeout(100)
    await closePreview(t.pageA)
    await t.pageA.waitForTimeout(8000)
    const deck = await readDeck(f.abs)
    expect(deck.textOf('Body 2')).toBe('Hello from Ada')
    void testInfo
    await closeTwo(t)
  })

  test('E2g: non-owner editor Escape -> owner writes it to disk', async ({ browser }, testInfo) => {
    // M22: owner 가 아닌 편집자가 Escape 로 끝내면 owner 쪽 디스크에 반영돼야 한다.
    const f = await freshFile('e2g', 0)
    const t = await twoPages(browser)
    const shapesB = new ShapeLocator(t.pageB)
    await openFile(t.pageA, f.name, 'edit') // A가 owner
    await openFile(t.pageB, f.name, 'edit')
    await gotoSlide(t.pageA, 2)
    await gotoSlide(t.pageB, 2)
    await editShapeText(t.pageB, shapesB, 'Body 2', 'Hello from Grace')
    await t.pageB.keyboard.press('Escape')
    await t.pageB.waitForTimeout(8000)
    const deck = await readDeck(f.abs)
    expect(deck.textOf('Body 2')).toBe('Hello from Grace')
    void testInfo
    await closeTwo(t)
  })

  test('E2b: leaving edit mode keeps A edit on disk (no stale overwrite)', async ({ browser }, testInfo) => {
    // M14/M15: A 의 collab 타임라인을 콘솔에서 수집해 2인 구성 실패를 판정한다.
    const tlA: string[] = []
    const tlB: string[] = []
    const f = await freshFile('e2b', 0)
    const t = await twoPages(browser)
    t.pageA.on('console', (m) => { const x = m.text(); if (x.includes('[collab-tl]')) tlA.push(x) })
    t.pageB.on('console', (m) => { const x = m.text(); if (x.includes('[collab-tl]')) tlB.push(x) })
    const shapesA = new ShapeLocator(t.pageA)
    try {
      await openFile(t.pageA, f.name, 'edit')
      await gotoSlide(t.pageA, 2)
      await editShapeText(t.pageA, shapesA, 'Body 2', 'Hello from Ada')
      // A 의 편집이 먼저 디스크에 반영되어야 한다.
      await waitForDisk(f.abs, (d) => d.textOf('Body 2') === 'Hello from Ada', 12000)
      // 편집 모드를 끝낸다(리마운트 유발).
      await t.pageA.getByRole('button', { name: 'Done' }).click({ timeout: 15000 }).catch(() => {})
      await t.pageA.waitForTimeout(2000)
      const deck = await readDeck(f.abs)
      expect(deck.textOf('Body 2')).toBe('Hello from Ada')
    } finally {
      console.log('=== E2b A timeline ===\n' + tlA.join('\n'))
      console.log('=== E2b B timeline ===\n' + tlB.join('\n'))
      await closeTwo(t)
    }
    void testInfo
  })

  test('E21b: remote mouse cursor is not published or shown (D26)', async ({ browser }) => {
    const f = await freshFile('e21b', 0)
    const t = await twoPages(browser)
    const shapesA = new ShapeLocator(t.pageA)
    await openFile(t.pageA, f.name, 'edit')
    await openFile(t.pageB, f.name, 'edit')

    // 두 탭이 서로를 owner가 아닌 상태로 수렴할 때까지 기다린다.
    await expect(async () => {
      const dB = await readDebug(t.pageB)
      expect(dB.ownerClientId).not.toBeNull()
      expect(dB.ownerClientId).not.toBe(dB.clientId)
    }).toPass({ timeout: 25000 })
    // A가 캔버스 위를 마우스로 크게 움직인다 (pointermove storm).
    const box = await t.pageA.getByTestId('pptx-viewer-root').boundingBox()
    expect(box).not.toBeNull()
    const txBefore = (await readDebug(t.pageA)).awarenessTx ?? 0
    for (let i = 0; i < 40; i++) {
      await t.pageA.mouse.move(
        box!.x + 40 + (i % 12) * 30,
        box!.y + 40 + Math.floor(i / 12) * 25,
        { steps: 3 },
      )
    }
    await t.pageA.waitForTimeout(2000)

    // 1) 표시: 원격 커서 요소가 하나도 없어야 한다.
    await expect(t.pageB.locator('[data-pptx-remote-cursor]')).toHaveCount(0)
    await expect(t.pageB.locator('[data-testid="remote-user-cursors"]')).toBeHidden()

    // 2) 게시: 마우스를 움직여도 awareness 송신이 초당 4회 상한을 넘기지 않는다.
    //    40회 이동(각각 3 step)이 그대로 갔다면 수백 번이 된다.
    const txAfter = (await readDebug(t.pageA)).awarenessTx ?? 0
    expect(txAfter - txBefore).toBeLessThanOrEqual(12)

    // 3) 회귀: 원격 선택 외곽선은 여전히 간다 (presence의 나머지는 살아 있어야 한다).
    await gotoSlide(t.pageA, 2)
    await gotoSlide(t.pageB, 2)
    await selectShape(t.pageA, shapesA, 'Body 2')
    await expect(t.pageB.locator(REMOTE_SELECTION_SELECTOR)).toBeVisible({ timeout: 8000 })

    await closeTwo(t)
  })

  test('E3: remote selection', async ({ browser }, testInfo) => {    const f = await freshFile('e3', 0)
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

  test('E18: image-loss save is blocked, then allowed by explicit confirm (R1/R2)', async ({ browser }, testInfo) => {
    const f = await freshFile('e18', 0)
    const t = await twoPages(browser)
    const shapesA = new ShapeLocator(t.pageA)
    const testName = `E18[${testInfo.repeatEachIndex}]`
    await openFile(t.pageA, f.name, 'edit')
    // Y.Doc에는 blob: 이 없어야 한다 (앱 패치 확인).
    await expect(async () => {
      const d = await readDebug(t.pageA)
      expect(d.imageSync?.blobOnly ?? 0).toBe(0)
      expect(d.imageSync?.pictures ?? 0).toBeGreaterThanOrEqual(3)
    }).toPass({ timeout: 15000 })
    const mediaBefore = (await readDeck(absForRel(f.rel))).mediaParts

    // V2: 후킹 없이 그림 요소를 확정적으로 선택한다.
    // 선택자 근거: fixture가 만든 그림 이름은 "e2e-pic1"/"e2e-pic2" (make.ts slideXml).
    const pic1 = t.pageA
      .locator('[data-testid="pptx-viewer-root"] [data-element-id]')
      .filter({ has: t.pageA.locator('img') })
      .first()
    await expect(pic1).toBeVisible({ timeout: 10000 })
    await pic1.click()
    // 선택된 요소가 실제로 그림인지 debug로 확인한 뒤 삭제한다.
    await t.pageA.keyboard.press('Delete')
    await t.pageA.waitForTimeout(1500)

    // Q3: 조건부 통과 금지 — 확인창이 반드시 떠야 한다.
    const confirm = t.pageA.getByTestId('collab-confirm-image-loss')
    await expect(confirm).toBeVisible({ timeout: 25000 })
    // R1: 자동 저장이 중지되어야 한다 (6초간 saveCount 불변).
    const before = (await readDebug(t.pageA)).saveCount
    await t.pageA.waitForTimeout(6000)
    expect((await readDebug(t.pageA)).saveCount).toBe(before)
    // 디스크는 아직 원본 그대로.
    expect((await readDeck(absForRel(f.rel))).mediaParts).toBe(mediaBefore)

    // R2: 확인을 누르면 허용 저장 → 디스크 media 수가 줄어든다 (poll이 대기 담당).
    await confirm.click()
    await expect
      .poll(async () => (await readDeck(absForRel(f.rel))).mediaParts, { timeout: 15000 })
      .toBeLessThan(mediaBefore)
    void testName
    await closeTwo(t)
  })

  test('E17: one session per tab (no duplicate peer on re-render/fullscreen)', async ({ browser }, testInfo) => {
    const f = await freshFile('e17', 0)
    const t = await twoPages(browser)
    const testName = `E17[${testInfo.repeatEachIndex}]`
    await openFile(t.pageA, f.name, 'edit')
    await openFile(t.pageB, f.name, 'view')
    // B 화면에서 A는 1명이어야 한다 (같은 탭에서 세션이 2개 생기면 2명으로 보인다).
    const selfOnB = t.pageB.locator('[data-testid="collab-peer"][data-self="true"]')
    await expect(selfOnB).toHaveCount(1, { timeout: 15000 })
    // 이름 변경 → 같은 세션이어야 한다.
    await t.pageA.getByTestId('collab-rename-edit').click()
    await t.pageA.getByTestId('collab-rename-input').fill('renamed-ada')
    await t.pageA.getByTestId('collab-rename-submit').click()
    await expect(t.pageB.getByTestId('collab-peer').filter({ hasText: 'renamed-ada' })).toHaveCount(1, {
      timeout: 15000,
    })
    // 세션 수는 탭당 1.
    const d = await readDebug(t.pageA)
    expect(d.sessionCount).toBe(1)
    void testName
    await closeTwo(t)
  })

  test('E16b: joiner renders every seeded image (browser, 3-image fixture)', async ({ browser }, testInfo) => {
    const f = await freshFile('e16b', 0)
    const t = await twoPages(browser)
    const testName = `E16b[${testInfo.repeatEachIndex}]`
    await openFile(t.pageA, f.name, 'edit')
    // seed한 A의 Y.Doc에 이미지가 data: URL로 실렸는지.
    await expect(async () => {
      const d = await readDebug(t.pageA)
      expect(d.imageSync?.pictures ?? 0).toBeGreaterThanOrEqual(3)
      expect(d.imageSync?.blobOnly).toBe(0)
    }).toPass({ timeout: 20000 })
    await openFile(t.pageB, f.name, 'view')
    await expect(async () => {
      const d = await readDebug(t.pageB)
      expect(d.imageSync?.pictures ?? 0).toBeGreaterThanOrEqual(3)
    }).toPass({ timeout: 20000 })
    // Q4/V1: 슬라이드1(이미지 2장)에서 img가 실제로 존재하고 로드됐는지.
    await gotoSlide(t.pageB, 1)
    await expect(async () => {
      const r = await t.pageB.evaluate(() => {
        const imgs = Array.from(
          document.querySelectorAll('[data-testid="pptx-viewer-root"] img'),
        ) as HTMLImageElement[]
        return { total: imgs.length, broken: imgs.filter((i) => !i.naturalWidth).length }
      })
      // V1: img 0개여도 통과하지 않는다 (공허 통과 방지).
      expect(r.total).toBeGreaterThanOrEqual(2)
      expect(r.broken).toBe(0)
    }).toPass({ timeout: 20000 })
    // 슬라이드2(이미지 1장)까지 합쳐 총 3장.
    await gotoSlide(t.pageB, 2)
    await expect(async () => {
      const r = await t.pageB.evaluate(() => {
        const imgs = Array.from(
          document.querySelectorAll('[data-testid="pptx-viewer-root"] img'),
        ) as HTMLImageElement[]
        return { total: imgs.length, broken: imgs.filter((i) => !i.naturalWidth).length }
      })
      expect(r.total).toBeGreaterThanOrEqual(1)
      expect(r.broken).toBe(0)
    }).toPass({ timeout: 20000 })

    // V1: B는 view라 저장이 안 일어난다 → A가 편집해서 저장을 유발한다.
    const shapesA = new ShapeLocator(t.pageA)
    await gotoSlide(t.pageA, 2)
    await editShapeText(t.pageA, shapesA, 'Body 2', 'saved-by-A')
    await waitForDisk(absForRel(f.rel), 'Body 2', 'saved-by-A')
    const after = await readDeck(absForRel(f.rel))
    expect(after.mediaParts).toBeGreaterThanOrEqual(3)
    void testName
    await closeTwo(t)
  })

  test('E19: peer slide stays put for 15s (no lib 0-resurrect, no lock-poll mix)', async ({ browser }, testInfo) => {
    const f = await freshFile('e19', 0)
    const t = await twoPages(browser)
    const shapesA = new ShapeLocator(t.pageA)
    const testName = `E19[${testInfo.repeatEachIndex}]`
    await openFile(t.pageA, f.name, 'edit')
    await openFile(t.pageB, f.name, 'view')
    // A가 3번 슬라이드로 이동.
    await gotoSlide(t.pageA, 3)
    // B 화면에서 A의 data-slide를 15초간 샘플링 (lib 10초 주기 + lock poll 주기를 덮는다).
    const samples: string[] = []
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const v = await t.pageB
        .locator('[data-testid="collab-peer"][data-peer-id="u-ada"]')
        .getAttribute('data-slide')
        .catch(() => null)
      samples.push(String(v))
      await t.pageB.waitForTimeout(200)
    }
    // 모든 샘플이 3이어야 한다 (200ms 샘플 75개 이상).
    expect(samples.length).toBeGreaterThanOrEqual(60)
    const wrong = samples.filter((s) => s !== '3')
    expect(wrong).toEqual([])
    // 위치 글자는 화면에 표시하지 않는다(방향 전환 규칙). data-slide만 단언한다.
    const textRow = t.pageB.locator('[data-testid="collab-peer"][data-peer-id="u-ada"]')
    await expect(textRow).not.toContainText('슬라이드')
    // A가 움직이지 않아도 원격 편집 반영 중에는 값이 유지되어야 한다.
    await editShapeText(t.pageA, shapesA, 'Body 3', 'still on slide 3')
    await t.pageB.waitForTimeout(3000)
    expect(
      await t.pageB
        .locator('[data-testid="collab-peer"][data-peer-id="u-ada"]')
        .getAttribute('data-slide'),
    ).toBe('3')
    void testName
    await closeTwo(t)
  })

  test('E20: peer slide survives edit<->view switch (F3 app republish)', async ({ browser }, testInfo) => {
    const f = await freshFile('e20', 0)
    const t = await twoPages(browser)
    const testName = `E20[${testInfo.repeatEachIndex}]`
    await openFile(t.pageA, f.name, 'edit')
    await openFile(t.pageB, f.name, 'view')
    // A가 슬라이드 3으로 이동하고 publish.
    await gotoSlide(t.pageA, 3)
    // data-slide만 단언한다(위치 글자는 화면에 표시하지 않는다).
    const sampleOne = async (): Promise<string | null> => {
      const row = t.pageB.locator('[data-testid="collab-peer"][data-peer-id="u-ada"]')
      return row.getAttribute('data-slide').catch(() => null)
    }
    await expect(async () => {
      expect(await sampleOne()).toBe('3')
    }).toPass({ timeout: 15000 })
    // X2: 슬라이드 이동은 viewer를 다시 마운트시키지 않는다.
    // (setSlideIdx는 setViewerRef의 마운트 시점에만 호출된다)
    const mountAfterMove = (await readDebug(t.pageA)).mountCount
    await gotoSlide(t.pageA, 2)
    await gotoSlide(t.pageA, 3)
    await expect(async () => {
      const s = await sampleOne()
      expect(s.slide).toBe('3')
    }).toPass({ timeout: 15000 })
    expect((await readDebug(t.pageA)).mountCount).toBe(mountAfterMove)
    // A가 view로 전환(리마운트 지점) → 상대 화면에서 15초간 계속 3이어야 한다.
    // DocumentPreview의 편집 종료 버튼 라벨이 Done이다 (helpers/viewer.ts의 Edit와 짝).
    await t.pageA.getByRole('button', { name: 'Done' }).click({ timeout: 15000 })
    // X2: 이 지점만 리마운트다. 마운트 시 slideIdx가 현재 위치로 고정되므로 3이 복원된다.
    await expect(async () => {
      expect((await readDebug(t.pageA)).mountCount).toBeGreaterThan(mountAfterMove)
    }).toPass({ timeout: 15000 })
    const samples: (string | null)[] = []
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      samples.push(await sampleOne())
      await t.pageB.waitForTimeout(200)
    }
    expect(samples.length).toBeGreaterThanOrEqual(60)
    expect(samples.filter((s) => s !== '3')).toEqual([])
    void testName
    await closeTwo(t)
  })

  // Y2 slow-parse 변형: CPU를 4배 느리게 만들어 parse가 게이트 300ms보다 오래 걸리게 한다.
  // 수정 전에는 리마운트 직후 lib의 activeSlideIndex 초기값 0이 curSlide를 0으로 되돌리고,
  // 예약된 0 게시가 통과해 B 화면이 "슬라이드 1"로 깜빡인다.
  test('E20s: slow parse on remount keeps slide 3 (Y2)', async ({ browser }, testInfo) => {
    const f = await freshFile('e20s', 0)
    const t = await twoPages(browser)
    const testName = `E20s[${testInfo.repeatEachIndex}]`
    const cdpA = await t.pageA.context().newCDPSession(t.pageA)
    await cdpA.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await openFile(t.pageA, f.name, 'edit')
    await openFile(t.pageB, f.name, 'view')
const row = t.pageB.locator('[data-testid="collab-peer"][data-peer-id="u-ada"]')
    const sampleB = async (): Promise<string | null> => row.getAttribute('data-slide').catch(() => null)
    await gotoSlide(t.pageA, 3)
    await expect(async () => {
      expect(await sampleB()).toBe('3')
    }).toPass({ timeout: 20000 })
    // Z3(2) 전환 "이전" 이력 길이를 기록해 전환 이후 구간만 판정한다.
    // (초기 열람 때 슬라이드 1이 한 번 나오는 것은 정상이다)
    const histBefore = (await readDebug(t.pageB)).peerSlideHistory?.['u-ada']?.length ?? 0
    // 리마운트를 일으킨다 (editing이 viewKey를 바꾼다).
    await t.pageA.getByRole('button', { name: 'Done' }).click({ timeout: 20000 })
    const samples: (string | null)[] = []
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      samples.push(await sampleB())
      await t.pageB.waitForTimeout(200)
    }
    expect(samples.length).toBeGreaterThanOrEqual(30)
    // 기존 200ms 샘플 검사는 data-slide 확인용으로 유지한다.
    expect(samples.filter((s) => s !== '3')).toEqual([])
    // Z3(1) 공허함 방지: throttle 4배로도 parse가 게이트 300ms 창 안에 끝나면
    // 이 테스트는 아무것도 검증하지 못한다(E16b 교훈). 먼저 창을 실제로 넘었는지 본다.
    const dbgA = await readDebug(t.pageA)
    const armDelay = dbgA.armDelayMs
    expect(armDelay, 'armDelayMs is required by E20s').not.toBeNull()
    expect(armDelay ?? 0, `E20s is vacuous unless parse exceeds 300ms (got ${armDelay}ms)`).toBeGreaterThan(300)
    // Z3(2) 이벤트 기준 이력: edit→view 전환 이후 구간에 1이 없고 마지막이 3이다.
    // 200ms 샘플이 놓칠 짧은 깜빡임도 이력에는 남는다. 상대가 보는 값이므로 B에서 읽는다.
    const hist = (await readDebug(t.pageB)).peerSlideHistory?.['u-ada'] ?? []
    const after = hist.slice(histBefore)
    expect(after.length, 'peer slide history must record a post-switch event').toBeGreaterThan(0)
    expect(after).not.toContain(1)
    expect(after[after.length - 1]).toBe(3)
    // A도 리마운트 직후 "슬라이드 1"을 거치지 않아야 한다.
    expect(dbgA.curSlideHistory ?? []).not.toContain(1)
    void testName
    await closeTwo(t)
  })

  test('E19b: moving back to slide 1 publishes (W1 regression)', async ({ browser }, testInfo) => {
    const f = await freshFile('e19b', 0)
    const t = await twoPages(browser)
    const testName = `E19b[${testInfo.repeatEachIndex}]`
    await openFile(t.pageA, f.name, 'edit')
    await openFile(t.pageB, f.name, 'view')
    const row = t.pageB.locator('[data-testid="collab-peer"][data-peer-id="u-ada"]')
    const sample = async (): Promise<string | null> => row.getAttribute('data-slide').catch(() => null)
    await gotoSlide(t.pageA, 3)
    await expect(async () => {
      expect(await sample()).toBe('3')
    }).toPass({ timeout: 15000 })
    // W1: 1번으로 돌아가면 1이 게시돼야 한다 (수정 전 i>=1 조건으로는 게시되지 않았다).
    await gotoSlide(t.pageA, 1)
    await expect(async () => {
      expect(await sample()).toBe('1')
    }).toPass({ timeout: 5000 })
    // 15초간 유지 (lib 10초 주기 재게시를 포함).
    const samples: (string | null)[] = []
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      samples.push((await sample()).slide)
      await t.pageB.waitForTimeout(200)
    }
    expect(samples.length).toBeGreaterThanOrEqual(60)
    expect(samples.filter((s) => s !== '1')).toEqual([])
    void testName
    await closeTwo(t)
  })

  test('E19c: rapid moves settle on the final slide (W1 debounce)', async ({ browser }, testInfo) => {
    const f = await freshFile('e19c', 0)
    const t = await twoPages(browser)
    const testName = `E19c[${testInfo.repeatEachIndex}]`
    await openFile(t.pageA, f.name, 'edit')
    await openFile(t.pageB, f.name, 'view')
    const row = t.pageB.locator('[data-testid="collab-peer"][data-peer-id="u-ada"]')
    // 1 → 3 → 1 → 2 를 150ms 간격으로 (마지막 2만 확정돼야 한다).
    for (const n of [1, 3, 1, 2]) {
      await gotoSlide(t.pageA, n)
      await t.pageA.waitForTimeout(150)
    }
    await t.pageA.waitForTimeout(1000)
    expect(await row.getAttribute('data-slide')).toBe('2')
    const deadline = Date.now() + 5000
    const samples: (string | null)[] = []
    while (Date.now() < deadline) {
      samples.push(await row.getAttribute('data-slide').catch(() => null))
      await t.pageB.waitForTimeout(200)
    }
    expect(samples.filter((s) => s !== '2')).toEqual([])
    void testName
    await closeTwo(t)
  })

  test('E21: non-owner manual save is delegated, not a failure (B3)', async ({ browser }) => {
    const f = await freshFile('e21', 0)
    const t = await twoPages(browser)
    // 둘 다 편집 모드로 연다. 먼저 연 쪽(A)이 owner가 된다.
    await openFile(t.pageA, f.name, 'edit')
    await openFile(t.pageB, f.name, 'edit')

    // 두 탭 모두 "나 = owner 아님"으로 수렴할 때까지 기다린다.
    await expect(async () => {
      const dB = await readDebug(t.pageB)
      expect(dB.ownerClientId).not.toBeNull()
      expect(dB.ownerClientId).not.toBe(dB.clientId)
      expect(dB.synced).toBe(true)
    }).toPass({ timeout: 25000 })

    // B는 owner가 아니다 (data-owner=false가 실제 판정의 근거다).
    await expect(t.pageB.locator('[data-testid="collab-peer"][data-self="true"][data-owner="false"]')).toHaveCount(1, {
      timeout: 15000,
    })

    const savesBefore = (await readDebug(t.pageB)).saveCount
    await t.pageB.getByTitle('Overwrite current file').click()

    // 조건부 통과 금지 — 위임 성공 토스트가 반드시 떠야 한다.
    await expect(t.pageB.locator('[data-sonner-toast]').filter({ hasText: '자동 저장됩니다' })).toHaveCount(1, {
      timeout: 20000,
    })
    // 실패 형태는 하나도 없어야 한다.
    await expect(t.pageB.locator('[data-sonner-toast]').filter({ hasText: 'Save rejected' })).toHaveCount(0)
    await expect(t.pageB.locator('[data-sonner-toast]').filter({ hasText: 'Save failed' })).toHaveCount(0)
    await expect(t.pageB.locator('[data-sonner-toast]').filter({ hasText: 'not owner' })).toHaveCount(0)
    // 수동 저장 1회 = 토스트 1개.
    await expect(t.pageB.locator('[data-sonner-toast]')).toHaveCount(1)
    // 저장 API를 부르지 않았음이 saveCount로 남는다 (denied 응답 자체가 없다).
    expect((await readDebug(t.pageB)).saveCount).toBe(savesBefore)

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
