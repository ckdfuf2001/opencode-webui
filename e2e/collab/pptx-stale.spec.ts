import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { backendBase, workspaceDir } from './helpers/env'
import { gotoApp, openEditor } from './helpers/viewer'
import { ADA, seedUser } from './helpers/users'

const FIX = 'e2e/collab/fixtures/ole'

async function mkRepo(localPath: string, files: string[]): Promise<void> {
  await fetch(`${backendBase()}/api/repos`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ localPath }),
  })
  const dir = path.join(workspaceDir(), 'repos', localPath)
  fs.mkdirSync(dir, { recursive: true })
  for (const n of files) fs.copyFileSync(path.join(FIX, n), path.join(dir, n))
}

async function slideText(hostAbs: string): Promise<string> {
  const zip = await JSZip.loadAsync(fs.readFileSync(hostAbs))
  const xml = await zip.file('ppt/slides/slide1.xml')!.async('string')
  return xml.replace(/<[^>]*>/g, '')
}

/**
 * P0-2: 낡은 PPT 저장은 conflict로 막히고, 토스트 + 내 사본 다운로드가 뜬다.
 * - A가 편집·저장한다 (서버 H1).
 * - 디스크를 외부에서 바꾼다 (H2, 서버가 모르는 변경).
 * - A가 다시 편집·저장하면 conflict_external (재시도 없음) → 배너 + 내 사본.
 * - 디스크에는 A의 두 번째 입력이 없다 (덮어쓰기 없음).
 */
test('P0-2-pptx-stale: 외부 변경 뒤 낡은 저장은 막히고 내 사본이 제공된다', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await seedUser(ctx, ADA)
  const page = await ctx.newPage()
  try {
    await gotoApp(page)
    const seg = `p02stale${Date.now()}`
    await mkRepo(seg, ['embed-pdf.pptx'])
    await openEditor(page, `${seg}/embed-pdf.pptx`)
    await page.getByTestId('pptx-viewer-root').first().waitFor({ timeout: 60000 })
    const hostAbs = path.join(workspaceDir(), 'repos', seg, 'embed-pdf.pptx')

    // A1: 슬라이드 텍스트 편집 → 자동저장으로 디스크에 반영될 때까지 대기.
    const m1 = `P0XA${Date.now().toString(36)}`
    const shapeA = page.locator('[data-element-id]', { hasText: 'C5-0 host' }).first()
    await shapeA.click({ timeout: 15000 })
    await page.evaluate(() => {
      const els = [...document.querySelectorAll('[data-element-id]')]
      const el = els.find((e) => (e.textContent || '').includes('C5-0 host'))
      el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    await page.waitForFunction(() => document.querySelectorAll('textarea, [contenteditable="true"]').length > 0, null, { timeout: 15000 })
    await page.keyboard.type(m1, { delay: 20 })
    await expect
      .poll(() => slideText(hostAbs).then((t) => (t.includes(m1) ? m1 : '')), { timeout: 90000, intervals: [2000] })
      .toBe(m1)

    // 외부에서 디스크를 바꾼다 (서버가 모르는 변경 → H2).
    const mExt = `P0XX${Date.now().toString(36)}`
    {
      const zip = await JSZip.loadAsync(fs.readFileSync(hostAbs))
      const cur = await zip.file('ppt/slides/slide1.xml')!.async('string')
      zip.file('ppt/slides/slide1.xml', cur.replace('C5-0 host', `C5-0 host ${mExt}`))
      fs.writeFileSync(hostAbs, await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
    }

    // A2: 다시 편집 → 수동 저장 → conflict_external (재시도 없음).
    const m2 = `P0XB${Date.now().toString(36)}`
    const shapeA2 = page.locator('[data-element-id]', { hasText: 'C5-0 host' }).first()
    await shapeA2.click({ timeout: 15000 })
    await page.evaluate(() => {
      const els = [...document.querySelectorAll('[data-element-id]')]
      const el = els.find((e) => (e.textContent || '').includes('C5-0 host'))
      el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    await page.waitForFunction(() => document.querySelectorAll('textarea, [contenteditable="true"]').length > 0, null, { timeout: 15000 })
    await page.keyboard.type(m2, { delay: 20 })
    await page.getByTestId('preview-editor-actions').getByRole('button', { name: 'Save', exact: true }).click({ timeout: 15000 })
    // 배너에 내 사본 다운로드가 뜬다 (실패한 내역을 버리지 않는다).
    await expect(page.getByRole('link', { name: /내 사본/ }).first()).toBeVisible({ timeout: 30000 })
    // 디스크는 외부 변경 + A1 그대로, A2는 반영되지 않는다.
    const t = await slideText(hostAbs)
    expect(t).toContain(m1)
    expect(t).toContain(mExt)
    expect(t).not.toContain(m2)
    await page.close().catch(() => {})
  } finally {
    await ctx.close().catch(() => {})
  }
})
