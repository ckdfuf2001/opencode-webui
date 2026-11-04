import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { backendBase, workspaceDir, absForRel, uniqueRel } from './helpers/env'
import { gotoApp, openEditor, openFileSeeded, gotoSlide, editShapeText, ShapeLocator, peer } from './helpers/viewer'
import { waitForDisk } from './helpers/disk'
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
})
