import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { backendBase, workspaceDir, absForRel, uniqueRel, uniqueRelWithExt } from './helpers/env'
import { gotoApp, openEditor, openFileSeeded, gotoSlide, editShapeText, ShapeLocator, peer } from './helpers/viewer'
import { waitForDisk, readDeck } from './helpers/disk'
import { ADA, GRACE, seedUser } from './helpers/users'

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

/** U-stale: 부모 zip 안의 첨부 파트를 통째로 교체한다 (외부 변경 시뮬레이션). 유효한 xlsx 유지. */
async function tamperAttachPart(hostAbs: string, part: string, marker: string): Promise<Buffer> {
  const host = fs.readFileSync(hostAbs)
  const zip = await JSZip.loadAsync(host)
  const f = zip.file(part)
  if (!f) throw new Error('part missing: ' + part)
  const inner = await JSZip.loadAsync(await f.async('uint8array'))
  const ssNames = Object.keys(inner.files).filter((n) => n === 'xl/sharedStrings.xml')
  if (ssNames.length === 0) throw new Error('no sharedStrings in part')
  const sn = ssNames[0]!
  let xml = await inner.file(sn)!.async('string')
  const m = /<t>([^<]*)<\/t>/.exec(xml)
  if (!m) throw new Error('no <t> in sharedStrings')
  xml = xml.slice(0, m.index) + `<t>${m[1]}${marker}</t>` + xml.slice(m.index + m[0].length)
  inner.file(sn, xml)
  const partBytes = Buffer.from(await inner.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
  zip.file(part, partBytes)
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  fs.writeFileSync(hostAbs, out)
  return partBytes
}

/** U-stale: 디스크 부모 파일에서 첨부 파트를 읽는다. */
async function readAttachPart(hostAbs: string, part: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(fs.readFileSync(hostAbs))
  const f = zip.file(part)
  if (!f) throw new Error('part missing: ' + part)
  return Buffer.from(await f.async('uint8array'))
}

/** U-parent: xlsx 바이트 안의 모든 XML에 마커가 있는지 (셀 값·공유 문자열 모두 탐지). */
async function xlsxBytesContain(partBytes: Uint8Array, marker: string): Promise<boolean> {
  try {
    const inner = await JSZip.loadAsync(partBytes)
    const names = Object.keys(inner.files).filter((n) => n.endsWith('.xml'))
    for (const n of names) {
      const t = await inner.file(n)!.async('string')
      if (t.includes(marker)) return true
    }
    return false
  } catch {
    return false
  }
}

/** U-parent: 호스트 xlsx 자체에 마커가 있는지 (첨부 제외 본문 시트). */
async function xlsxContains(abs: string, marker: string): Promise<boolean> {
  try {
    return await xlsxBytesContain(new Uint8Array(fs.readFileSync(abs)), marker)
  } catch {
    return false
  }
}

/** U-parent: 디스크 부모 파일의 첨부 파트에 마커가 있는지. */
async function partContains(hostAbs: string, part: string, marker: string): Promise<boolean> {
  try {
    return await xlsxBytesContain(new Uint8Array(await readAttachPart(hostAbs, part)), marker)
  } catch {
    return false
  }
}

/** U-http: 파트 xlsx 바이트의 공유 문자열에 마커를 추가한다. */
async function tamperPartXlsx(partBytes: Uint8Array, marker: string): Promise<Buffer> {
  const inner = await JSZip.loadAsync(partBytes)
  const sn = 'xl/sharedStrings.xml'
  const f = inner.file(sn)
  if (!f) throw new Error('no sharedStrings in part')
  let xml = await f.async('string')
  const m = /<t>([^<]*)<\/t>/.exec(xml)
  if (!m) throw new Error('no <t> in sharedStrings')
  xml = xml.slice(0, m.index) + `<t>${m[1]}${marker}</t>` + xml.slice(m.index + m[0].length)
  inner.file(sn, xml)
  return Buffer.from(await inner.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
}

function partPathOf(attachUrl: string): string {
  const segs = new URL(attachUrl).pathname.split('/-/')
  if (segs.length < 2 || !segs[1]) throw new Error('no part in attach url')
  return decodeURIComponent(segs[1]!)
}

function partHashOf(attachUrl: string): string | null {
  return new URL(attachUrl).searchParams.get('partHash')
}

/** 서버 rooms API에서 이 파일의 방 참가자 목록을 읽는다 (U-close 방 정리 단언용). */
async function roomsForFile(fileName: string): Promise<Array<{ id?: unknown; name?: unknown }>> {
  const res = await fetch(`${backendBase()}/api/collab/rooms`)
  const body = (await res.json().catch(() => null)) as {
    rooms?: Array<{ rel: string; participants?: Array<{ id?: unknown; name?: unknown }> }>
  } | null
  const rooms = body?.rooms ?? []
  const mine = rooms.filter((r) => r.rel.endsWith(fileName))
  if (mine.length === 0) return []
  return mine[0]?.participants ?? []
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
  for (let i = 0; i < 8; i++) {
    const has = await page.evaluate(
      ([n, s]) =>
        [...document.querySelectorAll('[data-testid="file-row"]')].some((r) => {
          const p = (r.getAttribute('data-path') || '').replace(/\\/g, '/')
          return p === `${s}/${n}` || p.endsWith(`/${s}/${n}`)
        }),
      [name, seg],
    )
    if (has) break
    await page.evaluate((s) => {
      const rows = [...document.querySelectorAll('[data-testid="file-row"]')]
      const folder =
        rows.find((r) => {
          const p = (r.getAttribute('data-path') || '').replace(/\\/g, '/')
          return p === (s as string) || p.endsWith('/' + (s as string))
        }) ?? rows.find((r) => !(r.getAttribute('data-path') || '').includes('.'))
      const inner = folder?.querySelector('div.flex-1') ?? folder?.querySelector('div')
      inner?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, seg)
    await page.waitForTimeout(2000)
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

async function attachViaAddInTab(page: Page, attachAbs: string): Promise<Page> {
  // C5-4: Edit은 /edit/* 새 탭을 연다. 첨부 탭 조작은 에디터 탭에서 계속한다.
  const [editor] = await Promise.all([
    page.waitForEvent('popup', { timeout: 15000 }),
    page.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20000 }),
  ])
  await editor.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {})
  const tab = editor.getByRole('tab', { name: '첨부', exact: true }).first()
  await tab.waitFor({ timeout: 30000 })
  await tab.click({ timeout: 15000 })
  const [chooser] = await Promise.all([
    editor.waitForEvent('filechooser', { timeout: 15000 }),
    editor.getByText('문서 첨부', { exact: true }).first().click({ timeout: 15000 }),
  ])
  await chooser.setFiles(attachAbs)
  return editor
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

/** 수식 바에 값을 넣어 셀을 편집한다(그리드는 canvas라 수식 바가 확정 경로). */
async function setCellByFormulaBar(page: Page, ref: string, value: string): Promise<void> {
  await page.evaluate((r) => {
    const el = document.querySelector('xlsx-editor') as unknown as { select?: (ref: string) => void; focusGrid?: () => void } | null
    el?.select?.(r)
    el?.focusGrid?.()
  }, ref)
  // 수식 입력은 textarea (input은 네임박스일 수 있어 Enter가 셀로 확정되지 않는다 — E2-unsaved proven pattern).
  const bar = page.locator('xlsx-editor [part~="formula-bar"] textarea').last()
  await bar.waitFor({ timeout: 15000 })
  await bar.click({ timeout: 15000 })
  await bar.fill(value)
  await bar.press('Enter')
  // Enter가 에디터 초기화 레이스로 씹히면 dirty가 안 선다 (c5-1과 같은 패턴, 최대 3회 재시도).
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await expect
        .poll(async () => page.evaluate(() => (document.querySelector('xlsx-editor') as unknown as { dirty?: boolean } | null)?.dirty === true), {
          timeout: 8000,
          intervals: [200],
        })
        .toBe(true)
      return
    } catch {
      await bar.click({ timeout: 15000 }).catch(() => {})
      await bar.fill(value)
      await bar.press('Enter')
    }
  }
  await expect
    .poll(async () => page.evaluate(() => (document.querySelector('xlsx-editor') as unknown as { dirty?: boolean } | null)?.dirty === true), {
      timeout: 15000,
      intervals: [200],
    })
    .toBe(true)
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

  test('U-open-part-xlsx: xlsx package 첨부 dblclick이 /edit/<부모>/-/<파트> 새 탭을 연다', async ({ browser }) => {
    // P0-4: 실제 삽입 경로(INSERT 리본 → 서버 조립)로 검증한다. zip 직접 수정 금지.
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c54xlsx', ['embed-pdf.xlsx'])
    try {
      await openViaWorkspace(page, 'embed-pdf.xlsx', 'c54xlsx', '.xlsxengine-host')
      const emb0 = await embeddingsCount('c54xlsx', 'embed-pdf.xlsx')
      const editor = await attachViaAddInTab(page, path.resolve(FIX, 'embed-docx.docx'))
      await expect
        .poll(() => embeddingsCount('c54xlsx', 'embed-pdf.xlsx'), { timeout: 30000, intervals: [1000] })
        .toBe(emb0 + 1)
      await expect(editor.getByTestId('ole-icon')).toHaveCount(2, { timeout: 60000 })
      const icon = editor.locator('[data-testid="ole-icon"][title*="embed-docx.docx"]')
      await icon.waitFor({ timeout: 30000 })
      const [popup] = await Promise.all([
        editor.waitForEvent('popup', { timeout: 15000 }),
        icon.dblclick({ timeout: 15000 }),
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
      const editor = await attachViaAddInTab(page, path.resolve(FIX, 'embed-docx.docx'))
      await expect
        .poll(() => embeddingsCount('c54pptx', 'embed-pdf.pptx'), { timeout: 30000, intervals: [1000] })
        .toBe(emb0 + 1)
      await expect(editor.getByTestId('ole-icon')).toHaveCount(2, { timeout: 60000 })
      const [popup] = await Promise.all([
        editor.waitForEvent('popup', { timeout: 15000 }),
        editor.getByTestId('ole-icon').nth(1).dblclick({ timeout: 15000 }),
      ])
      await popup.waitForLoadState('domcontentloaded', { timeout: 30000 })
      expect(popup.url()).toMatch(/\/edit\/.+\.pptx\/-\/.+\.docx/)
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('U-done-close: 에디터 탭 Done이 성공 저장 뒤 탭을 닫는다', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c54done', ['embed-pdf.xlsx'])
    try {
      await openViaWorkspace(page, 'embed-pdf.xlsx', 'c54done', '.xlsxengine-host')
      const [editor] = await Promise.all([
        page.waitForEvent('popup', { timeout: 15000 }),
        page.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20000 }),
      ])
      await editor.waitForSelector('xlsx-editor', { timeout: 30000 })
      await editor.getByRole('button', { name: 'Done', exact: true }).click({ timeout: 20000 })
      // P0-2/P0-3: 명시적 onDone + opener 있는 window.open이면 탭이 닫힌다.
      await editor.waitForEvent('close', { timeout: 15000 })
      expect(editor.isClosed()).toBe(true)
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('U-done-fail-keeps-open: 저장 실패 시 탭이 닫히지 않고 사본 다운로드를 제공한다', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c54donefail', ['embed-pdf.xlsx'])
    const hostAbs = path.join(workspaceDir(), 'repos', 'c54donefail', 'embed-pdf.xlsx')
    try {
      await openViaWorkspace(page, 'embed-pdf.xlsx', 'c54donefail', '.xlsxengine-host')
      const [editor] = await Promise.all([
        page.waitForEvent('popup', { timeout: 15000 }),
        page.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20000 }),
      ])
      await editor.waitForSelector('xlsx-editor', { timeout: 30000 })
      await setCellByFormulaBar(editor, 'A1', 'c54-stale-stamp')
      // 외부 변경: 자동 저장(2.5s 디바운스)이 나가기 전에 디스크를 갈아끼운다.
      fs.copyFileSync(path.join('e2e/collab/fixtures', 'collab-features.xlsx'), hostAbs)
      // 자동 저장이 409 conflict_external로 막히면 배너+사본 다운로드가 뜬다.
      await editor.getByTestId('xlsx-collab-banner').waitFor({ timeout: 30000 })
      await editor.getByRole('button', { name: 'Done', exact: true }).click({ timeout: 20000 })
      // 확인 대화상자는 Playwright가 기본 거부(취소)한다 → 편집 화면에 남는다.
      await editor.waitForTimeout(3000)
      expect(editor.isClosed()).toBe(false)
      await expect(editor.getByTestId('xlsx-collab-download')).toBeVisible({ timeout: 15000 })
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('U-pollers-quiet: 편집 탭에서는 세션·헬스 폴링이 나가지 않는다', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c54quiet', ['embed-pdf.xlsx'])
    try {
      await openViaWorkspace(page, 'embed-pdf.xlsx', 'c54quiet', '.xlsxengine-host')
      const [editor] = await Promise.all([
        page.waitForEvent('popup', { timeout: 15000 }),
        page.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20000 }),
      ])
      await editor.waitForSelector('xlsx-editor', { timeout: 30000 })
      // P0-6: 편집 탭의 Pollers(세션 2s·헬스 3s)는 낭비다. 8초 관측하면 최소 2회씩 잡힌다.
      const hits: string[] = []
      editor.on('request', (req) => {
        const u = req.url()
        if (u.includes('/api/health') || u.includes('/api/session-status')) hits.push(u)
      })
      await editor.waitForTimeout(8000)
      expect(hits).toEqual([])
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('U-close: 마지막 퇴장 뒤 방이 비고 정리된다 x10', async ({ browser }, testInfo) => {
    // U-close: 참가자 0 + WS 0. 마지막 탭을 닫으면 서버 방에서 참가자가 사라져야 한다.
    // (룸 객체 정리는 30s sweep 뒤 — 여기서는 참가자 0을 단언한다.)
    testInfo.setTimeout(600000)
    const FIX = 'e2e/collab/fixtures/collab-3slides.pptx'
    for (let i = 0; i < 10; i++) {
      const rel = uniqueRel(`uclose-${i}`, 0)
      const abs = absForRel(rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.copyFileSync(FIX, abs)
      const fname = rel.split('/').pop()!
      const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      await seedUser(ctxA, ADA)
      const pageA = await ctxA.newPage()
      await gotoApp(pageA)
      const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      await seedUser(ctxB, GRACE)
      const pageB = await ctxB.newPage()
      await gotoApp(pageB)
      try {
        await openEditor(pageA, rel.replace(/^repos\//, ''))
        await gotoSlide(pageA, 2)
        await openFileSeeded(pageB, fname, rel)
        await gotoSlide(pageB, 2)
        await expect
          .poll(async () => roomsForFile(fname).then((r) => r.length), { timeout: 30000, intervals: [1000] })
          .toBe(2)
      } finally {
        await ctxA.close().catch(() => {})
        await ctxB.close().catch(() => {})
      }
      // 두 탭을 닫으면 서버 방 참가자가 0이 되거나 방이 사라진다.
      await expect
        .poll(async () => roomsForFile(fname).then((r) => r.length), { timeout: 45000, intervals: [1000] })
        .toBe(0)
    }
  })

  test('U-close: 떠난 참가자가 피어 목록에서 사라진다 (유령 없음)', async ({ browser }, testInfo) => {
    testInfo.setTimeout(300000)
    const FIX = 'e2e/collab/fixtures/collab-3slides.pptx'
    const rel = uniqueRel('uclose-ghost', 0)
    const abs = absForRel(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.copyFileSync(FIX, abs)
    const fname = rel.split('/').pop()!
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    await seedUser(ctxA, ADA)
    const pageA = await ctxA.newPage()
    await gotoApp(pageA)
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    await seedUser(ctxB, GRACE)
    const pageB = await ctxB.newPage()
    await gotoApp(pageB)
    try {
      await openEditor(pageA, rel.replace(/^repos\//, ''))
      await gotoSlide(pageA, 2)
      await openFileSeeded(pageB, fname, rel)
      await gotoSlide(pageB, 2)
      await expect(peer(pageB, 'u-ada')).toBeVisible({ timeout: 15000 })
      await ctxA.close()
      // A가 나가면 B 화면에서 A 행이 사라진다 (유령·폴백 '1' 없음).
      await expect(peer(pageB, 'u-ada')).toBeHidden({ timeout: 15000 })
      await expect
        .poll(async () => peer(pageB, 'u-ada').count(), { timeout: 15000, intervals: [500] })
        .toBe(0)
    } finally {
      await ctxA.close().catch(() => {})
      await ctxB.close().catch(() => {})
    }
    void testInfo
  })

  test('U-close: 저장 안 된 편집 탭을 닫으려 하면 브라우저가 확인한다', async ({ browser }, testInfo) => {
    testInfo.setTimeout(300000)
    // U-close 근본 수정: 조용한 유실 대신 beforeunload 확인. 자동 저장이 끝나면 묻지 않는다.
    const FIX = 'e2e/collab/fixtures/collab-3slides.pptx'
    const rel = uniqueRel('uclose-dirty', 0)
    const abs = absForRel(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.copyFileSync(FIX, abs)
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    try {
      await openEditor(page, rel.replace(/^repos\//, ''))
      await gotoSlide(page, 2)
      // 오프라인으로 자동 저장을 막고 타이핑 → 저장 안 됨이 확정된다.
      await ctx.setOffline(true)
      const shapes = new ShapeLocator(page)
      await editShapeText(page, shapes, 'Body 2', 'unsaved-stuff')
      const seen: string[] = []
      page.on('dialog', (d) => {
        seen.push(d.type())
        void d.dismiss().catch(() => {})
      })
      await page.goto('about:blank').catch(() => {})
      // beforeunload 확인이 떠서 머문다.
      expect(seen).toContain('beforeunload')
      expect(page.url()).toMatch(/\/edit\//)
      // 온라인 복귀 → 자동 저장 후에는 조용히 나간다.
      await ctx.setOffline(false)
      await waitForDisk(abs, (d) => (d.textOf('Body 2') ?? '').includes('unsaved-stuff'), 30000)
      seen.length = 0
      await page.goto('about:blank')
      expect(seen).not.toContain('beforeunload')
    } finally {
      await ctx.close().catch(() => {})
    }
    void testInfo
  })

  test('U-stale-1: 외부에서 바뀐 첨부는 덮어쓰지 않고 새로고침한다', async ({ browser }, testInfo) => {
    // U-stale: PUT이 partHash를 대조해 stale_part로 막는다. 조용 덮어쓰기 금지.
    testInfo.setTimeout(420000)
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c54stale1', ['embed-pdf.xlsx'])
    const hostAbs = path.join(workspaceDir(), 'repos', 'c54stale1', 'embed-pdf.xlsx')
    try {
      await openViaWorkspace(page, 'embed-pdf.xlsx', 'c54stale1', '.xlsxengine-host')
      const editor = await attachViaAddInTab(page, path.resolve(FIX, 'embed-docx.xlsx'))
      await expect(editor.getByTestId('ole-icon')).toHaveCount(2, { timeout: 60000 })
      const icon = editor.locator('[data-testid="ole-icon"][title*="embed-docx.xlsx"]')
      await icon.waitFor({ timeout: 30000 })
      const [attach] = await Promise.all([
        editor.waitForEvent('popup', { timeout: 15000 }),
        icon.dblclick({ timeout: 15000 }),
      ])
      await attach.waitForLoadState('domcontentloaded', { timeout: 30000 })
      await attach.locator('xlsx-editor [part~=formula-bar] textarea').first().waitFor({ timeout: 60000 })
      // 편집 시작 (저장 안 함).
      await setCellByFormulaBar(attach, 'A1', 'stale-probe-1')
      // 외부 변경: 부모 디스크의 파트를 통째로 교체한다.
      const part = partPathOf(attach.url())
      const extBytes = await tamperAttachPart(hostAbs, part, '-EXT')
      expect(extBytes.length).toBeGreaterThan(0)
      // 저장 시도 → stale_part → 새로고침 (덮어쓰기 금지).
      await attach.getByTestId('attach-save').click({ timeout: 20000 })
      // 디스크 파트는 외부 내용 그대로여야 한다.
      await expect
        .poll(async () => (await readAttachPart(hostAbs, part)).equals(extBytes), { timeout: 15000, intervals: [500] })
        .toBe(true)
      // 새로고침 완료 증거: URL에 새 파트 해시가 찍힌다.
      const { createHash } = await import('node:crypto')
      const extHash = createHash('sha256').update(extBytes).digest('hex')
      await expect
        .poll(() => Promise.resolve(partHashOf(attach.url())), { timeout: 15000, intervals: [500] })
        .toBe(extHash)
      // stale 알림이 떴다.
      await expect(attach.locator('[data-sonner-toast]').filter({ hasText: '다른 곳에서 변경' })).toHaveCount(1, { timeout: 15000 })
    } finally {
      await ctx.close().catch(() => {})
    }
    void testInfo
  })

/** U-stale: 부모 zip 안의 임베딩 파트 목록 (서버 listEmbedParts와 동등). */
async function listEmbeddedParts(hostAbs: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(fs.readFileSync(hostAbs))
  return Object.keys(zip.files).filter((n) => n.includes('embeddings/') && !n.endsWith('/'))
}

  test('U-stale-2: ?partHash=가 다르면 경고를 보여주고 최신으로 연다', async ({ browser }, testInfo) => {
    // U-stale: 딥링크 버전과 디스크가 다르면 조용히 열지 않고 알린다.
    testInfo.setTimeout(420000)
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c54stale2', ['embed-pdf.xlsx'])
    const hostAbs = path.join(workspaceDir(), 'repos', 'c54stale2', 'embed-pdf.xlsx')
    try {
      const before = await listEmbeddedParts(hostAbs)
      await openViaWorkspace(page, 'embed-pdf.xlsx', 'c54stale2', '.xlsxengine-host')
      await attachViaAddInTab(page, path.resolve(FIX, 'embed-docx.xlsx'))
      let part = ''
      await expect
        .poll(async () => {
          const after = await listEmbeddedParts(hostAbs)
          const added = after.filter((p) => !before.includes(p))
          if (added.length > 0) part = added[0]!
          return added.length
        }, { timeout: 60000, intervals: [1000] })
        .toBe(1)
      const enc = (s: string): string => s.split('/').map((x) => encodeURIComponent(x)).join('/')
      // editUrls.ts와 같은 형식(/edit/<경로>/-/<파트>)으로 직접 구성한다.
      const origin = new URL(page.url()).origin
      const base = `${origin}/edit/${enc('c54stale2/embed-pdf.xlsx')}/-/${enc(part)}?e2e=1&collabDebug=1`
      // bogus 해시로 열면 경고를 보여주고 최신으로 연다.
      const bogus = new URL(base)
      bogus.searchParams.set('partHash', '0'.repeat(64))
      const page2 = await ctx.newPage()
      await page2.goto(bogus.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 })
      await expect(page2.locator('[data-sonner-toast]').filter({ hasText: '첨부가 바뀌었습니다' })).toHaveCount(1, { timeout: 15000 })
      await page2.locator('xlsx-editor [part~=formula-bar] textarea').first().waitFor({ timeout: 60000 })
      await page2.close()
    } finally {
      await ctx.close().catch(() => {})
    }
    void testInfo
  })

  test('U-popup-blocked: 새 탭이 차단되면 대체 링크를 보여준다', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    // 팝업 차단 시뮬레이션: window.open이 null을 돌려준다 (이후 내비게이션에 적용).
    await page.addInitScript(() => {
      ;(window as unknown as { open: unknown }).open = () => null
    })
    await gotoApp(page)
    await mkRepo('c54blocked', ['embed-pdf.xlsx'])
    try {
      await openViaWorkspace(page, 'embed-pdf.xlsx', 'c54blocked', '.xlsxengine-host')
      await page.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20000 })
      // P0-3: 차단되면 토스트+직접 열 수 있는 링크를 보여준다 (조용한 무응답 금지).
      await expect(page.getByTestId('edit-popup-blocked')).toBeVisible({ timeout: 15000 })
      const href = await page.getByTestId('edit-popup-blocked-link').getAttribute('href')
      expect(href ?? '').toMatch(/\/edit\/.+\.xlsx/)
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('U-parent: 부모 미저장 상태에서 첨부 저장 — 409 뒤 복구하면 둘 다 생존', async ({ browser }, testInfo) => {
    // D64 U-parent: 서버가 부모 방 owner에게 WS flush를 요청한다.
    // 부모 오프라인(flush 도달 불가)이면 PUT은 409 dirty_room으로 막히고,
    // 복구 뒤에는 부모 편집 + 첨부 변경이 둘 다 디스크에 생존한다.
    testInfo.setTimeout(420000)
    const FIX3 = 'e2e/collab/fixtures/collab-3slides.pptx'
    const rel = uniqueRel('uparent', 0)
    const abs = absForRel(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.copyFileSync(FIX3, abs)
    const parentPath = rel.replace(/^repos\//, '')
    const fname = rel.split('/').pop()!
    // INSERT는 HTTP solo 경로로 한다 (/edit 탭에는 Edit 버튼이 없다).
    const fileBytes = fs.readFileSync(path.resolve(FIX, 'embed-docx.xlsx'))
    const fd = new FormData()
    fd.append('path', parentPath)
    fd.append('file', new Blob([new Uint8Array(fileBytes)], { type: 'application/octet-stream' }), 'embed-docx.xlsx')
    fd.append('slide', '2')
    const ins = await fetch(`${backendBase()}/api/collab/embed`, { method: 'POST', body: fd }).then((r) =>
      r.json(),
    ) as { ok?: boolean; embeddings?: string[] }
    expect(ins.ok).toBe(true)
    const part = (ins.embeddings ?? [])[0]!
    expect(part).toMatch(/embeddings\//)
    const got = await fetch(
      `${backendBase()}/api/collab/embed?${new URLSearchParams({ path: parentPath, part }).toString()}`,
    ).then((r) => r.json()) as { ok?: boolean; data?: string }
    expect(got.ok).toBe(true)
    const partHash = createHash('sha256').update(Buffer.from(got.data!, 'base64')).digest('hex')
    const ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctxA, ADA)
    const pageA = await ctxA.newPage()
    await gotoApp(pageA)
    const origin = new URL(pageA.url()).origin
    const enc = (s: string): string => s.split('/').map((x) => encodeURIComponent(x)).join('/')
    // 첨부 탭은 별도 컨텍스트(온라인 유지) — 부모만 오프라인으로 떨어뜨린다.
    const ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctxB, ADA)
    try {
      await openEditor(pageA, parentPath)
      await gotoSlide(pageA, 2)
      const attach = await ctxB.newPage()
      await attach.goto(`${origin}/edit/${enc(parentPath)}/-/${enc(part)}?partHash=${partHash}&e2e=1&collabDebug=1`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      })
      await attach.getByTestId('edit-page').waitFor({ timeout: 30000 })
      await attach.locator('xlsx-editor [part~=formula-bar] textarea').first().waitFor({ timeout: 60000 })
      // 첨부 편집 (저장 안 함).
      await setCellByFormulaBar(attach, 'A1', 'uparent-attach-1')
      // 부모 오프라인: 자동 저장도 막히고 서버 flush도 도달하지 않는다 (첨부 탭은 온라인).
      // (방 30초 sweep 전에 복구해야 재입장이 병합된다 — sweep 뒤 재입장은 디스크 기준이라 범위 밖.)
      await ctxA.setOffline(true)
      const shapes = new ShapeLocator(pageA)
      await editShapeText(pageA, shapes, 'Body 2', 'uparent-mark')
      // 첨부 저장 시도 → 409 dirty_room (조용한 덮어쓰기 금지).
      // flush 도달 불가(half-open이면 8초 타임아웃, 정리됐으면 즉시)라 결과는 항상 409다.
      await attach.getByTestId('attach-save').click({ timeout: 20000 })
      await expect(attach.locator('[data-sonner-toast]').filter({ hasText: '부모 파일' })).toHaveCount(1, {
        timeout: 30000,
      })
      // 디스크는 그대로다 (부모 편집도 첨부 변경도 아직 없음).
      expect(await partContains(abs, part, 'uparent-attach-1')).toBe(false)
      expect((await readDeck(abs)).textOf('Body 2') ?? '').not.toContain('uparent-mark')
      // 부모 복구 → 재입장 뒤 첨부 저장이 flush로 부모를 저장시킨다 (자동 저장에 기대지 않는다).
      await ctxA.setOffline(false)
      // 부모가 방에 다시 들어오고 owner가 선출될 때까지 대기한다.
      await expect
        .poll(async () => roomsForFile(fname).then((r) => r.length), { timeout: 60000, intervals: [1000] })
        .toBe(1)
      await attach.waitForTimeout(3000)
      // 첨부 다시 저장 → 성공하고 둘 다 생존한다.
      await attach.getByTestId('attach-save').click({ timeout: 20000 })
      await expect(attach.locator('[data-sonner-toast]').filter({ hasText: '저장했습니다' })).toHaveCount(1, {
        timeout: 60000,
      })
      await expect
        .poll(() => Promise.resolve(partContains(abs, part, 'uparent-attach-1')), { timeout: 60000, intervals: [1000] })
        .toBe(true)
      expect((await readDeck(abs)).textOf('Body 2') ?? '').toContain('uparent-mark')
    } finally {
      await ctxA.close().catch(() => {})
      await ctxB.close().catch(() => {})
    }
  })

  test('U-parent-autosave: 온라인 부모 편집 + 첨부 저장 — 강제 flush로 둘 다 생존', async ({ browser }, testInfo) => {
    // D64 U-parent-autosave: PUT이 부모 owner에게 flush를 강제하므로
    // 디바운스 운과 무관하게 부모 편집 + 첨부 변경이 둘 다 디스크에 생존한다.
    testInfo.setTimeout(420000)
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c54upauto', ['embed-pdf.xlsx'])
    const hostAbs = path.join(workspaceDir(), 'repos', 'c54upauto', 'embed-pdf.xlsx')
    try {
      await openViaWorkspace(page, 'embed-pdf.xlsx', 'c54upauto', '.xlsxengine-host')
      const editor = await attachViaAddInTab(page, path.resolve(FIX, 'embed-docx.xlsx'))
      await expect(editor.getByTestId('ole-icon')).toHaveCount(2, { timeout: 60000 })
      const icon = editor.locator('[data-testid="ole-icon"][title*="embed-docx.xlsx"]')
      await icon.waitFor({ timeout: 30000 })
      const [attach] = await Promise.all([
        editor.waitForEvent('popup', { timeout: 15000 }),
        icon.dblclick({ timeout: 15000 }),
      ])
      await attach.waitForLoadState('domcontentloaded', { timeout: 30000 })
      await attach.locator('xlsx-editor [part~=formula-bar] textarea').first().waitFor({ timeout: 60000 })
      // 첨부 먼저 편집 (저장 안 함), 부모 편집 직후 바로 저장 → 디바운스(2.5s)보다 PUT이 빠르다.
      await setCellByFormulaBar(attach, 'A1', 'uparent-auto-attach')
      await setCellByFormulaBar(editor, 'A1', 'uparent-auto-mark')
      const part = partPathOf(attach.url())
      await attach.getByTestId('attach-save').click({ timeout: 20000 })
      await expect(attach.locator('[data-sonner-toast]').filter({ hasText: '저장했습니다' })).toHaveCount(1, {
        timeout: 60000,
      })
      await expect
        .poll(() => Promise.resolve(partContains(hostAbs, part, 'uparent-auto-attach')), {
          timeout: 60000,
          intervals: [1000],
        })
        .toBe(true)
      await expect
        .poll(() => Promise.resolve(xlsxContains(hostAbs, 'uparent-auto-mark')), { timeout: 60000, intervals: [1000] })
        .toBe(true)
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('U-http: HTTP만으로 잠금→읽기→교체 (방 없음)', async ({ }, testInfo) => {
    // D64 U-http: 방이 없는 파일은 solo 경로로 HTTP만으로 교체된다 (회귀 잠금).
    testInfo.setTimeout(120000)
    await mkRepo('c54http', ['embed-pdf.xlsx'])
    const parentPath = 'c54http/embed-pdf.xlsx'
    const hostAbs = path.join(workspaceDir(), 'repos', parentPath)
    const fileBytes = fs.readFileSync(path.resolve(FIX, 'embed-docx.xlsx'))
    // INSERT (solo, 방 없음).
    const fd = new FormData()
    fd.append('path', parentPath)
    fd.append('file', new Blob([new Uint8Array(fileBytes)], { type: 'application/octet-stream' }), 'embed-docx.xlsx')
    fd.append('sheet', '0')
    const ins = await fetch(`${backendBase()}/api/collab/embed`, { method: 'POST', body: fd }).then((r) =>
      r.json(),
    ) as { ok?: boolean; embeddings?: string[] }
    expect(ins.ok).toBe(true)
    const part = (ins.embeddings ?? [])[0]
    expect(part).toMatch(/embeddings\//)
    // GET → 잠금 → 변조 → PUT.
    const got = await fetch(
      `${backendBase()}/api/collab/embed?${new URLSearchParams({ path: parentPath, part: part! }).toString()}`,
    ).then((r) => r.json()) as { ok?: boolean; data?: string; hash?: string }
    expect(got.ok).toBe(true)
    const partBytes = Buffer.from(got.data!, 'base64')
    const token = `t-http-${Date.now().toString(36)}`
    const lock = await fetch(`${backendBase()}/api/collab/embed/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: parentPath, part, name: 'http-probe', token }),
    }).then((r) => r.json()) as { ok?: boolean; lockId?: string }
    expect(lock.ok).toBe(true)
    try {
      const mod = await tamperPartXlsx(partBytes, 'uhttp-mark')
      const partHash = createHash('sha256').update(partBytes).digest('hex')
      const fd2 = new FormData()
      fd2.append('file', new Blob([new Uint8Array(mod)], { type: 'application/octet-stream' }), 'embed-docx.xlsx')
      fd2.append('baseHash', got.hash!)
      fd2.append('partHash', partHash)
      fd2.append('lockId', lock.lockId!)
      const put = await fetch(
        `${backendBase()}/api/collab/embed?${new URLSearchParams({ path: parentPath, part: part! }).toString()}`,
        { method: 'PUT', body: fd2 },
      ).then((r) => r.json()) as { ok?: boolean; newHash?: string }
      expect(put.ok).toBe(true)
      expect(await partContains(hostAbs, part!, 'uhttp-mark')).toBe(true)
      // 방이 생기지 않았다 (solo 경로).
      expect(await roomsForFile('embed-pdf.xlsx').then((r) => r.filter((p) => JSON.stringify(p).includes('c54http')))).toEqual([])
    } finally {
      await fetch(`${backendBase()}/api/collab/embed/lock`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: parentPath, part, lockId: lock.lockId!, token }),
      }).catch(() => {})
    }
  })

  test('R-follow: 새 탭에서 이름 클릭 → 우리 팝오버 → Follow, lib people UI 0개', async ({ browser }, testInfo) => {
    // C5-4c A2: 따라가기는 우리 팝오버(C3, paused:true)가 전담. lib people UI·자동 따라가기 금지.
    testInfo.setTimeout(420000)
    const rel = uniqueRel('rfollow', 0)
    const abs = absForRel(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.copyFileSync('e2e/collab/fixtures/collab-3slides.pptx', abs)
    const fname = rel.split('/').pop()!
    const ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctxA, ADA)
    const ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctxB, GRACE)
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    await gotoApp(pageA)
    await gotoApp(pageB)
    try {
      await openEditor(pageA, rel.replace(/^repos\//, ''))
      await openEditor(pageB, rel.replace(/^repos\//, ''))
      await gotoSlide(pageA, 2)
      await gotoSlide(pageB, 2)
      await expect(peer(pageB, 'u-ada')).toBeVisible({ timeout: 30000 })
      // lib people UI가 꺼져 있어야 한다 (follow-mode-bar는 CSS로 숨김 — C5-4c A2).
      // display:none이라 DOM에는 남으므로 hidden으로 단언한다.
      await expect(pageB.getByTestId('follow-mode-bar')).toBeHidden({ timeout: 15000 })
      await expect(pageB.getByTestId('user-avatar-bar')).toHaveCount(0)
      // 우리 팝오버로 Follow.
      await pageB.getByTestId('collab-avatars').click({ timeout: 10000 })
      await pageB.getByTestId('collab-presence-row').filter({ hasText: 'Ada' }).getByTestId('collab-follow').click({ timeout: 10000 })
      await pageB.keyboard.press('Escape')
      await gotoSlide(pageA, 3)
      await expect(peer(pageB, 'u-ada')).toHaveAttribute('data-slide', '3', { timeout: 15000 })
      // B가 직접 움직이면 풀린다.
      await pageB.mouse.click(400, 300)
      await pageB.getByTestId('collab-avatars').click({ timeout: 10000 })
      const followBtn = pageB.getByTestId('collab-presence-row').filter({ hasText: 'Ada' }).getByTestId('collab-follow')
      await expect(followBtn).toHaveAttribute('aria-pressed', 'false', { timeout: 5000 })
      await pageB.keyboard.press('Escape')
      const navBefore = await pageB.evaluate(() => (window as unknown as { __c3FollowNav?: number }).__c3FollowNav ?? 0)
      await gotoSlide(pageA, 1)
      await expect(peer(pageB, 'u-ada')).toHaveAttribute('data-slide', '1', { timeout: 15000 })
      const navAfter = await pageB.evaluate(() => (window as unknown as { __c3FollowNav?: number }).__c3FollowNav ?? 0)
      expect(navAfter).toBe(navBefore)
    } finally {
      await ctxA.close().catch(() => {})
      await ctxB.close().catch(() => {})
    }
  })

  test('U-deeplink: /edit/<부모>/-/<파트> 직접 열기', async ({ browser }, testInfo) => {
    // D64 U-deeplink: 딥링크로 첨부 편집기가 바로 열린다 (회귀 잠금).
    testInfo.setTimeout(180000)
    await mkRepo('c54deep', ['embed-pdf.xlsx'])
    const parentPath = 'c54deep/embed-pdf.xlsx'
    const fileBytes = fs.readFileSync(path.resolve(FIX, 'embed-docx.xlsx'))
    const fd = new FormData()
    fd.append('path', parentPath)
    fd.append('file', new Blob([new Uint8Array(fileBytes)], { type: 'application/octet-stream' }), 'embed-docx.xlsx')
    fd.append('sheet', '0')
    const ins = await fetch(`${backendBase()}/api/collab/embed`, { method: 'POST', body: fd }).then((r) =>
      r.json(),
    ) as { ok?: boolean; embeddings?: string[] }
    expect(ins.ok).toBe(true)
    const part = (ins.embeddings ?? [])[0]!
    const got = await fetch(
      `${backendBase()}/api/collab/embed?${new URLSearchParams({ path: parentPath, part }).toString()}`,
    ).then((r) => r.json()) as { ok?: boolean; data?: string }
    expect(got.ok).toBe(true)
    const partHash = createHash('sha256').update(Buffer.from(got.data!, 'base64')).digest('hex')
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    try {
      const origin = new URL(page.url()).origin
      const enc = (s: string): string => s.split('/').map((x) => encodeURIComponent(x)).join('/')
      const deep = `${origin}/edit/${enc(parentPath)}/-/${enc(part)}?partHash=${partHash}&e2e=1&collabDebug=1`
      await page.goto(deep, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.getByTestId('edit-page').waitFor({ timeout: 30000 })
      await page.locator('xlsx-editor [part~=formula-bar] textarea').first().waitFor({ timeout: 60000 })
      await expect(page.getByTestId('attach-title')).toContainText('embed-docx.xlsx')
      // 해시가 맞으면 경고 없이 열린다.
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: '첨부가 바뀌었습니다' })).toHaveCount(0, {
        timeout: 10000,
      })
      // 저장까지 된다 (잠금+PUT 경로).
      await page.getByTestId('attach-save').click({ timeout: 20000 })
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: '저장했습니다' })).toHaveCount(1, {
        timeout: 60000,
      })
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('R-attach: 새 탭에서 형식 3종 모두 문서 첨부 삽입이 동작한다', async ({ browser }, testInfo) => {
    // C5-4c A3: /edit 탭의 "첨부" 탭 → "문서 첨부" → 파일 선택 → 디스크 embeddings +1.
    testInfo.setTimeout(420000)
    const cases = [
      { slug: 'rattach', ext: '.pptx', copy: 'e2e/collab/fixtures/collab-3slides.pptx', sel: '[data-testid="pptx-viewer-root"]' },
      { slug: 'rattachx', ext: '.xlsx', copy: `${FIX}/embed-pdf.xlsx`, sel: 'xlsx-editor' },
      { slug: 'rattachd', ext: '.docx', copy: `${FIX}/embed-docx.docx`, sel: '.docxengine-host' },
    ] as Array<{ slug: string; ext: string; copy: string; sel: string }>
    for (const c of cases) {
      const rel = uniqueRelWithExt(c.slug, 0, c.ext)
      const abs = absForRel(rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.copyFileSync(c.copy, abs)
      const before = await embeddingsCount('collab-e2e', rel.split('/').pop()!)
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
      await seedUser(ctx, ADA)
      const page = await ctx.newPage()
      await gotoApp(page)
      try {
        await openEditor(page, rel.replace(/^repos\//, ''))
        await page.locator(c.sel).first().waitFor({ timeout: 60000 })
        const tab = page.getByRole('tab', { name: '첨부', exact: true }).first()
        await expect(tab, `${c.slug}: attach tab`).toBeVisible({ timeout: 30000 })
        await tab.click({ timeout: 15000 })
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 15000 }),
          page.getByText('문서 첨부', { exact: true }).first().click({ timeout: 15000 }),
        ])
        await chooser.setFiles(path.resolve(FIX, 'embed-docx.xlsx'))
        const fname = rel.split('/').pop()!
        await expect
          .poll(() => embeddingsCount('collab-e2e', fname), { timeout: 60000, intervals: [1000] })
          .toBe(before + 1)
      } finally {
        await ctx.close().catch(() => {})
      }
    }
  })

  test('R-ribbon: 새 탭 홈 리본이 예전 전체화면 수치와 같다 (PPT·XLSX·DOCX)', async ({ browser }, testInfo) => {
    // C5-4c A1: 0절 예전 수치(1400x900 기준) — 탭행 35px/폰트 16px, PPT 버튼대 92px,
    // xlsx 리본 141px, docx 리본 145px, 에디터 루트 x=8/w=1384 (p-2 구조).
    testInfo.setTimeout(420000)
    const within = (v: number, want: number, tol = 2): boolean => Math.abs(v - want) <= tol
    const cases = [
      { slug: 'rribbon-pptx', src: 'e2e/collab/fixtures/collab-3slides.pptx', ext: '.pptx', wsPath: '', rootSel: '[data-testid="pptx-viewer-root"]' },
      { slug: 'rribbon-xlsx', src: `${FIX}/embed-pdf.xlsx`, ext: '.xlsx', wsPath: '', rootSel: 'xlsx-editor' },
      { slug: 'rribbon-docx', src: `${FIX}/embed-docx.docx`, ext: '.docx', wsPath: '', rootSel: '.docxengine-host' },
    ] as Array<{ slug: string; src: string; ext: string; wsPath: string; rootSel: string }>
    for (const c of cases) {
      // R-ribbon은 편집하지 않으므로 파일명을 고정한다 (타이틀바 텍스트 안정화).
      const rel = `repos/collab-e2e/${c.slug}${c.ext}`
      const abs = absForRel(rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.copyFileSync(c.src, abs)
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
      await seedUser(ctx, ADA)
      const page = await ctx.newPage()
      await gotoApp(page)
      try {
        await openEditor(page, rel.replace(/^repos\//, ''))
        // lib 리본이 마운트될 때까지 대기 (뷰어 루트보다 늦을 수 있다).
        if (c.ext === '.pptx') {
          await page.getByRole('tab', { name: 'Home' }).first().waitFor({ timeout: 60000 })
        } else if (c.ext === '.xlsx') {
          await page.locator('xlsx-editor [part~=formula-bar] textarea').first().waitFor({ timeout: 60000 })
          await page.getByRole('tab', { name: 'Home' }).first().waitFor({ timeout: 60000 })
        } else {
          await page.locator('.docxengine-host button').first().waitFor({ timeout: 60000 })
          await page.getByRole('tab', { name: 'Home' }).first().waitFor({ timeout: 60000 })
        }
        const boxes = await page
          .evaluate(() => {
            // lib 리본(xlsx/docx)은 shadow DOM 안에 있다 — 뚫고 수집한다.
            const allEls = (root: ParentNode, out: Element[] = []): Element[] => {
              for (const el of [...root.querySelectorAll('*')]) {
                out.push(el)
                const sr = (el as HTMLElement).shadowRoot
                if (sr) allEls(sr, out)
              }
              return out
            }
            const els = allEls(document)
            const textOf = (e: Element): string => (e.textContent ?? '').slice(0, 60)
            // 탭행: light-DOM의 File 탭리스트를 우선 (pptx 본행 16px). 없으면 shadow까지 탐색.
            const lightTls = [...document.querySelectorAll('[role="tablist"]')]
            const tlLight = lightTls.find((t) => /File/.test(t.textContent ?? '')) ?? null
            const tabs = els.filter((e) => e.getAttribute?.('role') === 'tab')
            const tl = tlLight ?? tabs.find((t) => /File/.test(textOf(t))) ?? null
            // 리본 컨테이너: 상단 300px 안에서 가장 넓고 80~250px 높이인 요소 (xlsx 141 / docx 145).
            // 클래스 무관 휴리스틱을 우선 적용한다 (lib 구조 변경에 둔감).
            let rib: Element | null = null
            {
              let best = 0
              for (const e of els) {
                const b = e.getBoundingClientRect()
                if (b.width > 1000 && b.y < 300 && b.height >= 80 && b.height <= 250 && b.width > best) {
                  best = b.width
                  rib = e
                }
              }
              // 폴백: Home 탭 조상 중 버튼대를 포함한 첫 컨테이너.
              if (!rib) {
                const home = tabs.find((t) => /Home/.test(textOf(t))) as HTMLElement | null
                let el = home?.parentElement ?? null
                for (let i = 0; i < 8 && el; i++) {
                  const b = el.getBoundingClientRect()
                  if (b.width > 1000 && b.y < 300 && b.height >= 80 && b.height <= 250) {
                    rib = el as Element
                    break
                  }
                  el = el.parentElement
                }
              }
            }
            const r = tl?.getBoundingClientRect() ?? rib?.getBoundingClientRect() ?? null
            const b = rib?.getBoundingClientRect() ?? null
            // 버튼대: 리본 컨테이너 자식 중 가장 큰 행 (probe-px 검증 방식).
            let strip: { y: number; h: number } | null = null
            {
              // light-DOM 탭행이면 부모 자식으로 버튼대를 잰다 (pptx 검증 방식).
              const tlel = tl as HTMLElement | null
              const par = tlel?.parentElement ?? null
              if (par && tlel === tlLight) {
                let best = 0
                for (const s of [...par.children]) {
                  if (s === tlel) continue
                  const sb = s.getBoundingClientRect()
                  if (sb.height > best) {
                    best = sb.height
                    strip = { y: Math.round(sb.y), h: Math.round(sb.height) }
                  }
                }
                if (best < 40) strip = null
              } else {
              const tlel = tl as HTMLElement | null
              const getCls = (e: Element | null): string => {
                try {
                  return String((e as HTMLElement)?.className?.baseVal ?? (e as HTMLElement)?.className ?? '')
                } catch {
                  return ''
                }
              }
              // shadow 경계를 넘어 closest가 안 통하므로 수동으로 오른다.
              let ribHost: HTMLElement | null = null
              if (tlel) {
                let el: HTMLElement | null = tlel
                for (let i = 0; i < 6 && el && !ribHost; i++) {
                  if (/ribbon/i.test(getCls(el))) ribHost = el
                  el = el.parentElement
                }
                if (!ribHost) ribHost = tlel.parentElement
              }
              if (ribHost) {
                let best = 0
                for (const s of [...ribHost.children]) {
                  if (s === tl) continue
                  const sb = s.getBoundingClientRect()
                  if (sb.height > best) {
                    best = sb.height
                    strip = { y: Math.round(sb.y), h: Math.round(sb.height) }
                  }
                }
                if (best < 40) strip = null
              }
            }
            }
            return {
              tab: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
              tabFont: tl ? getComputedStyle(tl).fontSize : null,
              ribbon: b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null,
              strip,
            }
          })
          .catch(() => null) as {
          tab: { x: number; y: number; w: number; h: number } | null
          tabFont: string | null
          ribbon: { x: number; y: number; w: number; h: number } | null
          strip: { y: number; h: number } | null
        } | null
        expect(boxes, `${c.slug}: ribbon boxes`).not.toBeNull()
        // 탭행: 예전 35px/16px. xlsx/docx는 shadow 탭 행이 섞이므로 25~45px인 것만 단언.
        if (boxes!.tab && (c.ext === '.pptx' || (boxes!.tab.h >= 25 && boxes!.tab.h <= 45))) {
          expect(within(boxes!.tab.h, 35), `${c.slug}: tab h=${boxes!.tab.h}`).toBe(true)
          expect(boxes!.tabFont, `${c.slug}: tab font`).toBe('16px')
        }
        if (c.ext === '.pptx') {
          // 버튼대 92px (예전 strip y=111 h=92).
          expect(boxes!.strip, `${c.slug}: strip`).not.toBeNull()
          expect(within(boxes!.strip!.h, 92), `${c.slug}: strip h=${boxes!.strip!.h}`).toBe(true)
        } else {
          // xlsx 141px / docx 145px 리본 컨테이너.
          expect(boxes!.ribbon, `${c.slug}: ribbon`).not.toBeNull()
          const want = c.ext === '.xlsx' ? 141 : 145
          expect(within(boxes!.ribbon!.h, want), `${c.slug}: ribbon h=${boxes!.ribbon!.h}`).toBe(true)
        }
        // 에디터 루트: 예전 p-2 구조 (x=8, w=1384).
        const root = await page.locator(c.rootSel).first().boundingBox()
        expect(root, `${c.slug}: root`).not.toBeNull()
        expect(within(root!.x, 8), `${c.slug}: root x=${root!.x}`).toBe(true)
        expect(within(root!.width, 1384), `${c.slug}: root w=${root!.width}`).toBe(true)
        // 리본 영역 스크린샷 잠금 (탭행+버튼대만: 타이틀바 검색창 변동 제외).
        // 폰트 로딩 뒤에 찍는다 (fallback/웹폰트 혼용 렌더 방지).
        await page.evaluate(() => document.fonts.ready.then(() => true)).catch(() => false)
        await page.waitForTimeout(1500)
        await expect(page).toHaveScreenshot(`r-ribbon-${c.slug}.png`, {
          timeout: 30000,
          clip: { x: 0, y: 64, width: 1400, height: 196 },
          animations: 'disabled',
          caret: 'hide',
          maxDiffPixels: 100,
        })
      } finally {
        await ctx.close().catch(() => {})
      }
    }
  })

  test('U-flush-race: 진행 중인 저장이 있어도 103 직전 글자가 디스크에 남는다', async ({ browser }, testInfo) => {
    // C5-4c B1: 진행 중인 저장의 완료를 flush 응답으로 쓰면 낡은 바이트를 확정한다.
    // 같은 requestId의 done만 응답으로 쓴다.
    testInfo.setTimeout(420000)
    const rel = uniqueRel('uflushrace', 0)
    const abs = absForRel(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.copyFileSync('e2e/collab/fixtures/collab-3slides.pptx', abs)
    const parentPath = rel.replace(/^repos\//, '')
    const fileBytes = fs.readFileSync(path.resolve(FIX, 'embed-docx.xlsx'))
    const fd = new FormData()
    fd.append('path', parentPath)
    fd.append('file', new Blob([new Uint8Array(fileBytes)], { type: 'application/octet-stream' }), 'embed-docx.xlsx')
    fd.append('slide', '2')
    const ins = await fetch(`${backendBase()}/api/collab/embed`, { method: 'POST', body: fd }).then((r) =>
      r.json(),
    ) as { ok?: boolean; embeddings?: string[] }
    expect(ins.ok).toBe(true)
    const part = (ins.embeddings ?? [])[0]!
    const got = await fetch(
      `${backendBase()}/api/collab/embed?${new URLSearchParams({ path: parentPath, part }).toString()}`,
    ).then((r) => r.json()) as { ok?: boolean; data?: string }
    expect(got.ok).toBe(true)
    const partHash = createHash('sha256').update(Buffer.from(got.data!, 'base64')).digest('hex')
    const ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctxA, ADA)
    const ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctxB, ADA)
    const pageA = await ctxA.newPage()
    await gotoApp(pageA)
    try {
      await openEditor(pageA, parentPath)
      await gotoSlide(pageA, 2)
      const attach = await ctxB.newPage()
      const origin = new URL(pageA.url()).origin
      const enc = (s: string): string => s.split('/').map((x) => encodeURIComponent(x)).join('/')
      await attach.goto(`${origin}/edit/${enc(parentPath)}/-/${enc(part)}?partHash=${partHash}&e2e=1&collabDebug=1`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      })
      await attach.getByTestId('edit-page').waitFor({ timeout: 30000 })
      await attach.locator('xlsx-editor [part~=formula-bar] textarea').first().waitFor({ timeout: 60000 })
      await setCellByFormulaBar(attach, 'A1', 'uflushrace-attach')
      // 부모 글 입력 + 수동 저장 (진행 중 저장을 만든다).
      const shapes = new ShapeLocator(pageA)
      await editShapeText(pageA, shapes, 'Body 2', 'uflushrace-mark')
      await pageA.route('**/api/collab/save', async (route) => {
        await new Promise((r) => setTimeout(r, 3000))
        await route.continue().catch(() => {})
      })
      await pageA.getByRole('button', { name: 'Save', exact: true }).first().click({ timeout: 20000 })
      // 저장 진행 중에 첨부 저장 (103이 in-flight 저장을 본다).
      await pageA.waitForTimeout(800)
      await attach.getByTestId('attach-save').click({ timeout: 20000 })
      // 성공하고 둘 다 디스크에 남는다.
      await expect(attach.locator('[data-sonner-toast]').filter({ hasText: '저장했습니다' })).toHaveCount(1, {
        timeout: 60000,
      })
      await expect
        .poll(() => Promise.resolve(partContains(abs, part, 'uflushrace-attach')), { timeout: 60000, intervals: [1000] })
        .toBe(true)
      await waitForDisk(abs, (d) => (d.textOf('Body 2') ?? '').includes('uflushrace-mark'), 60000)
      expect((await readDeck(abs)).textOf('Body 2') ?? '').toContain('uflushrace-mark')
    } finally {
      await ctxA.close().catch(() => {})
      await ctxB.close().catch(() => {})
    }
  })

  test('U-flush-clean: 손대지 않은 부모 탭이면 첨부 저장이 바로 200이다', async ({ browser }, testInfo) => {
    // C5-4c B2: 미저장 변경이 없으면 저장 없이 즉시 ok. 8초 타임을 타면 안 된다.
    // RED(수정 전): 부모가 항상 강제 저장하므로 /save 가 나간다.
    testInfo.setTimeout(420000)
    const rel = uniqueRel('uflushclean', 0)
    const abs = absForRel(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.copyFileSync('e2e/collab/fixtures/collab-3slides.pptx', abs)
    const parentPath = rel.replace(/^repos\//, '')
    const fileBytes = fs.readFileSync(path.resolve(FIX, 'embed-docx.xlsx'))
    const fd = new FormData()
    fd.append('path', parentPath)
    fd.append('file', new Blob([new Uint8Array(fileBytes)], { type: 'application/octet-stream' }), 'embed-docx.xlsx')
    fd.append('slide', '2')
    const ins = await fetch(`${backendBase()}/api/collab/embed`, { method: 'POST', body: fd }).then((r) =>
      r.json(),
    ) as { ok?: boolean; embeddings?: string[] }
    expect(ins.ok).toBe(true)
    const part = (ins.embeddings ?? [])[0]!
    const got = await fetch(
      `${backendBase()}/api/collab/embed?${new URLSearchParams({ path: parentPath, part }).toString()}`,
    ).then((r) => r.json()) as { ok?: boolean; data?: string }
    expect(got.ok).toBe(true)
    const partHash = createHash('sha256').update(Buffer.from(got.data!, 'base64')).digest('hex')
    const ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctxA, ADA)
    const ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctxB, ADA)
    const pageA = await ctxA.newPage()
    await gotoApp(pageA)
    const parentSaveTimes: number[] = []
    try {
      await openEditor(pageA, parentPath)
      await gotoSlide(pageA, 2)
      await pageA.route('**/api/collab/save', async (route) => {
        parentSaveTimes.push(Date.now())
        await route.continue()
      })
      // 부모가 열기 직후의 수렴 저장을 다 끝낼 때까지 대기 (flush와 무관한 배경 저장).
      // 수렴 전에 첨부탭을 열면 baseHash가 stale이 되어 PUT이 409가 난다.
      // 수렴하지 않으면 flush가 유발한 저장인지 구분할 수 없다.
      await expect
        .poll(
          async () => {
            const n = parentSaveTimes.length
            await pageA.waitForTimeout(4000)
            return parentSaveTimes.length === n
          },
          { timeout: 90000, intervals: [1000] },
        )
        .toBe(true)
      const attach = await ctxB.newPage()
      const origin = new URL(pageA.url()).origin
      const enc = (s: string): string => s.split('/').map((x) => encodeURIComponent(x)).join('/')
      await attach.goto(`${origin}/edit/${enc(parentPath)}/-/${enc(part)}?partHash=${partHash}&e2e=1&collabDebug=1`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      })
      await attach.getByTestId('edit-page').waitFor({ timeout: 30000 })
      await attach.locator('xlsx-editor [part~=formula-bar] textarea').first().waitFor({ timeout: 60000 })
      await setCellByFormulaBar(attach, 'A1', 'uflushclean-attach')
      const t0 = Date.now()
      await attach.getByTestId('attach-save').click({ timeout: 20000 })
      await expect(attach.locator('[data-sonner-toast]').filter({ hasText: '저장했습니다' })).toHaveCount(1, {
        timeout: 15000,
      })
      const elapsed = Date.now() - t0
      const parentSaves = parentSaveTimes.filter((t) => t >= t0)
      console.log(`UFLUSH-CLEAN elapsed=${elapsed}ms savesAfterClick=${parentSaves.length}`)
      expect(parentSaves).toEqual([])
      expect(await partContains(abs, part, 'uflushclean-attach')).toBe(true)
    } finally {
      await ctxA.close().catch(() => {})
      await ctxB.close().catch(() => {})
    }
  })

  test('U-close-save: 정상 종료 뒤 미저장이 있으면 첨부 저장이 409다 (B3 dirty)', async ({ browser }, testInfo) => {
    // C5-4c B3: 편집 conn이 없고 방이 dirty면 PUT은 409 dirty_room (조용한 유실 방지).
    // 복구: 다시 열어 저장하면 첨부 저장이 200이 된다.
    testInfo.setTimeout(420000)
    const rel = uniqueRel('uclosesave', 0)
    const abs = absForRel(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.copyFileSync('e2e/collab/fixtures/collab-3slides.pptx', abs)
    const parentPath = rel.replace(/^repos\//, '')
    const fileBytes = fs.readFileSync(path.resolve(FIX, 'embed-docx.xlsx'))
    const mkPart = async (): Promise<{ part: string; partHash: string }> => {
      const fd = new FormData()
      fd.append('path', parentPath)
      fd.append('file', new Blob([new Uint8Array(fileBytes)], { type: 'application/octet-stream' }), 'embed-docx.xlsx')
      fd.append('slide', '2')
      const ins = (await fetch(`${backendBase()}/api/collab/embed`, { method: 'POST', body: fd }).then((r) =>
        r.json(),
      )) as { ok?: boolean; embeddings?: string[] }
      expect(ins.ok).toBe(true)
      const part = (ins.embeddings ?? [])[0]!
      const got = (await fetch(
        `${backendBase()}/api/collab/embed?${new URLSearchParams({ path: parentPath, part }).toString()}`,
      ).then((r) => r.json())) as { ok?: boolean; data?: string }
      expect(got.ok).toBe(true)
      return { part, partHash: createHash('sha256').update(Buffer.from(got.data!, 'base64')).digest('hex') }
    }
    const { part, partHash } = await mkPart()
    const ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctxA, ADA)
    const ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctxB, ADA)
    try {
      const pageA = await ctxA.newPage()
      await gotoApp(pageA)
      await openEditor(pageA, parentPath)
      await gotoSlide(pageA, 2)
      const appOrigin = new URL(pageA.url()).origin
      // 시딩 윈도우(10초) 이후에 타이핑해야 서버 docDirty가 선다.
      await pageA.waitForTimeout(12000)
      const shapes = new ShapeLocator(pageA)
      await editShapeText(pageA, shapes, 'Body 2', 'uclosesave-mark')
      await pageA.waitForTimeout(2000)
      // 저장 없이 정상 종료 (pagehide → 1000, drop 기록은 지워지지만 dirty는 남는다).
      await pageA.close()
      const attach = await ctxB.newPage()
      const enc = (s: string): string => s.split('/').map((x) => encodeURIComponent(x)).join('/')
      await attach.goto(`${appOrigin}/edit/${enc(parentPath)}/-/${enc(part)}?partHash=${partHash}&e2e=1&collabDebug=1`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      })
      await attach.getByTestId('edit-page').waitFor({ timeout: 30000 })
      await attach.locator('xlsx-editor [part~=formula-bar] textarea').first().waitFor({ timeout: 60000 })
      await setCellByFormulaBar(attach, 'A1', 'uclosesave-attach')
      await attach.getByTestId('attach-save').click({ timeout: 20000 })
      // 409 dirty_room: 성공 토스트 없이 부모 저장 요구 토스트가 뜬다.
      await expect(attach.locator('[data-sonner-toast]').filter({ hasText: '저장했습니다' })).toHaveCount(0, {
        timeout: 20000,
      })
      await expect(
        attach.locator('[data-sonner-toast]').filter({ hasText: '부모 파일' }),
      ).not.toHaveCount(0, { timeout: 20000 })
      // 복구: 부모를 다시 열면 마크가 방에 살아 있고, 저장 후 첨부 저장이 된다.
      const pageA2 = await ctxA.newPage()
      await gotoApp(pageA2)
      await openEditor(pageA2, parentPath)
      await gotoSlide(pageA2, 2)
      await pageA2.getByRole('button', { name: 'Save', exact: true }).first().click({ timeout: 20000 })
      await waitForDisk(abs, (d) => (d.textOf('Body 2') ?? '').includes('uclosesave-mark'), 60000)
      await attach.getByTestId('attach-save').click({ timeout: 20000 })
      await expect(attach.locator('[data-sonner-toast]').filter({ hasText: '저장했습니다' })).toHaveCount(1, {
        timeout: 60000,
      })
      expect(await partContains(abs, part, 'uclosesave-attach')).toBe(true)
    } finally {
      await ctxA.close().catch(() => {})
      await ctxB.close().catch(() => {})
    }
  })

  test('U-offline-long: 30초+ 끊기면 방이 새로 생기고 미저장 배너가 뜬다 (B4)', async ({ browser }, testInfo) => {
    // C5-4c B4: 서버 방이 dispose된 뒤 같은 세션이 resume으로 재접속하면,
    // 로컬 미저장이 있을 때 배너+내 사본 안내가 뜬다.
    // setOffline은 기존 WS를 끊지 않으므로(half-open) 서버의 무수신 정리
    // (120초, sweepDeadConns) + 빈 방 TTL(30초)이 돌 때까지 기다린다.
    testInfo.setTimeout(420000)
    const rel = uniqueRel('uofflinelong', 0)
    const abs = absForRel(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.copyFileSync('e2e/collab/fixtures/collab-3slides.pptx', abs)
    const parentPath = rel.replace(/^repos\//, '')
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    try {
      const page = await ctx.newPage()
      await gotoApp(page)
      await openEditor(page, parentPath)
      await gotoSlide(page, 2)
      // 저장을 막아 미저장을 만든다 (수렴 저장도 차단).
      await page.route('**/api/collab/save', async (route) => {
        await route.abort().catch(() => {})
      })
      const shapes = new ShapeLocator(page)
      await editShapeText(page, shapes, 'Body 2', 'uofflinelong-mark')
      await page.waitForTimeout(2000)
      const fileName = parentPath.split('/').pop()!
      const roomListed = async (): Promise<boolean> => {
        const res = await fetch(`${backendBase()}/api/collab/rooms`).then((r) => r.json())
        const rooms = (res as { rooms?: Array<{ rel?: string }> }).rooms ?? []
        return rooms.some((r) => r.rel === parentPath || r.rel?.endsWith(fileName))
      }
      // 120초 무수신 정리 + 30초 TTL + sweep 여유. 온라인 복귀 때 poke가
      // 재연결하고 방이 없으면 getSession resume → 배너.
      // setOffline은 기존 WS를 끊지 않으므로(half-open) 서버가 무수신을
      // 감지해 drop할 때까지 기다린다 (방이 rooms 목록에서 사라진다).
      await ctx.setOffline(true)
      await expect
        .poll(roomListed, { timeout: 240000, intervals: [5000] })
        .toBe(false)
      // 빈 방 TTL(30초)+sweep(10초) 후 dispose. 그 뒤 온라인 복귀.
      // dispose는 drop 감지 후 TTL+sweep라 최대 40초 — 여유 60초.
      await page.waitForTimeout(60000)
      await ctx.setOffline(false)
      // 재연결 후 resume + 미저장 배너.
      await expect(page.getByText('방이 새로 만들어졌습니다')).toBeVisible({ timeout: 90000 })
      await page.unroute('**/api/collab/save').catch(() => {})
      await page.getByRole('button', { name: 'Save', exact: true }).first().click({ timeout: 30000 })
      await waitForDisk(abs, (d) => (d.textOf('Body 2') ?? '').includes('uofflinelong-mark'), 90000)
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('O-1: owner가 나가면 남은 편집자가 owner가 되고 편집·저장이 된다 (C)', async ({ browser }, testInfo) => {
    // C5-4c C: dropConn/awareness에서 needsElection→reevaluateOwner로 즉시 재선출 (폴링 금지).
    testInfo.setTimeout(420000)
    const rel = uniqueRel('owner1', 0)
    const abs = absForRel(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.copyFileSync('e2e/collab/fixtures/collab-3slides.pptx', abs)
    const parentPath = rel.replace(/^repos\//, '')
    const fileName = parentPath.split('/').pop()!
    const ownerNames = async (): Promise<string[]> => {
      const parts = (await roomsForFile(fileName)) as Array<{ name?: unknown; owner?: unknown }>
      return parts.filter((p) => p.owner === true).map((p) => String(p.name ?? ''))
    }
    const ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctxA, ADA)
    const ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctxB, GRACE)
    try {
      const pageA = await ctxA.newPage()
      await gotoApp(pageA)
      await openEditor(pageA, parentPath)
      await gotoSlide(pageA, 2)
      await expect.poll(ownerNames, { timeout: 60000, intervals: [1000] }).toContain('Ada')
      const pageB = await ctxB.newPage()
      await gotoApp(pageB)
      await openEditor(pageB, parentPath)
      await gotoSlide(pageB, 2)
      // A가 정상 종료하면 B가 owner가 된다.
      await pageA.close()
      await expect.poll(ownerNames, { timeout: 60000, intervals: [1000] }).toContain('Grace')
      expect(await ownerNames()).not.toContain('Ada')
      // B가 편집·저장하면 디스크에 반영된다 (Body 3은 슬라이드 3에 있다).
      await gotoSlide(pageB, 3)
      const shapesB = new ShapeLocator(pageB)
      await editShapeText(pageB, shapesB, 'Body 3', 'owner1-bmark')
      await pageB.getByRole('button', { name: 'Save', exact: true }).first().click({ timeout: 20000 })
      await waitForDisk(abs, (d) => (d.textOf('Body 3') ?? '').includes('owner1-bmark'), 60000)
      // A가 다시 들어오면 방이 동작하고 (owner 1명) A도 편집·저장된다.
      const pageA2 = await ctxA.newPage()
      await gotoApp(pageA2)
      await openEditor(pageA2, parentPath)
      await gotoSlide(pageA2, 2)
      await expect
        .poll(async () => (await ownerNames()).length, { timeout: 60000, intervals: [1000] })
        .toBe(1)
      const shapesA = new ShapeLocator(pageA2)
      await editShapeText(pageA2, shapesA, 'Body 2', 'owner1-amark')
      await pageA2.getByRole('button', { name: 'Save', exact: true }).first().click({ timeout: 20000 })
      await waitForDisk(abs, (d) => (d.textOf('Body 2') ?? '').includes('owner1-amark'), 60000)
    } finally {
      await ctxA.close().catch(() => {})
      await ctxB.close().catch(() => {})
    }
  })
})
