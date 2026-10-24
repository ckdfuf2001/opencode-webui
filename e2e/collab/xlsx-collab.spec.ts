import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { absForRel } from './helpers/env'
import { gotoApp } from './helpers/viewer'
import { ADA, GRACE, seedUser } from './helpers/users'

/**
 * X0a: XLSX 동시편집 수용 기준.
 *
 * 배경: PPT 는 앱 차원에서 Y.Doc/awareness/owner/write-back 를 직접 운영한다(ycollab.ts).
 * XLSX 는 ooxml-ui 의 xlsx 편집기가 **자체로** 방(Yjs)·presence·문서 공유를 구현한다
 * (`collaboration` 옵션: roomId + serverUrl). 앱은 방을 만들고 옵션을 넘기는 배선만 하면 된다.
 *
 * X0a-1: 두 사람이 같은 XLSX 를 편집하면 **같은 방**에 들어가고 서로가 보인다.
 * X0a-2: A 가 편집한 내용이 B 에 반영되고, B 가 저장하면 **디스크**에 남는다.
 *   (XLSX 그리드는 canvas 렌더라 셀 텍스트를 DOM 으로 못 읽는다 → 저장된 파일 바이트로 확인)
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const SEEDED = 'probe-seeded-before-server.xlsx'

/** 워크스페이스 안의 시드 파일 실제 경로. */
function seededAbs(): string {
  return absForRel(path.posix.join('repos', 'collab-e2e', SEEDED))
}

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

/** XLSX 편집기가 마운트되고 편집 모드(Edit → Done)까지 들어갔는지. */
async function openXlsxEditing(page: Page): Promise<void> {
  await openXlsxFile(page)
  await page.waitForSelector('xlsx-editor', { timeout: 30000 })
  const edit = page.getByRole('button', { name: 'Edit', exact: true })
  await edit.waitFor({ timeout: 20000 })
  await edit.click({ timeout: 20000 })
  await page.waitForSelector('xlsx-editor', { timeout: 20000 })
  await page.waitForTimeout(1500)
}

/**
 * 워크스페이스를 열고 시드 XLSX 를 연다.
 * PPT 전용 `openFile` 은 `pptx-viewer-root` 를 기다리므로 XLSX 에는 쓸 수 없다
 * (xlsx-solo.spec.ts 와 같은 흐름).
 */
async function openXlsxFile(page: Page): Promise<void> {
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
    try {
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-row"]').length > 0, null, { timeout: 10000 })
      break
    } catch {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(2000)
    }
    if (i === 4) throw new Error('workspace sheet has no rows after retries')
  }
  for (let i = 0; i < 8; i++) {
    const has = await page.evaluate(
      (n) => [...document.querySelectorAll('[data-testid="file-row"]')].some((r) => (r.textContent || '').includes(n)),
      SEEDED,
    )
    if (has) break
    const folder = page.locator('[data-testid="file-row"][data-path$="collab-e2e"]')
    if ((await folder.count()) > 0) {
      await folder.locator('div.flex-1').first().click({ timeout: 10000 }).catch(() => {})
    }
    await page.waitForTimeout(2500)
  }
  await page.locator(`[data-testid="file-row"][data-path$="${SEEDED}"]`).locator('span', { hasText: SEEDED }).first().click({ timeout: 20000 })
  await page.waitForSelector('.xlsxengine-host', { timeout: 30000 })
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

/** 수식 바에 값을 넣어 B2 셀을 편집한다(그리드는 canvas 라 수식 바가 유일한 확정 경로). */
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
  await page.waitForTimeout(500)
}

/**
 * 저장된 xlsx(zip) 안의 XML 어디에든 문자열이 들어 있는가.
 * 그리드는 canvas 렌더라 DOM 으로 셀을 못 읽고, 저장 결과는 zip 이므로
 * 엔트리를 압축 해제한 뒤 XML 텍스트로 찾는다(sharedStrings 도 포함).
 */
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

test.describe('X0a: XLSX 동시편집', () => {
  test('X0a-1: 두 편집자가 같은 방에 들어가 서로가 보인다', async ({ browser }) => {
    const t = await twoPages(browser)
    try {
      await openXlsxEditing(t.pageA)
      await openXlsxEditing(t.pageB)

      // 양쪽 모두 방에 들어갈 때까지 기다린다.
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => (await collabState(t.pageB)).active, { timeout: 30000, intervals: [500] }).toBe(true)

      const a = await collabState(t.pageA)
      const b = await collabState(t.pageB)
      // 같은 파일이면 같은 방이다.
      expect(a.roomId).toBeTruthy()
      expect(b.roomId).toBe(a.roomId)
      // 서로의 존재가 보인다(presence 2명).
      await expect.poll(async () => (await collabState(t.pageA)).people, { timeout: 20000, intervals: [500] }).toBeGreaterThanOrEqual(2)
      await expect.poll(async () => (await collabState(t.pageB)).people, { timeout: 20000, intervals: [500] }).toBeGreaterThanOrEqual(2)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('X0a-2: A 의 편집이 B 에 반영되고 B 저장으로 디스크에 남는다', async ({ browser }) => {
    const t = await twoPages(browser)
    const stamp = `X0A${Date.now().toString(36)}`
    try {
      await openXlsxEditing(t.pageA)
      await openXlsxEditing(t.pageB)
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => (await collabState(t.pageB)).active, { timeout: 30000, intervals: [500] }).toBe(true)

      // A 가 B2 에 값을 넣는다.
      await setCellByFormulaBar(t.pageA, 'B2', stamp)

      // B 가 그 내용을 받았는지: B 로 저장하고 디스크를 확인한다.
      await t.pageB.waitForTimeout(1500)
      // lib 타이틀바에도 Save 가 있으므로 앱 헤더의 Save 를 특정한다.
      const save = t.pageB.locator('[data-testid="preview-doc-header"]').getByRole('button', { name: 'Save', exact: true })
      await save.waitFor({ timeout: 20000 })
      await save.click({ timeout: 20000 })

      // 저장 완료를 기다린 뒤(파일 내용 변화) 디스크를 본다.
      await expect
        .poll(async () => (await workbookContains(seededAbs(), stamp)) ? stamp : '', { timeout: 25000, intervals: [500] })
        .toBe(stamp)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('X0a-3: 디스크와 어긋난 방에는 붙지 않는다 (오래된 내용으로 덮어쓰기 방지)', async ({ browser }) => {
    const t = await twoPages(browser)
    try {
      // A 가 먼저 방을 만든다(방의 기준 = 지금 디스크의 해시).
      await openXlsxEditing(t.pageA)
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)

      // 디스크의 파일을 다른 내용으로 바꾼다(유효한 xlsx 로 유지).
      const zip = await JSZip.loadAsync(fs.readFileSync(seededAbs()))
      const sheetName = Object.keys(zip.files).find((n) => n.startsWith('xl/worksheets/') && n.endsWith('.xml'))
      expect(sheetName, 'worksheet entry missing').toBeTruthy()
      const sheetXml = await zip.files[sheetName!].async('string')
      zip.file(sheetName!, sheetXml.replace('</sheetData>', '<row r="900"><c r="A900" t="inlineStr"><is><t>ZZZ</t></is></c></row></sheetData>'))
      const changed = await zip.generateAsync({ type: 'nodebuffer' })
      fs.writeFileSync(seededAbs(), changed)

      // B 는 디스크의 새 파일을 읽는다. 방은 옛 해시라 붙으면 안 된다.
      await t.pageB.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
      await openXlsxEditing(t.pageB)
      await t.pageB.waitForTimeout(4000)
      const b = await collabState(t.pageB)
      expect(b.active, 'stale room must not be joined').toBe(false)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })
})
