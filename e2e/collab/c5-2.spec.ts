import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { backendBase, workspaceDir } from './helpers/env'
import { gotoApp, openEditor } from './helpers/viewer'
import { ADA, seedUser } from './helpers/users'

/**
 * C5-2: INSERT 문서 첨부 (리본 "첨부" 탭 = 공식 ribbonAddIns).
 * - Edit → "첨부" 탭 → "문서 첨부" 명령 → 파일 선택 → 서버 조립 → 방 리셋 →
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

/**
 * C5-2 add-in 탭: 리본 "첨부" 탭 → "문서 첨부" 명령으로 파일을 올린다
 * (공식 ribbonAddIns — Help 뒤 새 탭, lib 패치 없음).
 * C5-4 flag-day: /edit/* 직접 goto 후 리본 첨부 탭에서 삽입한다 (in-page Edit 폐지).
 */
async function attachViaAddInTab(page: Page, seg: string, hostName: string, attachAbs: string): Promise<void> {
  await openEditor(page, `${seg}/${hostName}`)
  const tab = page.getByRole('tab', { name: '첨부', exact: true }).first()
  await tab.waitFor({ timeout: 30000 })
  await tab.click({ timeout: 15000 })
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15000 }),
    page.getByText('문서 첨부', { exact: true }).first().click({ timeout: 15000 }),
  ])
  await chooser.setFiles(attachAbs)
}

test.describe('C5-2: INSERT 문서 첨부', () => {
  test('P2-1: pptx에 docx 첨부 → 아이콘+편집기(원본 바이트 보존)', async ({ browser }) => {    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
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
      await attachViaAddInTab(page, 'c52pptx', 'embed-pdf.pptx', path.resolve(FIX, 'embed-docx.docx'))
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
      // 새 첨부 칩이 보인다 (C7n 미리보기 img; 파싱분은 lib-only라 카운트하지 않는다).
      await expect
        .poll(() => page.getByTestId('ole-icon').evaluateAll((els) => els.some((e) => (e as HTMLElement).getAttribute('aria-label') === '첨부 embed-docx.docx')), { timeout: 60000, intervals: [1000] })
        .toBe(true)
      const after = await backendBytes('c52pptx', 'embed-pdf.pptx')
      const z1 = await JSZip.loadAsync(after)
      const emb1 = Object.keys(z1.files).filter((n) => n.includes('embeddings/') && !n.endsWith('/'))
      expect(emb1.length, 'embeddings +1').toBe(emb0 + 1)
      // progId 영문 유지.
      const slide = await z1.files['ppt/slides/slide1.xml']!.async('string')
      expect(/progId="[A-Za-z0-9.]+"/.test(slide), 'progId english').toBe(true)
      // C5-4 flag-day: package 오피스 파트 dblclick → /edit/* 새 탭 (오버레이 폐지).
      // 원본 바이트 보존은 디스크 embeddings와 첨부 파일을 직접 비교한다.
    const attachBuf = fs.readFileSync(path.resolve(FIX, 'embed-docx.docx'))
    const freshBoxPptx = await page.getByTestId('ole-icon').evaluateAll((els) => {
      const hit = els.find((e) => (e as HTMLElement).getAttribute('aria-label') === '첨부 embed-docx.docx') as HTMLElement | null
      if (!hit) return null
      const r = hit.getBoundingClientRect()
      return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]
    })
    expect(freshBoxPptx, 'fresh chip box').not.toBeNull()
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 15000 }),
      page.mouse.dblclick(freshBoxPptx![0], freshBoxPptx![1]),
    ])
    await popup.waitForLoadState('domcontentloaded', { timeout: 30000 })
    expect(popup.url()).toMatch(/\/edit\/.+\.pptx\/-\/.+\.docx/)
      await popup.close().catch(() => {})
      const zAfter = await JSZip.loadAsync(backendBytes('c52pptx', 'embed-pdf.pptx'))
      const partName = Object.keys(zAfter.files).find((n) => n.includes('embeddings/') && n.endsWith('embed-docx.docx'))
      expect(partName, 'inserted part present').toBeTruthy()
      const partBytes = Buffer.from(await zAfter.files[partName!]!.async('uint8array'))
      expect(partBytes.equals(attachBuf), 'attached bytes intact').toBe(true)
      // C7 백그라운드 병합은 리로드하지 않는다. lib 렌더 대신 디스크 조립 구조를
      // 직접 단언한다 (lib 렌더는 D25 파싱분 경로에서 커버).
      // C7n: 우리 조립분이 D25 파싱분과 같은 구조면 lib도 동일하게 렌더한다 (프로브 확인).
      {
        const zf = await JSZip.loadAsync(backendBytes('c52pptx', 'embed-pdf.pptx'))
        const slide = await zf.files['ppt/slides/slide1.xml']!.async('string')
        const frames = [...slide.matchAll(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g)].map((m) => m[0]!)
        expect(frames.length, 'at least one frame').toBeGreaterThan(0)
        const mine = frames.filter((f) => /progId="Word\.Document\.12"/.test(f))
        expect(mine.length, 'assembled ole frame present').toBeGreaterThan(0)
        const fr = mine[0]!
        expect(/<p:oleObj[^>]*r:id="[^"]+"/.test(fr), 'oleObj r:id').toBe(true)
        expect(/<a:blip[^>]*r:embed="[^"]+"/.test(fr), 'fallback blip r:embed').toBe(true)
      }
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('P2-2: xlsx에 docx 첨부 → 아이콘+편집기(원본 바이트 보존)', async ({ browser }) => {    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
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
      await attachViaAddInTab(page, 'c52xlsx', 'embed-pdf.xlsx', path.resolve(FIX, 'embed-docx.docx'))
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
      // 새 첨부 칩이 보인다 (C7n 미리보기 img; 파싱분은 lib-only라 카운트하지 않는다).
      await expect
        .poll(() => page.getByTestId('ole-icon').evaluateAll((els) => els.some((e) => (e as HTMLElement).getAttribute('aria-label') === '첨부 embed-docx.docx')), { timeout: 60000, intervals: [1000] })
        .toBe(true)
      // 본문에 미리보기 그림이 보인다 (pic 앵커 네이티브 렌더).
      // C7 백그라운드 병합은 리로드하지 않으므로 새로고침 뒤에 확인한다.
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
      await page.locator('xlsx-editor [part~="formula-bar"] textarea').first().waitFor({ timeout: 60000 })
      const picState = (): Promise<string> =>
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
      await expect.poll(picState, { timeout: 20000, intervals: [1000] }).toBe('ok')
      // 새로고침 뒤 칩이 다시 올라올 때까지 기다린다 (106 재전송 + 오버레이 반영).
      await expect
        .poll(() => page.getByTestId('ole-icon').evaluateAll((els) => els.some((e) => (e as HTMLElement).getAttribute('aria-label') === '첨부 embed-docx.docx')), { timeout: 60000, intervals: [1000] })
        .toBe(true)
      const after = await backendBytes('c52xlsx', 'embed-pdf.xlsx')
      const z1 = await JSZip.loadAsync(after)
      // 3곳 일치: drawing anchor + oleObjects + VML.
      const sheet = await z1.files['xl/worksheets/sheet1.xml']!.async('string')
      expect(sheet).toContain('<oleObjects')
      expect(sheet).toContain('progId="Word.Document.12"')
      expect(Object.keys(z1.files).some((n) => n.includes('vmlDrawing') && !n.endsWith('/'))).toBe(true)
      // P0-4: xlsx INSERT는 package 조립이라 편집 탭으로 열린다 (다운로드 아님).
      // 새로 붙은 첨부의 바이트 보존은 디스크 embeddings와 직접 비교한다.
      // (nth(0)이 아니라 방금 붙인 칩을 특정해서 더블클릭 — 커버 등 다른 칩과 겹칠 수 있음).
      const attachBuf = fs.readFileSync(path.resolve(FIX, 'embed-docx.docx'))
      const freshBox = await page.getByTestId('ole-icon').evaluateAll((els) => {
        const hit = els.find((e) => (e as HTMLElement).getAttribute('aria-label') === '첨부 embed-docx.docx') as HTMLElement | null
        if (!hit) return null
        const r = hit.getBoundingClientRect()
        return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]
      })
      expect(freshBox, 'fresh chip box').not.toBeNull()
      const [popup] = await Promise.all([
        page.waitForEvent('popup', { timeout: 15000 }),
        page.mouse.dblclick(freshBox![0], freshBox![1]),
      ])
      await popup.waitForLoadState('domcontentloaded', { timeout: 30000 })
      expect(popup.url()).toMatch(/\/edit\/.+\.xlsx\/-\/.+\.docx/)
      await popup.close().catch(() => {})
      const zAfter = await JSZip.loadAsync(await backendBytes('c52xlsx', 'embed-pdf.xlsx'))
      const partName = Object.keys(zAfter.files).find((n) => n.includes('embeddings/') && n.endsWith('embed-docx.docx'))
      expect(partName, 'inserted part present').toBeTruthy()
      const partBytes = Buffer.from(await zAfter.files[partName!]!.async('uint8array'))
      expect(partBytes.equals(attachBuf), 'attached bytes intact').toBe(true)
      // pic 앵커는 네이티브로 이동+저장된다 (S1 수술 패치 불필요).
      const anchorOf = async (): Promise<string> => {
        const b = await backendBytes('c52xlsx', 'embed-pdf.xlsx')
        const z = await JSZip.loadAsync(b)
        const names = Object.keys(z.files).filter((n) => n.includes('drawing1.xml') && !n.endsWith('/'))
        if (names.length === 0) return 'NO-DRAWING'
        const txt = await z.files[names[0]!]!.async('string')
        const ms = [...txt.matchAll(/<xdr:from>.*?<\/xdr:to>/gs)].map((m) => m[0])
        return ms.length > 0 ? ms[ms.length - 1]!.slice(0, 250) : 'NO-ANCHOR'
      }
      const anchorBefore = await anchorOf()
      // attachViaAddInTab에서 이미 편집 중이다. Done 버튼 대기 후 드래그한다.
      await page.getByRole('button', { name: 'Done', exact: true }).waitFor({ timeout: 30000 })
      await page.waitForTimeout(2000)
      const picRect = await page.evaluate(() => {
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
        if (!host) return null
        for (const el of deep(host)) {
          if (el.tagName !== 'IMG' || el.getAttribute('alt') !== 'embed-docx') continue
          const r = el.getBoundingClientRect()
          if (r.width > 0 && r.height > 0) return { x: r.x, y: r.y, w: r.width, h: r.height }
        }
        return null
      })
      expect(picRect, 'ole pic visible').not.toBeNull()
      const cx = picRect!.x + picRect!.w / 2
      const cy = picRect!.y + picRect!.h / 2
      await page.mouse.move(cx, cy)
      await page.mouse.down()
      await page.mouse.move(cx + 120, cy + 90, { steps: 15 })
      await page.mouse.up()
      await expect
        .poll(anchorOf, { timeout: 25000, intervals: [1000] })
        .not.toBe(anchorBefore)
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('P2-3: docx에 xlsx 첨부 → 아이콘+편집기(원본 바이트 보존)', async ({ browser }) => {
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
      await attachViaAddInTab(page, 'c52docx', 'embed-pdf.docx', path.resolve(FIX, 'embed-docx.xlsx'))
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
      // 새 첨부 칩이 보인다 (C7n 미리보기 img; 파싱분은 lib-only라 카운트하지 않는다).
      await expect
        .poll(() => page.getByTestId('ole-icon').evaluateAll((els) => els.some((e) => (e as HTMLElement).getAttribute('aria-label') === '첨부 embed-docx.xlsx')), { timeout: 60000, intervals: [1000] })
        .toBe(true)
      const after = await backendBytes('c52docx', 'embed-pdf.docx')
      const z1 = await JSZip.loadAsync(after)
      const emb1 = Object.keys(z1.files).filter(embName)
      expect(emb1.length, 'embeddings +1').toBe(emb0 + 1)
      // progId 영문 유지.
      const doc = await z1.files['word/document.xml']!.async('string')
      expect(/ProgID="[A-Za-z0-9.]+"/.test(doc), 'ProgID english').toBe(true)
      // C5-4 flag-day: package 오피스 파트 dblclick → /edit/* 새 탭 (오버레이 폐지).
      // 원본 바이트 보존은 디스크 embeddings와 첨부 파일을 직접 비교한다.
      // (nth(0)이 아니라 방금 붙인 칩을 특정해서 더블클릭 — 커버 등 다른 칩과 겹칠 수 있음).
      const attachBuf = fs.readFileSync(path.resolve(FIX, 'embed-docx.xlsx'))
      const freshBoxDocx = await page.getByTestId('ole-icon').evaluateAll((els) => {
        const hit = els.find((e) => (e as HTMLElement).getAttribute('aria-label') === '첨부 embed-docx.xlsx') as HTMLElement | null
        if (!hit) return null
        const r = hit.getBoundingClientRect()
        return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]
      })
      expect(freshBoxDocx, 'fresh chip box').not.toBeNull()
      const [popup] = await Promise.all([
        page.waitForEvent('popup', { timeout: 15000 }),
        page.mouse.dblclick(freshBoxDocx![0], freshBoxDocx![1]),
      ])
      await popup.waitForLoadState('domcontentloaded', { timeout: 30000 })
      expect(popup.url()).toMatch(/\/edit\/.+\.docx\/-\/.+\.xlsx/)
      await popup.close().catch(() => {})
      const zAfter = await JSZip.loadAsync(backendBytes('c52docx', 'embed-pdf.docx'))
      const partName = Object.keys(zAfter.files).find((n) => n.includes('embeddings/') && n.endsWith('embed-docx.xlsx'))
      expect(partName, 'inserted part present').toBeTruthy()
      const partBytes = Buffer.from(await zAfter.files[partName!]!.async('uint8array'))
      expect(partBytes.equals(attachBuf), 'attached bytes intact').toBe(true)
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('P2-4: pptx 첨부 탭 → docx 첨부', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c52pptxtab', ['embed-pdf.pptx'])
    try {
      await openViaWorkspace(page, 'embed-pdf.pptx', 'c52pptxtab')
      const before = await backendBytes('c52pptxtab', 'embed-pdf.pptx')
      const z0 = await JSZip.loadAsync(before)
      const emb0 = Object.keys(z0.files).filter((n) => n.includes('embeddings/') && !n.endsWith('/')).length
      await attachViaAddInTab(page, 'c52pptxtab', 'embed-pdf.pptx', path.resolve(FIX, 'embed-docx.docx'))
      await expect
        .poll(
          async () => {
            try {
              const b = await backendBytes('c52pptxtab', 'embed-pdf.pptx')
              const z = await JSZip.loadAsync(b)
              return Object.keys(z.files).filter((n) => n.includes('embeddings/') && !n.endsWith('/')).length
            } catch {
              return -1
            }
          },
          // pptx 직렬화+방 시드가 무거워 부하 시 30초를 넘긴다. 중단은
          // 토스트로 확인한다 (성공하면 반드시 +1이 된다).
          { timeout: 90000, intervals: [1000] },
        )
        .toBe(emb0 + 1)
      // 새 첨부 칩이 보인다 (C7n 미리보기 img; 파싱분은 lib-only라 카운트하지 않는다).
      await expect
        .poll(() => page.getByTestId('ole-icon').evaluateAll((els) => els.some((e) => (e as HTMLElement).getAttribute('aria-label') === '첨부 embed-docx.docx')), { timeout: 60000, intervals: [1000] })
        .toBe(true)
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('P2-5: xlsx 첨부 탭 → docx 첨부', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c52xlsxtab', ['embed-pdf.xlsx'])
    try {
      await openViaWorkspace(page, 'embed-pdf.xlsx', 'c52xlsxtab')
      const before = await backendBytes('c52xlsxtab', 'embed-pdf.xlsx')
      const z0 = await JSZip.loadAsync(before)
      const emb0 = Object.keys(z0.files).filter((n) => n.includes('embeddings/') && !n.endsWith('/')).length
      await attachViaAddInTab(page, 'c52xlsxtab', 'embed-pdf.xlsx', path.resolve(FIX, 'embed-docx.docx'))
      await expect
        .poll(
          async () => {
            try {
              const b = await backendBytes('c52xlsxtab', 'embed-pdf.xlsx')
              const z = await JSZip.loadAsync(b)
              return Object.keys(z.files).filter((n) => n.includes('embeddings/') && !n.endsWith('/')).length
            } catch {
              return -1
            }
          },
          { timeout: 30000, intervals: [1000] },
        )
        .toBe(emb0 + 1)
      // 새 첨부 칩이 보인다 (C7n 미리보기 img; 파싱분은 lib-only라 카운트하지 않는다).
      await expect
        .poll(() => page.getByTestId('ole-icon').evaluateAll((els) => els.some((e) => (e as HTMLElement).getAttribute('aria-label') === '첨부 embed-docx.docx')), { timeout: 60000, intervals: [1000] })
        .toBe(true)
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('P2-6: docx 첨부 탭 → xlsx 첨부', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c52docxtab', ['embed-pdf.docx'])
    try {
      await openViaWorkspace(page, 'embed-pdf.docx', 'c52docxtab')
      const before = await backendBytes('c52docxtab', 'embed-pdf.docx')
      const z0 = await JSZip.loadAsync(before)
      const emb0 = Object.keys(z0.files).filter((n) => n.includes('embeddings/') && !n.endsWith('/')).length
      await attachViaAddInTab(page, 'c52docxtab', 'embed-pdf.docx', path.resolve(FIX, 'embed-docx.xlsx'))
      await expect
        .poll(
          async () => {
            try {
              const b = await backendBytes('c52docxtab', 'embed-pdf.docx')
              const z = await JSZip.loadAsync(b)
              return Object.keys(z.files).filter((n) => n.includes('embeddings/') && !n.endsWith('/')).length
            } catch {
              return -1
            }
          },
          { timeout: 30000, intervals: [1000] },
        )
        .toBe(emb0 + 1)
      // 새 첨부 칩이 보인다 (C7n 미리보기 img; 파싱분은 lib-only라 카운트하지 않는다).
      await expect
        .poll(() => page.getByTestId('ole-icon').evaluateAll((els) => els.some((e) => (e as HTMLElement).getAttribute('aria-label') === '첨부 embed-docx.xlsx')), { timeout: 60000, intervals: [1000] })
        .toBe(true)
    } finally {
      await ctx.close().catch(() => {})
    }
  })
})
