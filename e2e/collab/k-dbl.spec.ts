import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { backendBase, workspaceDir } from './helpers/env'
import { gotoApp, openEditor } from './helpers/viewer'
import { ADA, seedUser } from './helpers/users'

const FIX = 'e2e/collab/fixtures/ole'

/**
 * K-dbl: 삽입 직후(새로고침 없음) 도형 dblclick → 새 탭이 첨부 URL로 열리고 편집 가능.
 * - PPTX/XLSX/DOCX 각 1건. 칩 dblclick이 아니라 lib 렌더 도형 본문 dblclick이다.
 * - 열린 탭에서 수정·저장하면 부모 zip에 반영된다.
 */
async function mkRepo(localPath: string, files: string[]): Promise<void> {
  await fetch(`${backendBase()}/api/repos`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ localPath }),
  })
  const dir = path.join(workspaceDir(), 'repos', localPath)
  fs.mkdirSync(dir, { recursive: true })
  for (const n of files) fs.copyFileSync(path.join(FIX, n), path.join(dir, n))
}

async function insertViaTab(page: Page, attachAbs: string): Promise<void> {
  const tab = page.getByRole('tab', { name: '첨부', exact: true }).first()
  await tab.waitFor({ timeout: 30000 })
  await tab.click({ timeout: 15000 })
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15000 }),
    page.getByText('문서 첨부', { exact: true }).first().click({ timeout: 15000 }),
  ])
  await chooser.setFiles(attachAbs)
}

async function partTextContains(hostAbs: string, part: string, marker: string): Promise<boolean> {
  // docx 단편화(<w:t> 쪼개짐)에 강건: zip→inner docx→document.xml→태그 제거 후 텍스트 비교.
  const partBytes = await readAttachPart(hostAbs, part)
  const inner = await JSZip.loadAsync(partBytes)
  const xmlFile = inner.file('word/document.xml')
  if (!xmlFile) return partBytes.includes(Buffer.from(marker))
  const xml = await xmlFile.async('string')
  const text = xml.replace(/<[^>]*>/g, '')
  return text.includes(marker)
}

async function readAttachPart(hostAbs: string, part: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(fs.readFileSync(hostAbs))
  const f = zip.file(part)
  if (!f) throw new Error('part missing: ' + part)
  return Buffer.from(await f.async('uint8array'))
}

function partPathOf(attachUrl: string): string {
  const segs = new URL(attachUrl).pathname.split('/-/')
  if (segs.length < 2 || !segs[1]) throw new Error('no part in attach url')
  return decodeURIComponent(segs[1]!)
}

async function expectEditableAttach(attach: Page, nameRe: RegExp): Promise<void> {
  await attach.getByTestId('edit-page').waitFor({ timeout: 30000 })
  await expect(attach.getByTestId('attach-readonly')).toHaveCount(0, { timeout: 15000 })
  expect(attach.url()).toMatch(/\/edit\/.+\/-\/.+/)
  await expect(attach.getByTestId('attach-title')).toContainText(nameRe, { timeout: 15000 })
}

test('K-dbl-pptx: 삽입한 docx 도형 dblclick이 새 탭으로 열린다', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await seedUser(ctx, ADA)
  const page = await ctx.newPage()
  await gotoApp(page)
  const seg = `kdblpptx${Date.now()}`
  await mkRepo(seg, ['embed-pdf.pptx'])
  try {
    await openEditor(page, `${seg}/embed-pdf.pptx`)
    await page.getByRole('tab', { name: 'Home' }).first().waitFor({ timeout: 60000 })
    // plain.docx: 중첩 OLE 없는 docx (중첩 OLE는 lib yjs 바인딩 이슈가 있어 별도 추적).
    await insertViaTab(page, path.resolve(FIX, 'plain.docx'))
    // 삽입된 도형: 파일명이 보이는 ole 프레임 (새로고침 없음).
    const frame = page.locator('[data-element-id*="-frame-"]', { hasText: /plain\.docx/i }).first()
    await expect(frame).toBeVisible({ timeout: 60000 })
    const box = await frame.boundingBox()
    expect(box, 'ole frame box').not.toBeNull()
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 15000 }),
      page.mouse.dblclick(box!.x + box!.width / 2, box!.y + box!.height * 0.25),
    ])
    // B-sees-A: yjs 동기화 증명 (서버에 marker가 있어야 B가 본다).
    await popup.bringToFront().catch(() => {})
    await expectEditableAttach(popup, /plain\.docx/)
    const pageB = await ctx.newPage()
    await pageB.goto(popup.url(), { waitUntil: 'domcontentloaded', timeout: 30000 })
    await pageB.locator('docx-editor [contenteditable="true"]').first().waitFor({ timeout: 60000 })
    // 수정 → B에 보이면 yjs가 가진 것이고, 저장은 방 기준 최신을 쓴다.
    const marker = `KDBL${Date.now().toString(36)}`
    await popup.locator('docx-editor').getByText('C5-0 payload').first().click({ timeout: 15000 })
    await popup.keyboard.press('Home')
    await popup.keyboard.type(marker, { delay: 20 })
    await expect
      .poll(() => pageB.locator('docx-editor [contenteditable="true"]').first().textContent(), { timeout: 60000, intervals: [2000] })
      .toContain(marker)
    await popup.getByTestId('attach-save').click({ timeout: 20000 })
    const hostAbs = path.join(workspaceDir(), 'repos', seg, 'embed-pdf.pptx')
    const part = partPathOf(popup.url())
    await expect
      .poll(() => partTextContains(hostAbs, part, marker), { timeout: 60000, intervals: [2000] })
      .toBe(true)
    await popup.close().catch(() => {})
    await pageB.close().catch(() => {})
  } finally {
    await ctx.close().catch(() => {})
  }
})

test('K-dbl-xlsx: 삽입한 docx 도형 dblclick이 새 탭으로 열린다', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await seedUser(ctx, ADA)
  const page = await ctx.newPage()
  await gotoApp(page)
  const seg = `kdblxlsx${Date.now()}`
  await mkRepo(seg, ['embed-pdf.xlsx'])
  try {
    await openEditor(page, `${seg}/embed-pdf.xlsx`)
    await page.locator('xlsx-editor').first().waitFor({ timeout: 60000 })
    // plain.docx: 중첩 OLE 없는 docx (중첩 OLE는 lib yjs 바인딩 이슈가 있어 별도 추적).
    await insertViaTab(page, path.resolve(FIX, 'plain.docx'))
    // xlsx lib는 docx 삽입물을 렌더하지 않아 오버레이 폴백 칩이 도형 UI다.
    // 삽입 후 앱 리로드로 오버레이가 새 파트를 잡을 때까지 칩을 기다린다.
    const chipX = page.getByRole('button', { name: /plain\.docx/i }).first()
    await expect(chipX).toBeVisible({ timeout: 60000 })
    const box = await chipX.boundingBox()
    expect(box, 'ole chip box').not.toBeNull()
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 15000 }),
      page.mouse.dblclick(box!.x + box!.width / 2, box!.y + box!.height / 2),
    ])
    await expectEditableAttach(popup, /plain\.docx/)
    const marker = `KDBL${Date.now().toString(36)}`
    // pptx와 같은 확정 제스처: 본문 텍스트 클릭 → Home → 타이핑.
    await popup.locator('docx-editor').getByText('C5-0 payload').first().click({ timeout: 15000 })
    await popup.keyboard.press('Home')
    await popup.keyboard.type(marker, { delay: 20 })
    // 타이핑이 에디터 DOM에 들어갔는지 먼저 확인 (포커스 미스면 저장이 base가 된다).
    await expect(popup.locator('docx-editor [contenteditable="true"]').first()).toContainText(marker, { timeout: 15000 })
    const hostAbs = path.join(workspaceDir(), 'repos', seg, 'embed-pdf.xlsx')
    const part = partPathOf(popup.url())
    await popup.getByTestId('attach-save').click({ timeout: 15000 })
    // docx 파트: 타이핑이 <w:t>에 쪼개져도 텍스트 기준으로 확인한다.
    await expect
      .poll(() => partTextContains(hostAbs, part, marker), { timeout: 60000, intervals: [2000] })
      .toBe(true)
    await popup.close().catch(() => {})
  } finally {
    await ctx.close().catch(() => {})
  }
})

test('K-dbl-docx: 삽입한 xlsx 도형 dblclick이 새 탭으로 열린다', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await seedUser(ctx, ADA)
  const page = await ctx.newPage()
  await gotoApp(page)
  const seg = `kdbldocx${Date.now()}`
  await mkRepo(seg, ['embed-pdf.docx'])
  try {
    await openEditor(page, `${seg}/embed-pdf.docx`)
    await page.locator('docx-editor [contenteditable="true"]').first().waitFor({ timeout: 60000 })
    await insertViaTab(page, path.resolve(FIX, 'embed-docx.xlsx'))
    // 삽입 후 앱 리로드로 오버레이가 새 파트를 잡을 때까지 칩을 기다린다.
    // (칩은 anchored/폴백 모두 onDoubleClick으로 열린다.)
    const chip = page.getByRole('button', { name: /embed-docx/i }).first()
    await expect(chip).toBeVisible({ timeout: 60000 })
    const box = await chip.boundingBox()
    expect(box, 'ole chip box').not.toBeNull()
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 15000 }),
      page.mouse.dblclick(box!.x + box!.width / 2, box!.y + box!.height / 2),
    ])
    await expectEditableAttach(popup, /embed-docx\.xlsx/)
    // xlsx 파트: 셀 입력 후 저장 → 부모 zip에 반영된다.
    const bar = popup.locator('xlsx-editor [part~=formula-bar] textarea').last()
    await bar.waitFor({ timeout: 30000 })
    await bar.click({ timeout: 15000 })
    await bar.fill(`kdbl${Date.now().toString(36)}`)
    await bar.press('Enter')
    const hostAbs = path.join(workspaceDir(), 'repos', seg, 'embed-pdf.docx')
    const part = partPathOf(popup.url())
    const before = await readAttachPart(hostAbs, part)
    await popup.getByTestId('attach-save').click({ timeout: 15000 })
    await expect
      .poll(async () => !(await readAttachPart(hostAbs, part)).equals(before), { timeout: 60000, intervals: [2000] })
      .toBe(true)
    await popup.close().catch(() => {})
  } finally {
    await ctx.close().catch(() => {})
  }
})

test('K-dbl-nested: 중첩 OLE가 든 docx 삽입물을 편집·저장하면 부모 zip에 반영된다', async ({ browser }) => {
  // C6c-a0 red: embed-docx.docx는 살아있는 <w:object>를 품은 중첩 OLE다.
  // 저장이 200으로 성공해도 파트 바이트에 마커가 없으면 조용한 유실이다.
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await seedUser(ctx, ADA)
  const page = await ctx.newPage()
  await gotoApp(page)
  const seg = `kdblnest${Date.now()}`
  await mkRepo(seg, ['embed-pdf.pptx'])
  try {
    await openEditor(page, `${seg}/embed-pdf.pptx`)
    await page.getByRole('tab', { name: 'Home' }).first().waitFor({ timeout: 60000 })
    await insertViaTab(page, path.resolve(FIX, 'embed-docx.docx'))
    const frame = page.locator('[data-element-id*="-frame-"]', { hasText: /embed-docx\.docx/i }).first()
    await expect(frame).toBeVisible({ timeout: 60000 })
    const box = await frame.boundingBox()
    expect(box, 'ole frame box').not.toBeNull()
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 15000 }),
      page.mouse.dblclick(box!.x + box!.width / 2, box!.y + box!.height * 0.25),
    ])
    await popup.bringToFront().catch(() => {})
    await expectEditableAttach(popup, /embed-docx\.docx/)
    const marker = `KDBL${Date.now().toString(36)}`
    const editable = popup.locator('docx-editor [contenteditable="true"]').first()
    await expect(editable).toBeVisible({ timeout: 60000 })
    await popup.locator('docx-editor').getByText('C5-0 payload').first().click({ timeout: 15000 })
    await editable.focus()
    await popup.keyboard.press('Home')
    await popup.keyboard.type(marker, { delay: 20 })
    await expect(editable).toContainText(marker, { timeout: 15000 })
    await popup.getByTestId('attach-save').click({ timeout: 20000 })
    const hostAbs = path.join(workspaceDir(), 'repos', seg, 'embed-pdf.pptx')
    const part = partPathOf(popup.url())
    await expect
      .poll(() => partTextContains(hostAbs, part, marker), { timeout: 60000, intervals: [2000] })
      .toBe(true)
    await popup.close().catch(() => {})
  } finally {
    await ctx.close().catch(() => {})
  }
})
