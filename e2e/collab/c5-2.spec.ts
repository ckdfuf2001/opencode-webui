import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { backendBase, workspaceDir } from './helpers/env'
import { gotoApp } from './helpers/viewer'
import { ADA, seedUser } from './helpers/users'

/**
 * C5-2 red: INSERT 문서 첨부.
 * - 타이틀바/헤더의 "문서 첨부" 버튼 → 파일 선택 → 서버 조립 → 방 리셋 →
 *   기존 첨부로 취급 (C5-1 보기·다운로드·보존 경로 재사용).
 * - 순서 PPTX → XLSX → DOCX. 관문 G: docx/xlsx 첨부 + 제네릭 PNG + 영문 progId.
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

const HOSTS: Record<string, string> = {
  'embed-pdf.pptx': '[data-testid="pptx-viewer-root"]',
  'embed-pdf.xlsx': '.xlsxengine-host',
  'embed-pdf.docx': '.docxengine-host',
}

async function openViaWorkspace(page: Page, name: string, seg: string): Promise<void> {
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
      rows.forEach((e) => e.removeAttribute('data-c52-target'))
      const row = rows.find((r) => {
        const p = (r.getAttribute('data-path') || '').replace(/\\/g, '/')
        return p === `${s}/${n}` || p.endsWith(`/${s}/${n}`)
      })
      if (!row) return false
      row.setAttribute('data-c52-target', '1')
      return true
    },
    [name, seg],
  )
  if (!marked) throw new Error(`row not found ${seg}/${name}`)
  await page.locator('[data-c52-target="1"]').locator('span', { hasText: name }).first().click({ timeout: 20000 })
  await page.waitForSelector(HOSTS[name]!, { timeout: 60000 })
  await page.waitForTimeout(4000)
}

async function backendBytes(localPath: string, name: string): Promise<Buffer> {
  return fs.readFileSync(path.join(workspaceDir(), 'repos', localPath, name))
}

/** 문서 첨부 버튼으로 파일을 올린다 (input=file 방식). */
async function attachViaButton(page: Page, attachAbs: string): Promise<void> {
  const btn = page.getByRole('button', { name: '문서 첨부', exact: true }).first()
  await btn.waitFor({ timeout: 20000 })
  // 숨은 input에 직접 세팅한다.
  const input = page.locator('input[data-testid="office-attach-input"]').first()
  if ((await input.count()) > 0) {
    await input.setInputFiles(attachAbs)
  } else {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15000 }),
      btn.click({ timeout: 15000 }),
    ])
    await chooser.setFiles(attachAbs)
  }
}

test.describe('C5-2: INSERT 문서 첨부', () => {
  test('P2-1: pptx에 docx 첨부 → 아이콘+다운로드', async ({ browser }) => {    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    // 호스트는 첨부 없는 자체 최소 pptx — 시드용으로 embed-pdf.pptx의
    // 첨부를 뺀 형태가 아니라 빈 호스트를 쓴다 (route가 조립).
    await mkRepo('c52pptx', ['embed-pdf.pptx'])
    // NOTE: 호스트 자체는 C5-0 embed가 아니라 C5-2가 붙인다. 여기서는
    // 같은 파일을 호스트 삼아 두 번째 첨부(docx 1개 추가)를 검증한다.
    try {
      await openViaWorkspace(page, 'embed-pdf.pptx', 'c52pptx')
      const before = await backendBytes('c52pptx', 'embed-pdf.pptx')
      const z0 = await JSZip.loadAsync(before)
      const embName = (n: string): boolean => n.includes('embeddings/') && !n.endsWith('/')
      const emb0 = Object.keys(z0.files).filter(embName).length
      await attachViaButton(page, path.resolve(FIX, 'embed-docx.docx'))
      // 서버 조립 확인: 디스크 embeddings가 1개 늘어난다.
      await expect
        .poll(
          async () => {
            try {
              const b = await backendBytes('c52pptx', 'embed-pdf.pptx')
              const z = await JSZip.loadAsync(b)
              return Object.keys(z.files).filter((n) => n.includes('embeddings/') && !n.endsWith('/')).length
            } catch {
              return -1
            }
          },
          { timeout: 30000, intervals: [1000] },
        )
        .toBe(emb0 + 1)
      // 방 리셋 후 재조회가 끝나면 ole 아이콘이 2개가 된다.
      await expect(page.getByTestId('ole-icon')).toHaveCount(2, { timeout: 60000 })
      // 본문에 새 ole 프레임이 보인다 (Fallback pic 렌더). lib 렌더는 비동기라 폴링한다.
      const frameFn = (): Promise<string> =>
        page.evaluate(() => {
          const deep = (root: ParentNode, acc: Element[] = [], depth = 0): Element[] => {
            if (depth > 8) return acc
            for (const el of [...((root as Element).querySelectorAll?.('*') ?? [])]) {
              acc.push(el)
              const sr = (el as HTMLElement).shadowRoot
              if (sr) deep(sr, acc, depth + 1)
            }
            return acc
          }
          const host = document.querySelector('[data-testid="pptx-viewer-root"]')
          if (!host) return 'no-host'
          const all = deep(host)
          const frames = all.filter((e) => (e.getAttribute?.('data-element-id') || '').includes('-frame-'))
          const mine = frames.filter((e) => (e.textContent || '').includes('embed-docx'))
          if (mine.length === 0) {
            const texts = frames.map((e) => (e.textContent || '').slice(0, 40))
            return `noframe texts=${JSON.stringify(texts)}`
          }
          const r = mine[0]!.getBoundingClientRect()
          const imgs = [...mine[0]!.querySelectorAll('img')].slice(0, 3).map((im) => {
            const b = im.getBoundingClientRect()
            return { src: (im.getAttribute('src') || '').slice(0, 15), w: Math.round(b.width), h: Math.round(b.height) }
          })
          const imgOk = imgs.some((im) => im.w > 0 && im.h > 0 && im.src.indexOf('data:image/png') === 0)
          if (r.width > 0 && r.height > 0 && imgOk) return 'ok'
          // 비교용: 기존 pdf 프레임도 함께 덤프.
          const others = frames
            .filter((e) => !(e.textContent || '').includes('embed-docx'))
            .slice(0, 3)
            .map((e) => {
              const b = e.getBoundingClientRect()
              return `eid=${(e.getAttribute('data-element-id') || '').slice(-30)} rect=${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)}x${Math.round(b.height)} style=${(e.getAttribute('style') || '').slice(0, 120)}`
            })
          return `hidden rect=${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)} imgs=${JSON.stringify(imgs)} others=${JSON.stringify(others)}`
        })
      await expect.poll(frameFn, { timeout: 20000, intervals: [1000] }).toBe('ok')
      const after = await backendBytes('c52pptx', 'embed-pdf.pptx')
      const z1 = await JSZip.loadAsync(after)
      const emb1 = Object.keys(z1.files).filter((n) => n.includes('embeddings/') && !n.endsWith('/'))
      expect(emb1.length, 'embeddings +1').toBe(emb0 + 1)
      // progId 영문 유지.
      const slide = await z1.files['ppt/slides/slide1.xml']!.async('string')
      expect(/progId="[A-Za-z0-9.]+"/.test(slide), 'progId english').toBe(true)
      // 새로 붙은 첨부를 더블클릭하면 원본 바이트 그대로 내려온다.
      const attachBuf = fs.readFileSync(path.resolve(FIX, 'embed-docx.docx'))
      const icons = page.getByTestId('ole-icon')
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 20000 }),
        icons.nth(1).dblclick({ timeout: 15000 }),
      ])
      const dlPath = await dl.path()
      expect(dlPath, 'download path').toBeTruthy()
      expect(fs.readFileSync(dlPath!).equals(attachBuf), 'attached bytes intact').toBe(true)
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('P2-2: xlsx에 docx 첨부 → 아이콘+다운로드', async ({ browser }) => {    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c52xlsx', ['embed-pdf.xlsx'])
    try {
      await openViaWorkspace(page, 'embed-pdf.xlsx', 'c52xlsx')
      const before = await backendBytes('c52xlsx', 'embed-pdf.xlsx')
      const z0 = await JSZip.loadAsync(before)
      const embName = (n: string): boolean => n.includes('embeddings/') && !n.endsWith('/')
      const emb0 = Object.keys(z0.files).filter(embName).length
      await attachViaButton(page, path.resolve(FIX, 'embed-docx.docx'))
      // 서버 조립 확인: embeddings가 1개 늘어난다.
      await expect
        .poll(
          async () => {
            try {
              const b = await backendBytes('c52xlsx', 'embed-pdf.xlsx')
              const z = await JSZip.loadAsync(b)
              return Object.keys(z.files).filter(embName).length
            } catch {
              return -1
            }
          },
          { timeout: 30000, intervals: [1000] },
        )
        .toBe(emb0 + 1)
      // 방 리셋 후 재조회가 끝나면 ole 아이콘이 2개가 된다.
      await expect(page.getByTestId('ole-icon')).toHaveCount(2, { timeout: 60000 })
      // 본문에 미리보기 그림이 보인다 (pic 앵커 네이티브 렌더).
      const previewState = await page.evaluate(() => {
        const deep = (root: ParentNode, acc: Element[] = [], depth = 0): Element[] => {
          if (depth > 8) return acc
          for (const el of [...((root as Element).querySelectorAll?.('*') ?? [])]) {
            acc.push(el)
            const sr = (el as HTMLElement).shadowRoot
            if (sr) deep(sr, acc, depth + 1)
          }
          return acc
        }
        const host = document.querySelector('.xlsxengine-host')
        if (!host) return 'no-host'
        const imgs = deep(host).filter((e) => e.tagName === 'IMG')
        const alts = imgs.map((e) => e.getAttribute('alt'))
        if (!alts.includes('embed-docx')) return `alts=${JSON.stringify(alts)}`
        const vis = imgs.some((e) => {
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        })
        return vis ? 'ok' : 'hidden'
      })
      expect(previewState, 'body preview image visible').toBe('ok')
      const after = await backendBytes('c52xlsx', 'embed-pdf.xlsx')
      const z1 = await JSZip.loadAsync(after)
      // 3곳 일치: drawing anchor + oleObjects + VML.
      const sheet = await z1.files['xl/worksheets/sheet1.xml']!.async('string')
      expect(sheet).toContain('<oleObjects')
      expect(sheet).toContain('progId="Word.Document.12"')
      expect(Object.keys(z1.files).some((n) => n.includes('vmlDrawing') && !n.endsWith('/'))).toBe(true)
      // 새로 붙은 첨부를 더블클릭하면 원본 바이트 그대로 내려온다.
      const attachBuf = fs.readFileSync(path.resolve(FIX, 'embed-docx.docx'))
      const icons = page.getByTestId('ole-icon')
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 20000 }),
        icons.nth(1).dblclick({ timeout: 15000 }),
      ])
      const dlPath = await dl.path()
      expect(dlPath, 'download path').toBeTruthy()
      expect(fs.readFileSync(dlPath!).equals(attachBuf), 'attached bytes intact').toBe(true)
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('P2-3: docx에 xlsx 첨부 → 아이콘+다운로드', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c52docx', ['embed-pdf.docx'])
    try {
      await openViaWorkspace(page, 'embed-pdf.docx', 'c52docx')
      const before = await backendBytes('c52docx', 'embed-pdf.docx')
      const z0 = await JSZip.loadAsync(before)
      const embName = (n: string): boolean => n.includes('embeddings/') && !n.endsWith('/')
      const emb0 = Object.keys(z0.files).filter(embName).length
      await attachViaButton(page, path.resolve(FIX, 'embed-docx.xlsx'))
      // 서버 조립 확인: embeddings가 1개 늘어난다.
      await expect
        .poll(
          async () => {
            try {
              const b = await backendBytes('c52docx', 'embed-pdf.docx')
              const z = await JSZip.loadAsync(b)
              return Object.keys(z.files).filter(embName).length
            } catch {
              return -1
            }
          },
          { timeout: 30000, intervals: [1000] },
        )
        .toBe(emb0 + 1)
      // 재조회가 끝나면 ole 아이콘이 2개가 된다.
      await expect(page.getByTestId('ole-icon')).toHaveCount(2, { timeout: 60000 })
      const after = await backendBytes('c52docx', 'embed-pdf.docx')
      const z1 = await JSZip.loadAsync(after)
      const emb1 = Object.keys(z1.files).filter(embName)
      expect(emb1.length, 'embeddings +1').toBe(emb0 + 1)
      // progId 영문 유지.
      const doc = await z1.files['word/document.xml']!.async('string')
      expect(/ProgID="[A-Za-z0-9.]+"/.test(doc), 'ProgID english').toBe(true)
      // 새로 붙은 첨부를 더블클릭하면 원본 바이트 그대로 내려온다.
      const attachBuf = fs.readFileSync(path.resolve(FIX, 'embed-docx.xlsx'))
      const icons = page.getByTestId('ole-icon')
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 20000 }),
        icons.nth(1).dblclick({ timeout: 15000 }),
      ])
      const dlPath = await dl.path()
      expect(dlPath, 'download path').toBeTruthy()
      expect(fs.readFileSync(dlPath!).equals(attachBuf), 'attached bytes intact').toBe(true)
    } finally {
      await ctx.close().catch(() => {})
    }
  })
})
