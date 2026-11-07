import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { backendBase, workspaceDir } from './helpers/env'
import { gotoApp, openEditor } from './helpers/viewer'
import { ADA, seedUser } from './helpers/users'

const FIX = 'e2e/collab/fixtures/ole'

/**
 * K-dbl: 삽입 직후(새로고침 없음) dblclick → 새 탭이 첨부 URL로 열리고 편집 가능.
 * - PPTX: lib 렌더 도형 본문(ole 프레임) dblclick.
 * - XLSX/DOCX: lib이 삽입물을 렌더하지 않아 오버레이 칩이 도형 UI다 → 칩 dblclick.
 * - 열린 탭에서 수정·저장하면 부모 zip에 반영된다.
 * - 파일명 라벨 dblclick도 열린다 (캡션/칩 텍스트).
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

async function sheetTextContains(hostAbs: string, part: string, marker: string): Promise<boolean> {
  // xlsx 파트: 시트/sharedStrings XML 텍스트에 마커가 있어야 한다.
  // (zip 재묶음 바이트 변화만 보면 저장이 빈 껍데기여도 통과한다.)
  const partBytes = await readAttachPart(hostAbs, part)
  const inner = await JSZip.loadAsync(partBytes)
  const names = Object.keys(inner.files).filter(
    (n) => n === 'xl/sharedStrings.xml' || (n.startsWith('xl/worksheets/') && n.endsWith('.xml')),
  )
  if (names.length === 0) return partBytes.includes(Buffer.from(marker))
  for (const n of names) {
    const xml = await inner.file(n)!.async('string')
    if (xml.replace(/<[^>]*>/g, '').includes(marker)) return true
  }
  return false
}

async function resolveAttach(attachUrl: string): Promise<{ parentPath: string; part: string }> {
  // URL 문법은 서버가 판정한다 (클라이언트 문자열 파싱이 아님).
  // GET /api/collab/resolve가 단일 진실 — 스킴이 바뀌어도 테스트는 그대로 둔다.
  const u = new URL(attachUrl)
  const res = await fetch(`${backendBase()}/api/collab/resolve?path=${encodeURIComponent(u.pathname)}`)
  if (!res.ok) throw new Error(`resolve failed: ${res.status} for ${u.pathname}`)
  const body = (await res.json()) as { kind?: string; parentPath?: string; part?: string }
  if (body.kind !== 'attachment' || !body.parentPath || !body.part) {
    throw new Error(`not an attachment url: ${u.pathname} -> ${JSON.stringify(body)}`)
  }
  return { parentPath: body.parentPath, part: body.part }
}

async function expectEditableAttach(attach: Page, nameRe: RegExp): Promise<void> {
  await attach.getByTestId('edit-page').waitFor({ timeout: 30000 })
  await expect(attach.getByTestId('attach-readonly')).toHaveCount(0, { timeout: 15000 })
  // URL이 첨부로 해석되는지는 서버 판정으로 확인한다 (형식 하드코딩 금지).
  const resolved = await resolveAttach(attach.url())
  expect(resolved.part.length).toBeGreaterThan(0)
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
    const { part } = await resolveAttach(popup.url())
    await expect
      .poll(() => partTextContains(hostAbs, part, marker), { timeout: 60000, intervals: [2000] })
      .toBe(true)
    await popup.close().catch(() => {})
    await pageB.close().catch(() => {})
    // 파일명 라벨 dblclick으로도 열린다 (도형 아래 캡션).
    // lib 호환성 토스트가 캡션을 가리면 먼저 닫는다 (사용자와 같은 순서).
    await page.getByText('Dismiss all').first().click({ timeout: 15000 }).catch(() => {})
    const label = page.getByTestId('ole-label').filter({ hasText: /plain\.docx/i }).first()
    await expect(label).toBeVisible({ timeout: 30000 })
    const [popup2] = await Promise.all([
      page.waitForEvent('popup', { timeout: 15000 }),
      label.dblclick({ timeout: 15000 }),
    ])
    await expectEditableAttach(popup2, /plain\.docx/)
    await popup2.close().catch(() => {})
    // 캡션 바로 아래(lib 영역) dblclick은 새 탭을 열지 않는다 (히트 영역 확인).
    // 캡션에 pointer-events:auto를 줘도 lib 상호작용(드래그·선택)을 막지 않는다.
    const lbox2 = await label.boundingBox()
    expect(lbox2, 'ole label box (recheck)').not.toBeNull()
    const openedP = page.waitForEvent('popup', { timeout: 3000 }).then(() => 'opened', () => 'none')
    await page.mouse.dblclick(lbox2!.x + lbox2!.width / 2, lbox2!.y + lbox2!.height + 10)
    await expect(openedP).resolves.toBe('none')
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
    // 삽입 PUT 후 부모가 호스트 바이트를 다시 받으면(페이지 새로고침 아님)
    // 오버레이가 새 파트를 파싱한다 — 칩이 나타날 때까지 기다린다.
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
    const { part } = await resolveAttach(popup.url())
    await popup.getByTestId('attach-save').click({ timeout: 15000 })
    // docx 파트: 타이핑이 <w:t>에 쪼개져도 텍스트 기준으로 확인한다.
    await expect
      .poll(() => partTextContains(hostAbs, part, marker), { timeout: 60000, intervals: [2000] })
      .toBe(true)
    await popup.close().catch(() => {})
    // 파일명 라벨 dblclick으로도 열린다. xlsx 폴백 칩은 파일명을 텍스트로
    // 보여주므로(칩=라벨) 같은 칩을 다시 누른다. 저장 후에도 다시 열리는지 확인한다.
    const [popup2] = await Promise.all([
      page.waitForEvent('popup', { timeout: 15000 }),
      chipX.dblclick({ timeout: 15000 }),
    ])
    await expectEditableAttach(popup2, /plain\.docx/)
    await popup2.close().catch(() => {})
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
    // 삽입 PUT 후 부모가 호스트 바이트를 다시 받으면(페이지 새로고침 아님)
    // 오버레이가 새 파트를 파싱한다 — 칩이 나타날 때까지 기다린다.
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
    const hostAbs = path.join(workspaceDir(), 'repos', seg, 'embed-pdf.docx')
    const { part } = await resolveAttach(popup.url())
    const markerX = `kdbl${Date.now().toString(36)}`
    await bar.fill(markerX)
    await bar.press('Enter')
    await popup.getByTestId('attach-save').click({ timeout: 15000 })
    // 시트 XML 텍스트에 마커가 있어야 한다 (zip 재묶음 바이트 변화만 보지 않는다).
    await expect
      .poll(() => sheetTextContains(hostAbs, part, markerX), { timeout: 60000, intervals: [2000] })
      .toBe(true)
    await popup.close().catch(() => {})
    // 파일명 라벨(도형 아래 캡션) dblclick으로도 열린다.
    const label = page.getByTestId('ole-label').filter({ hasText: /embed-docx/i }).first()
    await expect(label).toBeVisible({ timeout: 30000 })
    const lbox = await label.boundingBox()
    expect(lbox, 'ole label box').not.toBeNull()
    const [popup2] = await Promise.all([
      page.waitForEvent('popup', { timeout: 15000 }),
      page.mouse.dblclick(lbox!.x + lbox!.width / 2, lbox!.y + lbox!.height / 2),
    ])
    await expectEditableAttach(popup2, /embed-docx\.xlsx/)
    await popup2.close().catch(() => {})
  } finally {
    await ctx.close().catch(() => {})
  }
})

test('K-dbl-nosubtle: crypto.subtle 없이도 첨부 열고 편집·저장된다 (http 환경)', async ({ browser }) => {
  // P0-4: subtle이 없어도 GET ETag를 knownHash로 써서 strict 검증한다.
  // addInitScript로 subtle을 지운다 (http 비보안 컨텍스트 재현).
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await ctx.addInitScript(() => {
    try {
      Object.defineProperty(window.crypto, 'subtle', { value: undefined, configurable: true })
    } catch { /* ignore */ }
  })
  await seedUser(ctx, ADA)
  const page = await ctx.newPage()
  await gotoApp(page)
  const seg = `kdblnosub${Date.now()}`
  await mkRepo(seg, ['embed-pdf.pptx'])
  try {
    await openEditor(page, `${seg}/embed-pdf.pptx`)
    await page.getByRole('tab', { name: 'Home' }).first().waitFor({ timeout: 60000 })
    await insertViaTab(page, path.resolve(FIX, 'plain.docx'))
    const frame = page.locator('[data-element-id*="-frame-"]', { hasText: /plain\.docx/i }).first()
    await expect(frame).toBeVisible({ timeout: 60000 })
    const box = await frame.boundingBox()
    expect(box, 'ole frame box').not.toBeNull()
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 15000 }),
      page.mouse.dblclick(box!.x + box!.width / 2, box!.y + box!.height * 0.25),
    ])
    await popup.bringToFront().catch(() => {})
    await expectEditableAttach(popup, /plain\.docx/)
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
    const { part } = await resolveAttach(popup.url())
    await expect
      .poll(() => partTextContains(hostAbs, part, marker), { timeout: 60000, intervals: [2000] })
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
    const { part } = await resolveAttach(popup.url())
    await expect
      .poll(() => partTextContains(hostAbs, part, marker), { timeout: 60000, intervals: [2000] })
      .toBe(true)
    await popup.close().catch(() => {})
  } finally {
    await ctx.close().catch(() => {})
  }
})
