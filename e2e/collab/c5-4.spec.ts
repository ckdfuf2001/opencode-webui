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
