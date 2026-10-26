import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { absForRel, backendBase, uniqueRelWithExt } from './helpers/env'
import { gotoApp } from './helpers/viewer'
import { ADA, GRACE, seedUser } from './helpers/users'

/**
 * X0a/X1b: XLSX 동시편집 수용 기준.
 *
 * 배경: PPT 는 앱 차원에서 Y.Doc/awareness/owner/write-back 를 직접 운영한다(ycollab.ts).
 * XLSX 는 ooxml-ui 의 xlsx 편집기가 **자체로** 방(Yjs)·presence·문서 공유를 구현한다
 * (`collaboration` 옵션: roomId + serverUrl). 앱은 방을 만들고 옵션을 넘기는 배선만 한다.
 *
 * 저장 규칙(공동편집 원칙): **디스크 파일이 원본, 저장은 서버가 판정한다.**
 * XLSX 저장도 방을 아는 경로(`/api/collab/save`)로 unify 하여
 *  - 방의 해시 갱신(lastHash) → 뒤에 참가하는 사람이 낡은 방으로 판정되지 않는다.
 *  - 낙관적 잠금(base hash) → 옛 바이트가 늦게 도착해도 덮어쓰지 않는다(P0-3).
 *  - 외부 변경(AI 편집·보기 모드 코멘트) → 409 + 배너 + 내 사본 다운로드(P0-4).
 *
 * 주의: XLSX 그리드는 canvas 렌더라 셀 텍스트를 DOM 으로 못 읽는다.
 *  → 편집 반영은 "저장된 zip 의 XML" 로 확인한다.
 *  → `waitForTimeout` 은 쓰지 않는다(금지 패턴 D38). 상태는 expect.poll 로 기다린다.
 */

const FIXTURE = path.resolve('e2e/collab/fixtures/collab-features.xlsx')

interface Two {
  ctxA: BrowserContext
  ctxB: BrowserContext
  pageA: Page
  pageB: Page
}

/** 테스트마다 새 사본 파일을 만든다(공유 시드 파일을 직접 고치지 않는다). */
function freshXlsx(slug: string, index: number): { rel: string; abs: string; name: string } {
  const rel = uniqueRelWithExt(slug, index, '.xlsx')
  const abs = absForRel(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.copyFileSync(FIXTURE, abs)
  return { rel, abs, name: rel.split('/').pop()! }
}

async function twoPages(browser: Browser, opts?: { noSubtle?: boolean }): Promise<Two> {
  const mk = async (user: { id: string; name: string; color: string }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, user)
    if (opts?.noSubtle) {
      // P0-2: http://IP 로 접속하면 crypto.subtle 이 없다(보안 컨텍스트 아님).
      // 그 환경에서 방에 붙으면 낡은 방 차단이 사라진다 → fail-closed 여부를 본다.
      await ctx.addInitScript(() => {
        try {
          Object.defineProperty(window, 'crypto', { value: { getRandomValues: () => new Uint8Array(8) }, configurable: true })
        } catch {
          /* 무시 */
        }
      })
    }
    const page = await ctx.newPage()
    await gotoApp(page)
    return { ctx, page }
  }
  const a = await mk(ADA)
  const b = await mk(GRACE)
  return { ctxA: a.ctx, ctxB: b.ctx, pageA: a.page, pageB: b.page }
}

/** 워크스페이스를 열고 XLSX 를 연다(편집 모드 진입까지). 고정 대기 없이 폴링으로만 기다린다. */
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
    // 시트를 닫고 다시 시도한다(두 번째 클릭은 "닫기"가 된다).
    await page.keyboard.press('Escape')
  }
  await expect
    .poll(async () => page.locator('[data-testid="file-row"]').count(), { timeout: 15000, intervals: [200] })
    .toBeGreaterThan(0)
  // 폴더(collab-e2e)를 펼친 뒤 파일 행이 보일 때까지 폴링한다.
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

/** lib 의 collaboration 상태(방 id·연결·사람 수). */
async function collabState(page: Page): Promise<{ active: boolean; roomId?: string; status: string; synced: boolean; people: number }> {
  return page.evaluate(() => {
    const el = document.querySelector('xlsx-editor') as unknown as {
      collaborationState?: { active: boolean; roomId?: string; status: string; synced: boolean; people: unknown[] }
    } | null
    const s = el?.collaborationState
    return {
      active: !!s?.active,
      roomId: s?.roomId,
      status: s?.status ?? 'none',
      synced: !!s?.synced,
      people: s?.people?.length ?? 0,
    }
  })
}

/** 수식 바에 값을 넣어 셀을 편집한다(그리드는 canvas 라 수식 바가 확정 경로). */
async function setCellByFormulaBar(page: Page, ref: string, value: string): Promise<void> {
  await page.evaluate((r) => {
    const el = document.querySelector('xlsx-editor') as unknown as { select?: (ref: string) => void; focusGrid?: () => void } | null
    el?.select?.(r)
    el?.focusGrid?.()
  }, ref)
  const bar = page.locator('xlsx-editor [part~="formula-bar"] input').last()
  await bar.waitFor({ timeout: 15000 })
  await bar.click({ timeout: 15000 })
  await bar.fill(value)
  await bar.press('Enter')
  // 편집이 커밋되었는지(dirty) 로 확인한다 — 고정 대기는 쓰지 않는다.
  await expect
    .poll(async () => page.evaluate(() => (document.querySelector('xlsx-editor') as unknown as { dirty?: boolean } | null)?.dirty === true), {
      timeout: 15000,
      intervals: [200],
    })
    .toBe(true)
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

/** 앱 헤더의 Save(덮어쓰기). */
async function clickAppSave(page: Page): Promise<void> {
  const save = page.locator('[data-testid="preview-doc-header"]').getByRole('button', { name: 'Save', exact: true })
  await save.waitFor({ timeout: 20000 })
  await save.click({ timeout: 20000 })
}

/** 편집 종료(Done). */
async function clickDone(page: Page): Promise<void> {
  const done = page.getByRole('button', { name: 'Done', exact: true })
  await done.waitFor({ timeout: 20000 })
  await done.click({ timeout: 20000 })
}

/** X0a-9: 편집 모드 도입 직후의 즉시 입력 시도. 편집이 막혀 있어도 실패하지 않는다. */
async function tryCellEdit(page: Page, ref: string, value: string): Promise<boolean> {
  await page.evaluate((r) => {
    const el = document.querySelector('xlsx-editor') as unknown as { select?: (ref: string) => void; focusGrid?: () => void } | null
    el?.select?.(r)
    el?.focusGrid?.()
  }, ref)
  const bar = page.locator('xlsx-editor [part~="formula-bar"] input').last()
  const found = await bar.waitFor({ timeout: 5000 }).then(() => true).catch(() => false)
  if (!found) return false
  const filled = await bar
    .click({ timeout: 5000 })
    .then(() => bar.fill(value, { timeout: 5000 }))
    .then(() => bar.press('Enter'))
    .then(() => true)
    .catch(() => false)
  return filled
}

async function openXlsxFileOnly(page: Page, name: string): Promise<void> {
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
}

test.describe('X0a: XLSX 동시편집', () => {
  test('X0a-1: 두 편집자가 같은 방에 들어가 서로가 보인다', async ({ browser }) => {
    const t = await twoPages(browser)
    const f = freshXlsx('x0a1', 0)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)

      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => (await collabState(t.pageB)).active, { timeout: 30000, intervals: [500] }).toBe(true)

      const a = await collabState(t.pageA)
      const b = await collabState(t.pageB)
      expect(a.roomId).toBeTruthy()
      expect(b.roomId).toBe(a.roomId)
      await expect.poll(async () => (await collabState(t.pageA)).people, { timeout: 20000, intervals: [500] }).toBeGreaterThanOrEqual(2)
      await expect.poll(async () => (await collabState(t.pageB)).people, { timeout: 20000, intervals: [500] }).toBeGreaterThanOrEqual(2)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('X0a-2: A 의 편집이 B 에 반영되고 B 저장으로 디스크에 남는다', async ({ browser }) => {
    const t = await twoPages(browser)
    const f = freshXlsx('x0a2', 0)
    const stamp = `X0A${Date.now().toString(36)}`
    try {
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => (await collabState(t.pageB)).active, { timeout: 30000, intervals: [500] }).toBe(true)

      await setCellByFormulaBar(t.pageA, 'B2', stamp)
      await clickAppSave(t.pageB)

      await expect
        .poll(async () => (await workbookContains(f.abs, stamp)) ? stamp : '', { timeout: 25000, intervals: [500] })
        .toBe(stamp)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('X0a-3: 디스크와 어긋난 방에는 붙지 않는다 (배너를 띄운다)', async ({ browser }) => {
    const t = await twoPages(browser)
    const f = freshXlsx('x0a3', 0)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)

      // 디스크의 파일을 다른 내용으로 바꾼다(유효한 xlsx 로 유지).
      const zip = await JSZip.loadAsync(fs.readFileSync(f.abs))
      const sheetName = Object.keys(zip.files).find((n) => n.startsWith('xl/worksheets/') && n.endsWith('.xml'))
      expect(sheetName, 'worksheet entry missing').toBeTruthy()
      const sheetXml = await zip.files[sheetName!].async('string')
      zip.file(sheetName!, sheetXml.replace('</sheetData>', '<row r="900"><c r="A900" t="inlineStr"><is><t>ZZZ</t></is></c></row></sheetData>'))
      fs.writeFileSync(f.abs, await zip.generateAsync({ type: 'nodebuffer' }))

      // B 는 디스크의 새 파일을 읽는다. 방은 옛 해시라 붙으면 안 된다.
      await t.pageB.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => (await collabState(t.pageB)).active, { timeout: 20000, intervals: [500] }).toBe(false)
      // 사용자에게 배너로 알려야 한다(조용히 solo 로 떨어지지 않는다).
      await expect(t.pageB.locator('[data-testid="xlsx-collab-banner"]')).toBeVisible({ timeout: 15000 })
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('X0a-4: A 가 저장한 뒤 새로 참가한 C 도 같은 방에 붙고 A 의 편집이 보인다', async ({ browser }) => {
    const t = await twoPages(browser)
    const f = freshXlsx('x0a4', 0)
    const stamp = `X0A4${Date.now().toString(36)}`
    try {
      await openXlsxEditing(t.pageA, f.name)
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)

      await setCellByFormulaBar(t.pageA, 'B2', stamp)
      await clickAppSave(t.pageA)

      // C(새 탭)가 참가한다. 저장이 방의 해시를 갱신했으므로 붙어야 한다.
      const ctxC = await browser.newContext({ viewport: { width: 1400, height: 900 } })
      await seedUser(ctxC, { id: 'u-c', name: 'Cathy', color: '#d97706' })
      const pageC = await ctxC.newPage()
      await gotoApp(pageC)
      await openXlsxEditing(pageC, f.name)

      await expect.poll(async () => (await collabState(pageC)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      const c = await collabState(pageC)
      expect(c.roomId).toBeTruthy()
      // A 쪽은 저장 후 raw 재수신으로 워크북이 교체될 수 있다(방은 유지).
      await expect.poll(async () => (await collabState(t.pageA)).roomId, { timeout: 20000, intervals: [500] }).toBe(c.roomId)
      // C 의 워크북에 A 의 편집이 들어 있어야 한다(방에서 받은 것).
      await clickAppSave(pageC)
      await expect
        .poll(async () => (await workbookContains(f.abs, stamp)) ? stamp : '', { timeout: 25000, intervals: [500] })
        .toBe(stamp)
      await ctxC.close()
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('X0a-5: A 가 저장해도 A·B 모두 방을 유지한다', async ({ browser }) => {
    const t = await twoPages(browser)
    const f = freshXlsx('x0a5', 0)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => (await collabState(t.pageB)).active, { timeout: 30000, intervals: [500] }).toBe(true)

      await setCellByFormulaBar(t.pageA, 'B2', `X0A5${Date.now().toString(36)}`)
      await clickAppSave(t.pageA)

      // 저장으로 raw 가 다시 와도 방에서 떨어지지 않는다.
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 20000, intervals: [500] }).toBe(true)
      await expect.poll(async () => (await collabState(t.pageB)).active, { timeout: 20000, intervals: [500] }).toBe(true)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('X0a-6: 편집 중 디스크가 바뀌면 저장은 막히고 배너·다운로드가 뜬다', async ({ browser }) => {
    const t = await twoPages(browser)
    const f = freshXlsx('x0a6', 0)
    const external = 'EXTERNAL9'
    try {
      await openXlsxEditing(t.pageA, f.name)
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      await setCellByFormulaBar(t.pageA, 'B2', `X0A6${Date.now().toString(36)}`)

      // 외부 변경(AI 편집·보기 모드 코멘트처럼 파일을 직접 고치는 상황).
      const zip = await JSZip.loadAsync(fs.readFileSync(f.abs))
      const sheetName = Object.keys(zip.files).find((n) => n.startsWith('xl/worksheets/') && n.endsWith('.xml'))
      const sheetXml = await zip.files[sheetName!].async('string')
      zip.file(sheetName!, sheetXml.replace('</sheetData>', `<row r="901"><c r="A901" t="inlineStr"><is><t>${external}</t></is></c></row></sheetData>`))
      fs.writeFileSync(f.abs, await zip.generateAsync({ type: 'nodebuffer' }))

      // A 가 저장 → 409(외부 변경) → 배너 + 내 사본 다운로드. 디스크는 외부 변경 그대로.
      await clickAppSave(t.pageA)
      await expect(t.pageA.locator('[data-testid="xlsx-collab-banner"]')).toBeVisible({ timeout: 20000 })
      await expect(t.pageA.locator('[data-testid="xlsx-collab-download"]')).toBeVisible({ timeout: 20000 })
      expect(await workbookContains(f.abs, external), 'external change must survive').toBe(true)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('X0a-7: 해시를 계산할 수 없으면(fail-closed) 방에 붙지 않는다', async ({ browser }) => {
    const t = await twoPages(browser, { noSubtle: true })
    const f = freshXlsx('x0a7', 0)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 20000, intervals: [500] }).toBe(false)
      await expect(t.pageA.locator('[data-testid="xlsx-collab-banner"]')).toBeVisible({ timeout: 15000 })
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('X-E2f: 편집 직후 Done 하면 8초 안에 디스크에 반영된다', async ({ browser }) => {
    const t = await twoPages(browser)
    const f = freshXlsx('xe2f', 0)
    const stamp = `XE2F${Date.now().toString(36)}`
    try {
      await openXlsxEditing(t.pageA, f.name)
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      await setCellByFormulaBar(t.pageA, 'B2', stamp)

      await clickDone(t.pageA)
      await expect
        .poll(async () => (await workbookContains(f.abs, stamp)) ? stamp : '', { timeout: 8000, intervals: [250] })
        .toBe(stamp)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('X-M6: 편집을 끝내면 소켓이 내려간다 (방 참가자 0)', async ({ browser }) => {
    const t = await twoPages(browser)
    const f = freshXlsx('xm6', 0)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)

      // 서버가 아는 방 상태(소켓이 하나도 없으면 목록에서 사라진다).
      const roomPresent = async (): Promise<boolean> => {
        const res = await fetch('http://127.0.0.1:5011/api/collab/rooms')
        const body = (await res.json()) as { rooms?: { rel?: string }[] }
        return (body.rooms ?? []).some((r) => r.rel === f.rel)
      }
      await expect.poll(roomPresent, { timeout: 15000, intervals: [500] }).toBe(true)

      await clickDone(t.pageA)
      // 편집 종료 → 편집기가 언마운트 → lib 소켓이 닫힌다(방이 사라진다).
      await expect.poll(roomPresent, { timeout: 20000, intervals: [500] }).toBe(false)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('X0a-8: 단독 저장도 잠긴다 — 방에서 저장한 내용을 덮어쓰지 않는다', async ({ browser }) => {
    const t = await twoPages(browser)
    const f = freshXlsx('x0a8', 0)
    const stampA = `X8A${Date.now().toString(36)}`
    const stampC = `X8C${Date.now().toString(36)}`
    try {
      // A·B 가 방에 참가한다.
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => (await collabState(t.pageB)).active, { timeout: 30000, intervals: [500] }).toBe(true)

      // C 는 단독(해시를 못 계산하는 환경 — 폰 http 접속과 같다).
      // **A 가 저장하기 전에** 파일을 연다(폰이 일고 있는 동안 PC 쪽이 저장하는 상황).
      const ctxC = await browser.newContext({ viewport: { width: 1400, height: 900 } })
      await seedUser(ctxC, { id: 'u-c8', name: 'Cathy', color: '#d97706' })
      await ctxC.addInitScript(() => {
        try {
          Object.defineProperty(window, 'crypto', { value: { getRandomValues: () => new Uint8Array(8) }, configurable: true })
        } catch {
          /* 무시 */
        }
      })
      const pageC = await ctxC.newPage()
      await gotoApp(pageC)
      await openXlsxFileOnly(pageC, f.name)

      // A 가 편집·저장 → 디스크는 A 의 내용(폰은 옛 내용을 읽고 있는 중).
      await setCellByFormulaBar(t.pageA, 'B2', stampA)
      await clickAppSave(t.pageA)
      await expect
        .poll(async () => (await workbookContains(f.abs, stampA)) ? stampA : '', { timeout: 25000, intervals: [500] })
        .toBe(stampA)

      // 이제 C 가 편집·저장 → 낡은 내용으로 덮어쓰면 안 된다(409 + 배너 + 다운로드).
      const editC = pageC.getByRole('button', { name: 'Edit', exact: true })
      await editC.waitFor({ timeout: 20000 })
      await editC.click({ timeout: 20000 })
      await pageC.waitForSelector('xlsx-editor', { timeout: 20000 })
      // C 는 방에 못 붙는다(단독).
      await expect.poll(async () => (await collabState(pageC)).active, { timeout: 20000, intervals: [500] }).toBe(false)

      // C 가 저장 → 낡은 내용으로 덮어쓰면 안 된다(409 + 배너 + 다운로드).
      await setCellByFormulaBar(pageC, 'B2', stampC)
      await clickAppSave(pageC)
      await expect(pageC.locator('[data-testid="xlsx-collab-banner"]')).toBeVisible({ timeout: 20000 })
      await expect(pageC.locator('[data-testid="xlsx-collab-download"]')).toBeVisible({ timeout: 15000 })
      // 디스크는 A 의 내용 그대로(외부 덮어쓰기 금지).
      expect(await workbookContains(f.abs, stampA), 'A의 저장이 디스크에 남아 있어야 한다').toBe(true)
      expect(await workbookContains(f.abs, stampC), '단독 저장이 디스크를 덮으면 안 된다').toBe(false)
      await ctxC.close()
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('X0a-9: 방 연결이 끝날 때까지 편집을 막는다 (먼저 입력한 내용의 유실 방지)', async ({ browser }) => {
    const t = await twoPages(browser)
    const f = freshXlsx('x0a9', 0)
    const stampA = `X9A${Date.now().toString(36)}`
    const stampB = `X9B${Date.now().toString(36)}`
    try {
      await openXlsxEditing(t.pageA, f.name)
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      await setCellByFormulaBar(t.pageA, 'B2', stampA)

      // B 는 편집에 들어가 **바로** 수식 바에 입력한다(연결 판정 전).
      await openXlsxFileOnly(t.pageB, f.name)
      const edit = t.pageB.getByRole('button', { name: 'Edit', exact: true })
      await edit.waitFor({ timeout: 20000 })
      await edit.click({ timeout: 20000 })
      // X1d(P0): 편집 진입 직후엔 **연결 중 배너**가 보여야 한다(입력 차단 상태).
      // webui-pre(9bc434e) 에는 이 배너가 없어 이 단계에서 실패한다(수정 효과 증명).
      await expect(t.pageB.getByTestId('xlsx-collab-connecting')).toBeVisible({ timeout: 10000 })
      const typed = await tryCellEdit(t.pageB, 'B3', stampB)

      // 연결 판정이 끝나고 방 문서가 적용된다(synced).
      await expect
        .poll(
          async () => {
            const s = await collabState(t.pageB)
            return s.active && s.synced ? 'ok' : 'wait'
          },
          { timeout: 30000, intervals: [500] },
        )
        .toBe('ok')
      // X1d(P0): 반복 재입력 루프는 없다. 요구는 "입력이 막히거나(차단), 살아 있거나" 둘 중 하나다.
      //  - 막혔다면(tryCellEdit=false) 판정 뒤 **1회**만 재입력한다.
      //  - 입력이 통과했다면(tryCellEdit=true) 유실되면 안 되므로 추가 입력 없이 저장한다.
      if (!typed) await setCellByFormulaBar(t.pageB, 'B3', stampB)
      await clickAppSave(t.pageB)
      // 저장된 디스크에 B 의 입력이 실제 존재해야 한다(A 의 입력이 치환되면 안 된다).
      await expect
        .poll(async () => (await workbookContains(f.abs, stampB)) ? stampB : '', { timeout: 25000, intervals: [500] })
        .toBe(stampB)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('X0a-10: 동시편집 연결 대기 상한 — WebSocket 이 막히면 단독 편집으로 넘어간다', async ({ page }) => {
    const f = freshXlsx('x0a10', 0)
    const stamp = `X10${Date.now().toString(36)}`
    // X1d(P0): /api/collab WebSocket 을 막는다(VPN/프록시 차단 환경 재현).
    // session(HTTP) 은 통과하므로 방 판정은 "joining" 에 멈춘다 → 15초 상한 → 단독 전환.
    await page.routeWebSocket(/\/api\/collab/, (ws) => {
      // 서버에 연결하지 않는다(조용한 차단).
      ws.close()
    })
    await gotoApp(page)
    await openXlsxFileOnly(page, f.name)
    const edit = page.getByRole('button', { name: 'Edit', exact: true })
    await edit.waitFor({ timeout: 20000 })
    await edit.click({ timeout: 20000 })
    // 연결 대기 배너가 먼저 보인다.
    await expect(page.getByTestId('xlsx-collab-connecting')).toBeVisible({ timeout: 10000 })
    // 15초 상한: '연결 시간 초과' 배너로 넘어가고 대기 배너는 사라진다.
    await expect(page.getByTestId('xlsx-collab-banner')).toContainText('시간 초과', { timeout: 30000 })
    await expect(page.getByTestId('xlsx-collab-connecting')).toHaveCount(0)
    // 단독 편집으로 저장한다(X1c 잠금이 그대로 적용된다).
    await setCellByFormulaBar(page, 'B2', stamp)
    await clickAppSave(page)
    await expect
      .poll(async () => (await workbookContains(f.abs, stamp)) ? stamp : '', { timeout: 25000, intervals: [500] })
      .toBe(stamp)
  })
})

/** X2a: 서버 참가자 목록(rooms API)에서 이 파일의 방만 꺼낸다. */
async function participantsFor(page: Page, name: string): Promise<Array<{ id: string; name: string; mode: string }>[]> {
  const res = await page.request.get(`${backendBase()}/api/collab/rooms`)
  const body = (await res.json()) as { rooms: Array<{ rel: string; participants: Array<{ id: string; name: string; mode: string }> }> }
  return body.rooms.filter((r) => r.rel.endsWith(name)).map((r) => r.participants)
}

test.describe('X2a: presence 와 보기 모드', () => {
  test('X2a-5: XLSX 편집자 1명은 서버 참가자에 1명으로 보인다', async ({ browser }) => {
    const t = await twoPages(browser)
    const f = freshXlsx('x2a5', 0)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      await expect
        .poll(async () => (await participantsFor(t.pageA, f.name)).map((p) => p.length), { timeout: 20000, intervals: [500] })
        .toEqual([1])
      const [only] = await participantsFor(t.pageA, f.name)
      expect(only?.[0]).toMatchObject({ name: ADA.name, mode: 'edit' })
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })
})
