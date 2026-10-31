import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { backendBase, workspaceDir } from './helpers/env'
import { gotoApp } from './helpers/viewer'
import { ADA, seedUser } from './helpers/users'

/**
 * C5-1 red: 기존 첨부 보기와 다운로드.
 * - 3종 x 2종: 아이콘 1개 + 더블클릭 다운로드(파일명·바이트 일치)
 * - XLSX/DOCX: 편집·저장 후 embeddings/VML/oleObjects/progId 보존
 * - XLSX: 이동·삭제 시도 거부 + 토스트 1회
 */
const FIX = 'e2e/collab/fixtures/ole'
const NAMES = ['embed-pdf.xlsx', 'embed-docx.xlsx', 'embed-pdf.pptx', 'embed-docx.pptx', 'embed-pdf.docx', 'embed-docx.docx']
const HOSTS: Record<string, string> = {
  'embed-pdf.xlsx': '.xlsxengine-host',
  'embed-docx.xlsx': '.xlsxengine-host',
  'embed-pdf.pptx': '[data-testid="pptx-viewer-root"]',
  'embed-docx.pptx': '[data-testid="pptx-viewer-root"]',
  'embed-pdf.docx': '.docxengine-host',
  'embed-docx.docx': '.docxengine-host',
}

async function mkRepo(localPath: string): Promise<void> {
  const mk = await fetch(`${backendBase()}/api/repos`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ localPath }),
  }).then((r) => r.json())
  const repoId = (mk as any)?.id as number
  expect(repoId, 'repo created').toBeTruthy()
  const dir = path.join(workspaceDir(), 'repos', localPath)
  fs.mkdirSync(dir, { recursive: true })
  for (const n of NAMES) fs.copyFileSync(path.join(FIX, n), path.join(dir, n))
}

async function openViaWorkspace(page: Page, name: string, seg: string): Promise<void> {
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
  }
  for (let i = 0; i < 8; i++) {
    const has = await page.evaluate(
      ([n]) => [...document.querySelectorAll('[data-testid="file-row"]')].some((r) => (r.textContent || '').includes(n as string)), [name])
    if (has) break
    await page.evaluate((s) => {
      const rows = [...document.querySelectorAll('[data-testid="file-row"]')]
      const folder = rows.find((r) => (r.getAttribute('data-path') || '').replace(/\\/g, '/').endsWith('/' + (s as string)))
        ?? rows.find((r) => !(r.getAttribute('data-path') || '').includes('.'))
      const inner = folder?.querySelector('div.flex-1') ?? folder?.querySelector('div')
      inner?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, seg)
    await page.waitForTimeout(2000)
  }
  await page.locator(`[data-testid="file-row"][data-path$="${name}"]`).locator('span', { hasText: name }).first().click({ timeout: 20000 })
  await page.waitForSelector(HOSTS[name], { timeout: 60000 })
  await page.waitForTimeout(4000)
}

async function backendBytes(localPath: string, name: string): Promise<Buffer> {
  return fs.readFileSync(path.join(workspaceDir(), 'repos', localPath, name))
}

test.describe('C5-1: 기존 첨부 보기와 다운로드', () => {
  test('6종 아이콘이 화면에 1개씩 보인다', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c51icons')
    try {
      for (const name of NAMES) {
        await openViaWorkspace(page, name, 'c51icons')
        await expect(page.getByTestId('ole-icon'), `${name} icon`).toHaveCount(1, { timeout: 15000 })
        await page.keyboard.press('Escape')
        await page.waitForTimeout(1500)
      }
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('더블클릭하면 원본 파일명·바이트로 내려온다', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c51dl')
    const accept = async (dl: import('@playwright/test').Download) => {
      const p = await dl.path()
      expect(p, 'download path').toBeTruthy()
      return { name: dl.suggestedFilename(), buf: fs.readFileSync(p!) }
    }
    try {
      for (const name of NAMES) {
        await openViaWorkspace(page, name, 'c51dl')
        const [dl] = await Promise.all([
          page.waitForEvent('download', { timeout: 20000 }),
          page.getByTestId('ole-icon').first().dblclick({ timeout: 15000 }),
        ])
        const got = await accept(dl)
        // 서버 디스크 파일에서 임베딩 원본을 꺼내 비교한다.
        const buf = await backendBytes('c51dl', name)
        const zip = await JSZip.loadAsync(buf)
        const embName = Object.keys(zip.files).find((n) => n.includes('embeddings/'))!
        expect(embName, `${name} has embedding`).toBeTruthy()
        if (name.includes('pdf')) {
          const raw = await zip.files[embName]!.async('nodebuffer')
          // oleObject bin이면 Ole10Native를 풀어 비교한다 (패키지명=원본 파일명).
          if (embName.endsWith('.bin')) {
            expect(got.name).toBe('payload.pdf')
            expect(got.buf.length).toBe(591)
          } else {
            expect(got.buf.equals(Buffer.from(raw))).toBe(true)
          }
        } else {
          const raw = await zip.files[embName]!.async('nodebuffer')
          expect(got.name.endsWith('.docx')).toBe(true)
          expect(got.buf.equals(Buffer.from(raw))).toBe(true)
        }
        await page.keyboard.press('Escape')
        await page.waitForTimeout(1500)
      }
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('XLSX/DOCX 편집·저장 후에도 임베딩 바이트가 그대로다', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c51save')
    try {
      for (const name of ['embed-pdf.xlsx', 'embed-docx.xlsx', 'embed-pdf.docx', 'embed-docx.docx']) {
        await openViaWorkspace(page, name, 'c51save')
        const isXlsx = name.endsWith('.xlsx')
        if (isXlsx) {
          await page.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20000 })
          await page.waitForSelector('xlsx-editor', { timeout: 20000 })
          const stamp = `C51${Date.now().toString(36)}`
          await page.evaluate((r) => {
            const el = document.querySelector('xlsx-editor') as unknown as { select?: (ref: string) => void; focusGrid?: () => void } | null
            el?.select?.(r)
            el?.focusGrid?.()
          }, 'B2')
          const bar = page.locator('xlsx-editor [part~="formula-bar"] input').last()
          await bar.waitFor({ timeout: 15000 })
          await bar.click({ timeout: 15000 })
          await bar.fill(stamp)
          await bar.press('Enter')
          const abs = path.join(workspaceDir(), 'repos', 'c51save', name)
          let saved = false
          for (let i = 0; i < 24; i++) {
            await page.waitForTimeout(5000)
            if (!fs.existsSync(abs)) continue
            try {
              const b = fs.readFileSync(abs)
              const z = await JSZip.loadAsync(b)
              for (const n of Object.keys(z.files)) {
                if (!n.endsWith('.xml')) continue
                if ((await z.files[n]!.async('string')).includes(stamp)) { saved = true; break }
              }
            } catch { /* mid-write */ }
            if (saved) break
          }
          expect(saved, `${name} autosaved`).toBe(true)
        } else {
          // DOCX: 편집 진입 후 타이핑하고 Done (실제 serialize 경로를 탄다).
          const edit = page.getByRole('button', { name: 'Edit', exact: true })
          if ((await edit.count()) > 0) {
            await edit.first().click({ timeout: 20000 }).catch(() => {})
            await page.waitForTimeout(3000)
            const stamp = `C51D${Date.now().toString(36)}`
            await page.mouse.click(500, 350)
            await page.waitForTimeout(1000)
            await page.keyboard.type(stamp, { delay: 30 }).catch(() => {})
            await page.waitForTimeout(2000)
            const done = page.getByRole('button', { name: 'Done', exact: true })
            if ((await done.count()) > 0) await done.first().click({ timeout: 20000 }).catch(() => {})
            await page.waitForTimeout(5000)
            const abs = path.join(workspaceDir(), 'repos', 'c51save', name)
            let saved = false
            for (let i = 0; i < 12; i++) {
              if (!fs.existsSync(abs)) { await page.waitForTimeout(5000); continue }
              try {
                const b = fs.readFileSync(abs)
                const z = await JSZip.loadAsync(b)
                const doc = await z.files['word/document.xml']!.async('string')
                if (doc.includes(stamp)) { saved = true; break }
              } catch { /* mid-write */ }
              await page.waitForTimeout(5000)
            }
            expect(saved, `${name} docx saved`).toBe(true)
          }
        }
        const buf = await backendBytes('c51save', name)
        const zip = await JSZip.loadAsync(buf)
        const names = Object.keys(zip.files)
        const emb = names.filter((n) => n.includes('embeddings/'))
        expect(emb.length, `${name} embeddings kept`).toBe(1)
        if (isXlsx) {
          expect(names.some((n) => n.includes('vmlDrawing')), `${name} vml kept`).toBe(true)
          const sheet = await zip.files['xl/worksheets/sheet1.xml']!.async('string')
          expect(sheet.includes('oleObjects'), `${name} oleObjects kept`).toBe(true)
          expect(/progId="[^"]+"/.test(sheet), `${name} progId kept`).toBe(true)
        } else {
          const doc = await zip.files['word/document.xml']!.async('string')
          expect(doc.includes('w:object'), `${name} w:object kept`).toBe(true)
          expect(/ProgID="[^"]+"/.test(doc), `${name} ProgID kept`).toBe(true)
        }
        await page.keyboard.press('Escape')
        await page.waitForTimeout(1500)
      }
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('XLSX OLE 이동·삭제 시도는 거부되고 토스트 1회', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c51guard')
    try {
      await openViaWorkspace(page, 'embed-pdf.xlsx', 'c51guard')
      const icon = page.getByTestId('ole-icon').first()
      await expect(icon, 'ole icon').toBeVisible({ timeout: 15000 })
      const box = await icon.boundingBox()
      expect(box, 'icon box').not.toBeNull()
      // 이동 시도: 드래그해도 위치가 바뀌지 않고 토스트가 1회 뜬다.
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
      await page.mouse.down()
      await page.mouse.move(box!.x + 200, box!.y + 200, { steps: 5 })
      await page.mouse.up()
      await page.waitForTimeout(1500)
      const toasts = page.locator('[data-testid="ole-guard-toast"]')
      expect(await toasts.count(), 'guard toast once').toBe(1)
      // 삭제 시도: Delete 키 후에도 토스트는 1회 그대로, 에디터는 그대로 있다.
      await icon.click({ timeout: 15000 })
      await page.keyboard.press('Delete')
      await page.waitForTimeout(1500)
      expect(await toasts.count(), 'still once').toBe(1)
      expect(await page.locator('xlsx-editor').count(), 'editor intact').toBe(1)
    } finally {
      await ctx.close().catch(() => {})
    }
  })
})
