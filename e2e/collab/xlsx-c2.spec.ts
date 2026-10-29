import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
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
  await expect
    .poll(async () => page.evaluate(() => (document.querySelector('xlsx-editor') as unknown as { dirty?: boolean } | null)?.dirty === true), {
      timeout: 15000,
      intervals: [200],
    })
    .toBe(true)
}

/** viewer 화면 내용은 공개 element 메서드 saveBytes() + zip XML 로 읽는다. */
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

  test('C2-a-304: raw 응답은 항상 200 + ETag다 (no-store, 304 없음)', async ({ browser }) => {
    const t = await twoPagesNoSubtle(browser)
    const f = freshXlsx('c2a304', 0)
    const raws: Array<{ status: number; etag: string | null }> = []
    t.pageA.on('response', (res) => {
      try {
        const url = res.url()
        if (url.includes('/api/files/') && url.includes('raw=true')) {
          raws.push({ status: res.status(), etag: res.headers()['etag'] ?? null })
        }
      } catch {
        /* 무시 */
      }
    })
    try {
      await openXlsxEditing(t.pageA, f.name)
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      // 같은 파일을 다시 열어도(브라우저 캐시) ETag가 읽혀야 한다.
      await t.pageA.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
      await openXlsxEditing(t.pageA, f.name)
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      console.log('C2A_RAW ' + JSON.stringify(raws))
      expect(raws.length).toBeGreaterThanOrEqual(2)
      for (const r of raws) {
        expect(r.status).toBe(200)
        expect(r.etag).not.toBeNull()
        expect(r.etag!.length).toBeGreaterThan(0)
      }
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('C2-a-2: subtle 없이 A 편집이 B 화면에 반영된다', async ({ browser }) => {
    const t = await twoPagesNoSubtle(browser)
    const f = freshXlsx('c2a2', 0)
    const stamp = `C2A2${Date.now().toString(36)}`
    try {
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => (await collabState(t.pageB)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      await setCellByFormulaBar(t.pageA, 'B2', stamp)
      // A의 편집이 방을 통해 B 화면에 보인다(X0a-2 상당).
      await expect.poll(async () => liveBytesContain(t.pageB, stamp), { timeout: 30000, intervals: [500] }).toBe(true)
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })

  test('C2-a-3: 디스크가 바뀐 뒤 ETag가 낡은 쪽은 차단된다 (X0a-3 유지)', async ({ browser }) => {
    const t = await twoPagesNoSubtle(browser)
    const f = freshXlsx('c2a3', 0)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await expect.poll(async () => (await collabState(t.pageA)).active, { timeout: 30000, intervals: [500] }).toBe(true)
      // 디스크의 파일을 다른 내용으로 바꾼다(유효한 xlsx 로 유지).
      const zip = await JSZip.loadAsync(fs.readFileSync(f.abs))
      const sheetName = Object.keys(zip.files).find((n) => n.startsWith('xl/worksheets/') && n.endsWith('.xml'))
      expect(sheetName, 'worksheet entry missing').toBeTruthy()
      const sheetXml = await zip.files[sheetName!].async('string')
      zip.file(sheetName!, sheetXml.replace('</sheetData>', '<row r="901"><c r="A901" t="inlineStr"><is><t>C2A3</t></is></c></row></sheetData>'))
      fs.writeFileSync(f.abs, await zip.generateAsync({ type: 'nodebuffer' }))
      // B는 디스크의 새 파일을 읽는다. 방은 옛 해시라 붙으면 안 된다(C2-b에서 자동 복구).
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => (await collabState(t.pageB)).active, { timeout: 20000, intervals: [500] }).toBe(false)
      await expect(t.pageB.locator('[data-testid="xlsx-collab-banner"]')).toBeVisible({ timeout: 15000 })
      // 차단은 stale 판정이어야지 nohash 폴백이 아니다 (subtle 없이도 stale이 동작한다).
      await expect(t.pageB.getByText('https 또는 localhost')).toHaveCount(0)
      await expect(t.pageB.locator('[data-testid="xlsx-collab-banner"]')).toContainText('낡았')
    } finally {
      await t.ctxA.close()
      await t.ctxB.close()
    }
  })
})
