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

  test('X-M6: 편집을 끝내면 viewer로 전환되고(방 유지), 미리보기를 닫으면 방이 해제된다', async ({ browser }) => {
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
      // X2a-③: Done 뒤에는 viewer 로 다시 붙으므로 방이 유지된다(편집 소켓은 내려간다).
      await t.pageA.waitForSelector('xlsx-editor', { timeout: 20000 })
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(roomPresent, { timeout: 15000, intervals: [500] }).toBe(true)
      // 미리보기를 닫으면 viewer 소켓도 닫히고 방이 해제된다.
      await closeXlsxPreview(t.pageA)
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

/** X2a-1: 같은 사용자 탭별 소켓 수와 타이틀바 표시를 읽는다(공개 DOM 표면). */
async function presenceSurface(page: Page): Promise<{ text: string; count: number; names: string[]; titles: string[] }> {
  return page.locator('office-ui-presence').first().evaluate((el) => {
    const host = el as HTMLElement & { participants?: Array<{ name: string }> }
    const text = `${host.shadowRoot?.textContent ?? ''} ${host.textContent ?? ''}`.replace(/\s+/g, ' ').trim()
    const list = Array.isArray(host.participants) ? host.participants : []
    const titles = [...(host.shadowRoot?.querySelectorAll('button') ?? [])].map((b) => b.getAttribute('title') ?? '')
    return { text, count: list.length, names: list.map((p) => p.name), titles }
  })
}

test.describe('X2a-1: 같은 사용자 2탭', () => {
  test('X2a-1: 같은 사용자 2탭 → 타이틀바 1명 "(탭 2)", 서버 participants 1명, 소켓 탭당 1', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const f = freshXlsx('x2a1', 0)
    const perPage = new Map<Page, number>()
    const track = (p: Page): void => {
      perPage.set(p, 0)
      p.on('websocket', (ws) => {
        if (!ws.url().includes('/api/collab')) return
        perPage.set(p, (perPage.get(p) ?? 0) + 1)
        ws.on('close', () => perPage.set(p, (perPage.get(p) ?? 0) - 1))
      })
    }
    try {
      const p1 = await ctx.newPage()
      track(p1)
      await gotoApp(p1)
      await openXlsxEditing(p1, f.name)
      await expect.poll(async () => (await collabState(p1)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      // X2a 패치 표식: ooxml-core 패치 파일이 실제로 로드됐는지(런타임)
      await expect
        .poll(
          () =>
            p1.evaluate(
              () => (globalThis as unknown as { __ooxmlPatches?: { core?: string } }).__ooxmlPatches?.core ?? null,
            ),
          { timeout: 15000, intervals: [300] },
        )
        .toBe('X2a-core-esm')
      // X2a 패치 표식: ooxml-ui 패치 파일이 실제로 로드됐는지(런타임, M21과 별도 키)
      await expect
        .poll(
          () =>
            p1.evaluate(
              () => (globalThis as unknown as { __ooxmlPatches?: { uiXlsx?: string } }).__ooxmlPatches?.uiXlsx ?? null,
            ),
          { timeout: 15000, intervals: [300] },
        )
        .toBe('X2a-ui')

      const p2 = await ctx.newPage()
      track(p2)
      await gotoApp(p2)
      await openXlsxEditing(p2, f.name)
      await expect.poll(async () => (await collabState(p2)).active, { timeout: 30000, intervals: [500] }).toBe(true)

      // 진단 덤프(단언 아님): 실패 원문에서 DOM 표면을 확인하려고 남긴다.
      const surface = await presenceSurface(p1)
      console.log('X2A1_SURFACE ' + JSON.stringify(surface))

      // 소켓은 탭당 1개
      await expect
        .poll(async () => [perPage.get(p1), perPage.get(p2)], { timeout: 30000, intervals: [500] })
        .toEqual([1, 1])
      // 서버 참가자는 같은 사용자 1명
      await expect
        .poll(async () => (await participantsFor(p1, f.name)).map((p) => p.length), { timeout: 20000, intervals: [500] })
        .toEqual([1])
      // 타이틀바 표시: 같은 사용자는 한 줄, 이름에 "(탭 2)"(타이틀바가 그리는 participants 속성 기준)
      await expect
        .poll(async () => (await presenceSurface(p1)).names, { timeout: 20000, intervals: [500] })
        .toEqual(['Ada (탭 2)'])
      // 화면에 실제로 그려진 아바타 버튼의 title에도 "(탭 2)"가 들어간다
      await expect
        .poll(async () => (await presenceSurface(p1)).titles, { timeout: 20000, intervals: [500] })
        .toEqual(['Ada (탭 2)'])
    } finally {
      await ctx.close()
    }
  })
})

/** X2a-③: viewer 화면 내용은 공개 element 메서드 saveBytes() + zip XML 로 읽는다. */
async function liveBytesContain(page: Page, needle: string): Promise<boolean> {
  const b64 = await page.evaluate(async () => {
    const el = document.querySelector('xlsx-editor') as unknown as { saveBytes?: () => Promise<Uint8Array> } | null
    if (!el?.saveBytes) return null
    const bytes = await el.saveBytes()
    let bin = ''
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192))
    return btoa(bin)
  })
  if (!b64) return false
  const zip = await JSZip.loadAsync(Buffer.from(b64 as string, 'base64'))
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name]
    if (entry.dir || !name.endsWith('.xml')) continue
    if ((await entry.async('string')).includes(needle)) return true
  }
  return false
}

/** 시트에 셀이 하나라도 있으면(빈 시트가 아니면) true. */
async function liveHasCell(page: Page): Promise<boolean> {
  return liveBytesContain(page, '<c r="')
}

/** /api/collab 소켓 수를 잰다(공개 Playwright API). */
function trackCollabSockets(page: Page): { get: () => number; max: () => number } {
  let cur = 0
  let peak = 0
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/api/collab')) return
    cur += 1
    if (cur > peak) peak = cur
    ws.on('close', () => {
      cur -= 1
    })
  })
  return { get: () => cur, max: () => peak }
}

/** collaboration-change 의 self 항목 clientId(진단 읽기). */
async function viewerSelfClientId(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const el = document.querySelector('xlsx-editor') as unknown as {
      collaborationState?: { people?: Array<{ clientId: number; self: boolean }> }
    } | null
    return el?.collaborationState?.people?.find((p) => p.self)?.clientId ?? null
  })
}

/** 서버 방 목록에 rel 이 보이면 true(X-M6 과 같은 node fetch). */
async function roomListed(rel: string): Promise<boolean> {
  const res = await fetch('http://127.0.0.1:5011/api/collab/rooms')
  const body = (await res.json()) as { rooms?: { rel?: string }[] }
  return (body.rooms ?? []).some((r) => r.rel === rel)
}

/** 미리보기를 닫는다(탐색기 축소 버튼, 없으면 Escape). 고정 대기 없이 언마운트까지 폴링한다. */
async function closeXlsxPreview(page: Page): Promise<void> {
  const btn = page.locator('[aria-label="Close explorer"]')
  if (await btn.count()) {
    await btn.first().click({ timeout: 10000 })
  } else {
    await page.keyboard.press('Escape')
  }
  await expect.poll(async () => page.locator('.xlsxengine-host').count(), { timeout: 10000, intervals: [300] }).toBe(0)
}

test.describe('X2a: viewer 참가', () => {
  test('X2a-2: viewer가 먼저 들어오고 편집자가 디스크와 다른 값을 편집하면 viewer에 반영된다', async ({ browser }) => {
    const t = await twoPages(browser)
    const f = freshXlsx('x2a2', 0)
    const stamp = `X2A2${Date.now().toString(36)}`
    try {
      // B 가 먼저 "보기"로만 연다.
      await openXlsxFileOnly(t.pageB, f.name)
      await t.pageB.waitForSelector('xlsx-editor', { timeout: 20000 })
      await expect.poll(async () => (await collabState(t.pageB)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      // 빈 시트가 아니다(자기 파일이 보인다).
      await expect.poll(async () => liveHasCell(t.pageB), { timeout: 20000, intervals: [500] }).toBe(true)
      // A 가 편집자로 들어와 디스크와 다른 값을 넣는다.
      await openXlsxEditing(t.pageA, f.name)
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      await setCellByFormulaBar(t.pageA, 'B2', stamp)
      // viewer 화면이 방 내용을 따라간다.
      await expect.poll(async () => liveBytesContain(t.pageB, stamp), { timeout: 30000, intervals: [500] }).toBe(true)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('X2a-3: 방이 stale이면 viewer는 참가하지 않고 파일만 보여준다', async ({ browser }) => {
    const t = await twoPages(browser)
    const f = freshXlsx('x2a3', 0)
    const external = `X2A3EXT${Date.now().toString(36)}`
    try {
      // A 가 방을 만든다.
      await openXlsxEditing(t.pageA, f.name)
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      // 외부에서 디스크를 바꾼다(방은 낡는다).
      const zip = await JSZip.loadAsync(fs.readFileSync(f.abs))
      const sheetName = Object.keys(zip.files).find((n) => n.startsWith('xl/worksheets/') && n.endsWith('.xml'))
      const sheetXml = await zip.files[sheetName!].async('string')
      zip.file(sheetName!, sheetXml.replace('</sheetData>', `<row r="902"><c r="A902" t="inlineStr"><is><t>${external}</t></is></c></row></sheetData>`))
      fs.writeFileSync(f.abs, await zip.generateAsync({ type: 'nodebuffer' }))
      // B 가 "보기"로 연다 → stale 이라 참가하지 않는다.
      await openXlsxFileOnly(t.pageB, f.name)
      await t.pageB.waitForSelector('xlsx-editor', { timeout: 20000 })
      await expect(t.pageB.locator('[data-testid="xlsx-viewer-notice"]')).toBeVisible({ timeout: 25000 })
      expect(await collabState(t.pageB)).toMatchObject({ active: false })
      // 파일은 보인다.
      await expect.poll(async () => liveHasCell(t.pageB), { timeout: 20000, intervals: [500] }).toBe(true)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('X2a-4: viewer의 저장 요청은 403 view_only다', async ({ browser }) => {
    const t = await twoPages(browser)
    const f = freshXlsx('x2a4', 0)
    try {
      await openXlsxFileOnly(t.pageB, f.name)
      await t.pageB.waitForSelector('xlsx-editor', { timeout: 20000 })
      await expect.poll(async () => (await collabState(t.pageB)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      const selfId = await viewerSelfClientId(t.pageB)
      expect(selfId, 'viewer self clientId').not.toBeNull()
      const sizeBefore = fs.statSync(f.abs).size
      let saw403 = ''
      let sentClient = ''
      t.pageB.on('request', (req) => {
        if (req.url().includes('/api/collab/save')) sentClient = req.headers()['x-collab-client'] ?? ''
      })
      t.pageB.on('response', (res) => {
        if (!res.url().includes('/api/collab/save')) return
        void res.json().then((b) => {
          const body = b as { code?: string } | null
          if (res.status() === 403 && body?.code === 'view_only') saw403 = 'view_only'
        }).catch(() => {})
      })
      // 보기 화면에는 저장 버튼이 없으므로, 상단 저장 버튼과 같은 이벤트를 직접 쏜다.
      await t.pageB.evaluate(() => window.dispatchEvent(new CustomEvent('officeSaveRequest')))
      await expect.poll(() => saw403, { timeout: 20000, intervals: [500] }).toBe('view_only')
      // clientId 는 collaboration-change 의 self 항목에서 가져온다.
      expect(sentClient).toBe(String(selfId))
      // 디스크는 그대로다.
      expect(fs.statSync(f.abs).size).toBe(sizeBefore)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('X2a-6: 편집자가 있으면 viewer의 코멘트 버튼이 비활성이고 툴팁이 보인다', async ({ browser }) => {
    const t = await twoPages(browser)
    const f = freshXlsx('x2a6', 0)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      await openXlsxFileOnly(t.pageB, f.name)
      await t.pageB.waitForSelector('xlsx-editor', { timeout: 20000 })
      await expect.poll(async () => (await collabState(t.pageB)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      const btn = t.pageB.getByRole('button', { name: 'Comments', exact: true })
      await expect(btn).toBeDisabled({ timeout: 20000 })
      await expect(btn).toHaveAttribute('title', /보는 중/)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('X2a-7: 보기→편집→보기 전환 내내 탭당 소켓은 1개 이하, 미리보기를 닫으면 0개', async ({ browser }) => {
    const t = await twoPages(browser)
    const f = freshXlsx('x2a7', 0)
    const socks = trackCollabSockets(t.pageA)
    try {
      // 보기 → viewer 참가(1개).
      await openXlsxFileOnly(t.pageA, f.name)
      await t.pageA.waitForSelector('xlsx-editor', { timeout: 20000 })
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(() => socks.get(), { timeout: 20000, intervals: [300] }).toBe(1)
      // 보기→편집: 다시 붙어도 1개(중복 금지).
      const edit = t.pageA.getByRole('button', { name: 'Edit', exact: true })
      await edit.waitFor({ timeout: 20000 })
      await edit.click({ timeout: 20000 })
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(() => socks.get(), { timeout: 20000, intervals: [300] }).toBe(1)
      // 편집→보기(Done): 1개 유지.
      await clickDone(t.pageA)
      await t.pageA.waitForSelector('xlsx-editor', { timeout: 20000 })
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(() => socks.get(), { timeout: 20000, intervals: [300] }).toBe(1)
      expect(socks.max(), 'transient duplicate socket').toBeLessThanOrEqual(1)
      // 미리보기를 닫으면 0개.
      await closeXlsxPreview(t.pageA)
      await expect.poll(() => socks.get(), { timeout: 20000, intervals: [300] }).toBe(0)
      await expect.poll(async () => t.pageA.locator('.xlsxengine-host').count(), { timeout: 10000, intervals: [300] }).toBe(0)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('X-M6-ext: 마지막 viewer가 나가면 서버 방이 해제된다', async ({ browser }) => {
    const t = await twoPages(browser)
    const f = freshXlsx('xm6x', 0)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      await openXlsxFileOnly(t.pageB, f.name)
      await t.pageB.waitForSelector('xlsx-editor', { timeout: 20000 })
      await expect.poll(async () => (await collabState(t.pageB)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(() => roomListed(f.rel), { timeout: 15000, intervals: [500] }).toBe(true)
      await clickDone(t.pageA)
      await closeXlsxPreview(t.pageB)
      await closeXlsxPreview(t.pageA)
      await expect.poll(() => roomListed(f.rel), { timeout: 20000, intervals: [500] }).toBe(false)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })
})
