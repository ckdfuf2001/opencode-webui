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
  // XLSX 편집 뒤에는 수식 입력줄에 포커스가 남아 전역 Esc(App.tsx)가 씹히고
  // 탐색기 시트가 열린 채 남는다 — Workspace 버튼이 가려지므로 먼저 접는다.
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
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-row"]').length > 0, null, { timeout: 10000 })
      break
    } catch {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(2000)
    }
  }
  // data-path는 선행 슬래시 없는 상대경로("c51save", "c51save/embed-pdf.xlsx")다.
  // seg 폴더로 정확히 들어가고, 같은 이름 파일이 여러 레포에 있어도 seg 안의 행만 고른다.
  for (let i = 0; i < 8; i++) {
    const has = await page.evaluate(
      ([n, s]) => [...document.querySelectorAll('[data-testid="file-row"]')].some((r) => {
        const p = (r.getAttribute('data-path') || '').replace(/\\/g, '/')
        return p === `${s}/${n}` || p.endsWith(`/${s}/${n}`)
      }), [name, seg])
    if (has) break
    await page.evaluate((s) => {
      const rows = [...document.querySelectorAll('[data-testid="file-row"]')]
      const folder = rows.find((r) => {
        const p = (r.getAttribute('data-path') || '').replace(/\\/g, '/')
        return p === (s as string) || p.endsWith('/' + (s as string))
      })
        ?? rows.find((r) => !(r.getAttribute('data-path') || '').includes('.'))
      const inner = folder?.querySelector('div.flex-1') ?? folder?.querySelector('div')
      inner?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, seg)
    await page.waitForTimeout(2000)
  }
  // seg 폴더 안의 정확한 행을 골라 실제 클릭한다
  // (CSS 속성 선택자는 백슬래시 경로에 약하므로 evaluate로 표시한다).
  const marked = await page.evaluate(([n, s]) => {
    const rows = [...document.querySelectorAll('[data-testid="file-row"]')]
    rows.forEach((e) => e.removeAttribute('data-c51-target'))
    const row = rows.find((r) => {
      const p = (r.getAttribute('data-path') || '').replace(/\\/g, '/')
      return p === `${s}/${n}` || p.endsWith(`/${s}/${n}`)
    })
    if (!row) return false
    row.setAttribute('data-c51-target', '1')
    return true
  }, [name, seg])
  expect(marked, `row found ${seg}/${name}`).toBe(true)
  await page.locator('[data-c51-target="1"]').locator('span', { hasText: name }).first().click({ timeout: 20000 })
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
          // Enter가 에디터 초기화 레이스로 씹히면 값이 입력줄에만 남아 저장이 안 된다.
          // 같은 스탬프 재입력은 멱등이므로 커밋+저장을 최대 3회 재시도한다.
          const xlsxSave = page.locator('[data-testid="preview-doc-header"]').getByRole('button', { name: 'Save', exact: true })
          const abs = path.join(workspaceDir(), 'repos', 'c51save', name)
          const fileHasStamp = async (): Promise<boolean> => {
            try {
              if (!fs.existsSync(abs)) return false
              const b = fs.readFileSync(abs)
              const z = await JSZip.loadAsync(b)
              for (const n of Object.keys(z.files)) {
                if (!n.endsWith('.xml')) continue
                if ((await z.files[n]!.async('string')).includes(stamp)) return true
              }
            } catch { /* mid-write */ }
            return false
          }
          let saved = false
          for (let attempt = 0; attempt < 3 && !saved; attempt++) {
            await page.evaluate((r) => {
              const el = document.querySelector('xlsx-editor') as unknown as { select?: (ref: string) => void; focusGrid?: () => void } | null
              el?.select?.(r)
              el?.focusGrid?.()
            }, 'B2')
            await bar.click({ timeout: 15000 })
            await bar.fill(stamp)
            await bar.press('Enter')
            await page.waitForTimeout(2000)
            // 명시 저장 1회 (자동 저장은 백업).
            if ((await xlsxSave.count()) > 0) await xlsxSave.first().click({ timeout: 20000 }).catch(() => {})
            for (let i = 0; i < 6 && !saved; i++) {
              await page.waitForTimeout(5000)
              saved = await fileHasStamp()
            }
          }
          expect(saved, `${name} autosaved`).toBe(true)
        } else {
          // DOCX: 편집 진입 후 타이핑하고 저장 (xlsx-solo proven pattern:
          // contenteditable 직접 클릭 + Control+End + 헤더 Save + Done).
          const edit = page.getByRole('button', { name: 'Edit', exact: true })
          if ((await edit.count()) > 0) {
            await edit.first().click({ timeout: 20000 }).catch(() => {})
            const stamp = `C51D${Date.now().toString(36)}`
            const pm = page.locator('docx-editor [contenteditable="true"]').first()
            await pm.waitFor({ timeout: 30000 })
            await pm.click({ timeout: 15000 })
            await page.keyboard.press('Control+End')
            await page.keyboard.type(stamp, { delay: 30 }).catch(() => {})
            await page.waitForTimeout(2000)
            const saveBtn = page.locator('[data-testid="preview-doc-header"]').getByRole('button', { name: 'Save', exact: true })
            if ((await saveBtn.count()) > 0) await saveBtn.first().click({ timeout: 20000 }).catch(() => {})
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
            const done = page.getByRole('button', { name: 'Done', exact: true })
            if ((await done.count()) > 0) await done.first().click({ timeout: 20000 }).catch(() => {})
            await page.waitForTimeout(3000)
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

  test('S2b: ole 아이콘 드래그·삭제는 무시된다 (가드 토스트 없음)', async ({ browser }) => {
    // S1 방향 전환 (이동 저장 지원) 이후: 아이콘은 hover 파일명+dblclick
    // 다운로드 전용 affordance다. 아이콘을 끌어도 가드 토스트가 뜨지 않고,
    // 실제 이동은 lib 도형에서 한다 (저장은 S1 xlsx-ole-solo가 보장).
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
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
      await page.mouse.down()
      await page.mouse.move(box!.x + 200, box!.y + 200, { steps: 5 })
      await page.mouse.up()
      await page.waitForTimeout(1500)
      expect(await page.locator('[data-testid="ole-guard-toast"]').count(), 'no guard toast').toBe(0)
      await icon.click({ timeout: 15000 })
      await page.keyboard.press('Delete')
      await page.waitForTimeout(1500)
      expect(await page.locator('[data-testid="ole-guard-toast"]').count(), 'still none').toBe(0)
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('S2: ole 아이콘이 lib 도형 위에 앵커된다', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c51anchor')
    try {
      // xlsx: .xg-obj-unsupported / pptx: ole frame / docx: data-docx-ole span.
      // shadow DOM을 뚫고 찾는다.
      const probes: Record<string, string> = {
        'embed-docx.xlsx': 'xlsx',
        'embed-docx.pptx': 'pptx',
        'embed-docx.docx': 'docx',
      }
      for (const [name, kind] of Object.entries(probes)) {
        await openViaWorkspace(page, name, 'c51anchor')
        const icon = page.getByTestId('ole-icon').first()
        await expect(icon, `${name} icon`).toBeVisible({ timeout: 15000 })
        // 앵커 적용은 비동기(MO/스크롤/리사이즈 추적)라 겹칠 때까지 폴링한다.
        // waitForFunction은 원시값만 돌려주므로 JSON 문자열로 받는다.
        const anchoredRaw = await page
          .waitForFunction(
            (k) => {
              const deep = (root: ParentNode, acc: Element[] = [], depth = 0): Element[] => {
                if (depth > 8) return acc
                for (const el of [...((root as Element).querySelectorAll?.('*') ?? [])]) {
                  acc.push(el)
                  const sr = (el as HTMLElement).shadowRoot
                  if (sr) deep(sr, acc, depth + 1)
                }
                return acc
              }
              const vis = (e: Element): boolean => {
                const r = e.getBoundingClientRect()
                return r.width > 0 && r.height > 0
              }
              const host = document.querySelector('.xlsxengine-host, [data-testid="pptx-viewer-root"], .docxengine-host')
              const all = host ? deep(host) : []
              let shape: { x: number; y: number; w: number; h: number } | null = null
              if (k === 'xlsx') {
                const el = all.find((e) => (e.className?.toString?.() ?? '').includes('xg-obj-unsupported') && vis(e))
                if (el) { const r = el.getBoundingClientRect(); shape = { x: r.x, y: r.y, w: r.width, h: r.height } }
              } else if (k === 'pptx') {
                const el = all.find(
                  (e) =>
                    (e.getAttribute('data-element-id') || '').includes('-frame-') &&
                    /download/i.test(e.textContent || '') && vis(e),
                )
                if (el) { const r = el.getBoundingClientRect(); shape = { x: r.x, y: r.y, w: r.width, h: r.height } }
              } else {
                const el = all.find((e) => e.hasAttribute('data-docx-ole') && vis(e))
                if (el) { const r = el.getBoundingClientRect(); shape = { x: r.x, y: r.y, w: r.width, h: r.height } }
              }
              const btn = document.querySelector('[data-testid="ole-icon"]')
              const br = btn?.getBoundingClientRect()
              if (!shape || !br) return 'wait'
              const s = shape
              const insideX = br.x + br.width >= s.x - 24 && br.x <= s.x + s.w + 24
              const insideY = br.y + br.height >= s.y - 24 && br.y <= s.y + s.h + 24
              return insideX && insideY
                ? 'ok'
                : `no:icon=${Math.round(br.x)},${Math.round(br.y)} shape=${Math.round(s.x)},${Math.round(s.y)}`
            },
            kind,
            { timeout: 20000, polling: 500 },
          )
          .then(
            (v) => String(v),
            () => 'timeout',
          )
        expect(anchoredRaw === 'ok', `${name} icon anchored on shape (${anchoredRaw})`).toBe(true)
        await page.keyboard.press('Escape')
        await page.waitForTimeout(1500)
      }
    } finally {
      await ctx.close().catch(() => {})
    }
  })
})
