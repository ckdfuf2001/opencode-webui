import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { backendBase, workspaceDir } from './helpers/env'
import { gotoApp } from './helpers/viewer'
import { ADA, seedUser } from './helpers/users'

/**
 * C5-4: 편집은 URL 단위로 분리한다 (D64).
 * - 본 파일 편집: /edit/<워크스페이스 경로>
 * - 첨부 편집: /edit/<부모 경로>/-/<파트 경로>
 * - 미리보기 Edit 버튼·첨부 더블클릭은 window.open(url, '_blank') 새 탭.
 * RED: 현재 Edit은 제자리 토글, dblclick은 오버레이 편집기라 popup이 없다.
 */
const FIX = 'e2e/collab/fixtures/ole'

async function mkRepo(localPath: string, files: string[]): Promise<void> {
  const mk = await fetch(`${backendBase()}/api/repos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ localPath }),
  }).then((r) => r.json())
  const repoId = (mk as { id?: number })?.id
  if (!repoId) throw new Error('repo created failed')
  const dir = path.join(workspaceDir(), 'repos', localPath)
  fs.mkdirSync(dir, { recursive: true })
  for (const n of files) fs.copyFileSync(path.join(FIX, n), path.join(dir, n))
}

async function openViaWorkspace(page: Page, name: string, seg: string, hostSel: string): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const closer = page.locator('[aria-label="Close explorer"]')
    try {
      if (await closer.first().isVisible({ timeout: 2000 })) {
        await closer.first().click({ timeout: 5000 })
        await page.waitForTimeout(1000)
      } else break
    } catch {
      break
    }
  }
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
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-row"]').length > 0, null, {
        timeout: 10000,
      })
      break
    } catch {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(2000)
    }
  }
  const marked = await page.evaluate(
    ([n, s]) => {
      const rows = [...document.querySelectorAll('[data-testid="file-row"]')]
      rows.forEach((e) => e.removeAttribute('data-c54-target'))
      const row = rows.find((r) => {
        const p = (r.getAttribute('data-path') || '').replace(/\\/g, '/')
        return p === `${s}/${n}` || p.endsWith(`/${s}/${n}`)
      })
      if (!row) return false
      row.setAttribute('data-c54-target', '1')
      return true
    },
    [name, seg],
  )
  if (!marked) throw new Error(`row not found ${seg}/${name}`)
  await page.locator('[data-c54-target="1"]').locator('span', { hasText: name }).first().click({ timeout: 20000 })
  await page.waitForSelector(hostSel, { timeout: 60000 })
  await page.waitForTimeout(4000)
}

async function attachViaAddInTab(page: Page, attachAbs: string): Promise<void> {
  await page.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20000 })
  const tab = page.getByRole('tab', { name: '첨부', exact: true }).first()
  await tab.waitFor({ timeout: 30000 })
  await tab.click({ timeout: 15000 })
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15000 }),
    page.getByText('문서 첨부', { exact: true }).first().click({ timeout: 15000 }),
  ])
  await chooser.setFiles(attachAbs)
}

async function embeddingsCount(localPath: string, name: string): Promise<number> {
  try {
    const b = fs.readFileSync(path.join(workspaceDir(), 'repos', localPath, name))
    const z = await JSZip.loadAsync(b)
    return Object.keys(z.files).filter((n) => n.includes('embeddings/') && !n.endsWith('/')).length
  } catch {
    return -1
  }
}

test.describe('C5-4: URL 편집 분리', () => {
  test('U-open-host: 미리보기 Edit 버튼이 /edit/<경로> 새 탭을 연다', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c54host', ['embed-pdf.xlsx'])
    try {
      await openViaWorkspace(page, 'embed-pdf.xlsx', 'c54host', '.xlsxengine-host')
      const [popup] = await Promise.all([
        page.waitForEvent('popup', { timeout: 15000 }),
        page.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20000 }),
      ])
      await popup.waitForLoadState('domcontentloaded', { timeout: 30000 })
      expect(popup.url()).toMatch(/\/edit\/.+\.xlsx/)
      expect(popup.url()).not.toContain('/-/')
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('U-open-part-xlsx: xlsx 첨부 dblclick이 /edit/<부모>/-/<파트> 새 탭을 연다', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c54xlsx', ['embed-pdf.xlsx'])
    try {
      await openViaWorkspace(page, 'embed-pdf.xlsx', 'c54xlsx', '.xlsxengine-host')
      const emb0 = await embeddingsCount('c54xlsx', 'embed-pdf.xlsx')
      await attachViaAddInTab(page, path.resolve(FIX, 'embed-docx.docx'))
      await expect
        .poll(() => embeddingsCount('c54xlsx', 'embed-pdf.xlsx'), { timeout: 30000, intervals: [1000] })
        .toBe(emb0 + 1)
      await expect(page.getByTestId('ole-icon')).toHaveCount(2, { timeout: 60000 })
      const [popup] = await Promise.all([
        page.waitForEvent('popup', { timeout: 15000 }),
        page.getByTestId('ole-icon').nth(1).dblclick({ timeout: 15000 }),
      ])
      await popup.waitForLoadState('domcontentloaded', { timeout: 30000 })
      expect(popup.url()).toMatch(/\/edit\/.+\.xlsx\/-\/.+\.docx/)
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('U-open-part-pptx: pptx 첨부 dblclick이 /edit/<부모>/-/<파트> 새 탭을 연다', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c54pptx', ['embed-pdf.pptx'])
    try {
      await openViaWorkspace(page, 'embed-pdf.pptx', 'c54pptx', '[data-testid="pptx-viewer-root"]')
      const emb0 = await embeddingsCount('c54pptx', 'embed-pdf.pptx')
      await attachViaAddInTab(page, path.resolve(FIX, 'embed-docx.docx'))
      await expect
        .poll(() => embeddingsCount('c54pptx', 'embed-pdf.pptx'), { timeout: 30000, intervals: [1000] })
        .toBe(emb0 + 1)
      await expect(page.getByTestId('ole-icon')).toHaveCount(2, { timeout: 60000 })
      const [popup] = await Promise.all([
        page.waitForEvent('popup', { timeout: 15000 }),
        page.getByTestId('ole-icon').nth(1).dblclick({ timeout: 15000 }),
      ])
      await popup.waitForLoadState('domcontentloaded', { timeout: 30000 })
      expect(popup.url()).toMatch(/\/edit\/.+\.pptx\/-\/.+\.docx/)
    } finally {
      await ctx.close().catch(() => {})
    }
  })
})
