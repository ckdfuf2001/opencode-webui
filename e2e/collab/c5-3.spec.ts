import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { backendBase, workspaceDir } from './helpers/env'
import { gotoApp } from './helpers/viewer'
import { ADA, GRACE, seedUser } from './helpers/users'

/**
 * C5-3: 첨부 파일명 라벨 + 첨부 편집 + Word 보기 리본.
 * - E1: 모든 첨부에 아이콘 아래 가운데 정렬 파일명 라벨 (3종 x 짧은/긴 이름).
 * - E2: package 첨부 더블클릭 → 편집기(제목 `부모 › 첨부`, 바로 편집) →
 *   PUT 교체 저장. PDF 미리보기, CFB 다운로드, 잠금/읽기전용, traversal 거부.
 * - E3: docx 보기 모드 리본 표시 (첨부 탭은 편집 모드에서만).
 * (red 먼저: 라벨/편집기/보기리본이 없어 전부 실패해야 한다)
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
  for (const n of files) {
    // ole/ 우선, 없으면 fixtures 루트 (collab-features.* / collab-3slides.*).
    const src = fs.existsSync(path.join(FIX, n)) ? path.join(FIX, n) : path.join('e2e/collab/fixtures', n)
    fs.copyFileSync(src, path.join(dir, n))
  }
}

const HOSTS: Record<string, string> = {
  'embed-pdf.pptx': '[data-testid="pptx-viewer-root"]',
  'embed-pdf.xlsx': '.xlsxengine-host',
  'embed-pdf.docx': '.docxengine-host',
  'collab-3slides.pptx': '[data-testid="pptx-viewer-root"]',
  'collab-features.xlsx': '.xlsxengine-host',
  'collab-features.docx': '.docxengine-host',
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
      rows.forEach((e) => e.removeAttribute('data-c53-target'))
      const row = rows.find((r) => {
        const p = (r.getAttribute('data-path') || '').replace(/\\/g, '/')
        return p === `${s}/${n}` || p.endsWith(`/${s}/${n}`)
      })
      if (!row) return false
      row.setAttribute('data-c53-target', '1')
      return true
    },
    [name, seg],
  )
  if (!marked) throw new Error(`row not found ${seg}/${name}`)
  await page.locator('[data-c53-target="1"]').locator('span', { hasText: name }).first().click({ timeout: 20000 })
  await page.waitForSelector(HOSTS[name]!, { timeout: 60000 })
  await page.waitForTimeout(4000)
}

async function backendBytes(localPath: string, name: string): Promise<Buffer> {
  return fs.readFileSync(path.join(workspaceDir(), 'repos', localPath, name))
}

/**
 * 첨부 편집기의 ProseMirror에 포커스를 준다. docx lib은 shadow DOM에 렌더하므로
 * document.activeElement는 호스트를 가리킨다 — 섀도우 루트 기준으로 확인한다.
 * 중앙 임베드 아이콘에 클릭이 먹으면 포커스가 텍스트에 안 가므로 첫 문단 좌측을 클릭한다.
 */
async function focusAttachEditor(page: Page): Promise<Locator> {
  const pm = page.locator('[data-testid="attach-editor"] [contenteditable="true"]').first()
  await pm.waitFor({ timeout: 30000 })
  await pm.click({ position: { x: 120, y: 60 }, timeout: 15000 })
  await expect
    .poll(
      () =>
        pm.evaluate((el) => {
          const root = el.getRootNode() as ShadowRoot | Document
          const ae = root instanceof ShadowRoot ? root.activeElement : el.ownerDocument.activeElement
          return ae === el
        }),
      { timeout: 10000, intervals: [500] },
    )
    .toBe(true)
  return pm
}

/** 직접 POST 조립 (E1/E2 셋업용 — UI 첨부 대신 서버 조립 경로 사용). */
async function postEmbedFile(
  localPath: string,
  hostName: string,
  attachName: string,
  attachBytes: Buffer,
  extra?: { slide?: number; sheet?: number },
): Promise<{ newHash: string }> {
  const fd = new FormData()
  fd.append('path', `${localPath}/${hostName}`)
  fd.append('file', new Blob([attachBytes]), attachName)
  if (extra?.slide !== undefined) fd.append('slide', String(extra.slide))
  if (extra?.sheet !== undefined) fd.append('sheet', String(extra.sheet))
  const res = await fetch(`${backendBase()}/api/collab/embed`, { method: 'POST', body: fd })
  const body = (await res.json().catch(() => ({}))) as { newHash?: string; code?: string; error?: string }
  if (!res.ok || !body.newHash) throw new Error(`embed setup failed: ${res.status} ${JSON.stringify(body)}`)
  return { newHash: body.newHash }
}

/** 호스트 zip에 package 임베딩을 직접 추가 (rels + content-types 포함). */
async function addPackagePart(
  hostAbsPath: string,
  opts: { dir: 'xl' | 'word' | 'ppt'; sheetRels: string; partName: string; bytes: Buffer },
): Promise<void> {
  const z = await JSZip.loadAsync(fs.readFileSync(hostAbsPath))
  const part = `${opts.dir}/embeddings/${opts.partName}`
  z.file(part, opts.bytes)
  const rels = await z.files[opts.sheetRels]!.async('string')
  let max = 0
  for (const m of rels.matchAll(/\bId="rId(\d+)"/g)) max = Math.max(max, Number(m[1]))
  z.file(
    opts.sheetRels,
    rels.replace(
      '</Relationships>',
      `<Relationship Id="rId${max + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/${opts.partName}"/></Relationships>`,
    ),
  )
  const ctName = '[Content_Types].xml'
  let ct = await z.files[ctName]!.async('string')
  const ext = (opts.partName.split('.').pop() ?? '').toLowerCase()
  const mime =
    ext === 'docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
      : ext === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
        : ext === 'pptx'
          ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'
          : ext === 'pdf'
            ? 'application/pdf'
            : 'application/octet-stream'
  const needle = `<Override PartName="/${part}"`
  if (!ct.includes(needle)) {
    ct = ct.replace('</Types>', `<Override PartName="/${part}" ContentType="${mime}"/></Types>`)
    z.file(ctName, ct)
  }
  fs.writeFileSync(hostAbsPath, await z.generateAsync({ type: 'nodebuffer' }))
}

const LONG_DOCX = 'very-long-attachment-file-name-for-ellipsis-check-0123456789-abcdefgh.docx'
const LONG_XLSX = 'very-long-attachment-file-name-for-ellipsis-check-0123456789-abcdefgh.xlsx'

/** 라벨 측정: [data-testid=ole-label][title=name] 기하 + 스타일 */
async function measureLabel(
  page: Page,
  title: string,
): Promise<{ found: boolean; cx?: number; ellipsis?: boolean; userSelect?: string; pointerEvents?: string }> {
  return page.evaluate((t) => {
    const label = [...document.querySelectorAll('[data-testid="ole-label"]')].find(
      (e) => e.getAttribute('title') === (t as string),
    ) as HTMLElement | undefined
    if (!label) return { found: false }
    const r = label.getBoundingClientRect()
    const cs = getComputedStyle(label)
    return {
      found: true,
      cx: r.left + r.width / 2,
      ellipsis: (label as HTMLElement).scrollWidth > (label as HTMLElement).clientWidth + 1,
      userSelect: cs.userSelect,
      pointerEvents: cs.pointerEvents,
    }
  }, title)
}

/** 아이콘 중심: pptx 프레임 / xlsx pic(img alt) / docx span / xlsx unsupported 박스 */
async function iconCenter(
  page: Page,
  kind: 'pptx' | 'xlsx-pic' | 'xlsx-box' | 'docx',
  name: string,
): Promise<{ found: boolean; cx?: number; cy?: number; w?: number; h?: number }> {
  return page.evaluate(
    ([k, n]) => {
      const vis = (e: Element): boolean => {
        const r = (e as HTMLElement).getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const all: Element[] = []
      const walk = (root: ParentNode) => {
        let els: Element[] = []
        try {
          els = [...((root as Element).querySelectorAll?.('*') ?? [])]
        } catch {
          return
        }
        for (const el of els) {
          all.push(el)
          const sr = (el as HTMLElement).shadowRoot
          if (sr) walk(sr)
        }
      }
      walk(document)
      let target: Element | null = null
      if (k === 'pptx') {
        const frames = all.filter(
          (e) => (e.getAttribute?.('data-element-id') ?? '').includes('-frame-') && vis(e),
        )
        // 라벨에 가장 가까운 프레임을 아이콘으로 본다 (앵커된 프레임과 일치).
        const label = [...document.querySelectorAll('[data-testid="ole-label"]')].find(
          (e) => e.getAttribute('title') === (n as string),
        ) as HTMLElement | undefined
        if (frames.length === 1) target = frames[0]!
        else if (label) {
          const lr = label.getBoundingClientRect()
          let best: Element | null = null
          let bestD = Infinity
          for (const f of frames) {
            const r = (f as HTMLElement).getBoundingClientRect()
            const d = Math.hypot(r.left + r.width / 2 - (lr.left + lr.width / 2), r.top - lr.top)
            if (d < bestD) {
              bestD = d
              best = f
            }
          }
          target = best
        } else target = frames[0] ?? null
      } else if (k === 'xlsx-pic') {
        const stem = (n as string).replace(/\.[A-Za-z0-9]{1,8}$/, '')
        target =
          all.find((e) => e.tagName === 'IMG' && (e.getAttribute?.('alt') ?? '') === stem && vis(e)) ?? null
      } else if (k === 'xlsx-box') {
        target =
          all.find(
            (e) => ((e as HTMLElement).className?.toString?.() ?? '').includes('xg-obj-unsupported') && vis(e),
          ) ?? null
      } else {
        const spans = all.filter((e) => {
          try {
            return e.hasAttribute?.('data-docx-ole') && vis(e)
          } catch {
            return false
          }
        })
        // 라벨과 가장 가까운 span (라벨이 없으면 첫 번째)
        const label = [...document.querySelectorAll('[data-testid="ole-label"]')].find(
          (e) => e.getAttribute('title') === (n as string),
        ) as HTMLElement | undefined
        if (spans.length === 1) target = spans[0]!
        else if (label) {
          const lr = label.getBoundingClientRect()
          let best: Element | null = null
          let bestD = Infinity
          for (const s of spans) {
            const r = (s as HTMLElement).getBoundingClientRect()
            const d = Math.hypot(r.left + r.width / 2 - (lr.left + lr.width / 2), r.top - lr.top)
            if (d < bestD) {
              bestD = d
              best = s
            }
          }
          target = best
        } else target = spans[0] ?? null
      }
      if (!target) return { found: false }
      const r = (target as HTMLElement).getBoundingClientRect()
      return { found: true, cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height }
    },
    [kind, name],
  )
}

async function mkCtx(browser: Browser, user: { id: string; name: string; color: string }): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await seedUser(ctx, user)
  return ctx
}

test.describe('C5-3: 첨부 라벨·편집·Word 리본', () => {
  test('E1-pptx: 짧은/긴 이름 라벨이 프레임 중앙에 있다', async ({ browser }) => {
    const ctx = await mkCtx(browser, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const seg = `c53e1pptx-${Date.now().toString(36)}`
    await mkRepo(seg, ['embed-pdf.pptx'])
    try {
      const docxBytes = fs.readFileSync(path.join(FIX, 'embed-docx.docx'))
      await postEmbedFile(seg, 'embed-pdf.pptx', 'Rp.docx', docxBytes)
      await postEmbedFile(seg, 'embed-pdf.pptx', LONG_DOCX, docxBytes)
      await openViaWorkspace(page, 'embed-pdf.pptx', seg)
      for (const name of ['Rp.docx', LONG_DOCX]) {
        await expect
          .poll(async () => (await measureLabel(page, name)).found, { timeout: 15000, intervals: [500] })
          .toBe(true)
        const lab = await measureLabel(page, name)
        if (!lab.found) throw new Error(`label vanished: ${name}`)
        const icon = await iconCenter(page, 'pptx', name)
        expect(icon.found, `${name} icon exists`).toBe(true)
        expect(Math.abs(lab.cx! - icon.cx!), `${name} centered`).toBeLessThanOrEqual(2)
        expect(lab.userSelect, 'select-none').toBe('none')
        expect(lab.pointerEvents, 'no pointer events').toBe('none')
        if (name === LONG_DOCX) {
          expect(lab.ellipsis, 'long name ellipsis').toBe(true)
        }
      }
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('E1-xlsx-pic: 짧은/긴 이름 라벨이 pic 중앙에 있다', async ({ browser }) => {
    const ctx = await mkCtx(browser, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const seg = `c53e1xlsx-${Date.now().toString(36)}`
    await mkRepo(seg, ['embed-pdf.xlsx'])
    try {
      const docxBytes = fs.readFileSync(path.join(FIX, 'embed-docx.docx'))
      await postEmbedFile(seg, 'embed-pdf.xlsx', 'Rp.docx', docxBytes)
      await postEmbedFile(seg, 'embed-pdf.xlsx', LONG_DOCX, docxBytes)
      await openViaWorkspace(page, 'embed-pdf.xlsx', seg)
      for (const name of ['Rp.docx', LONG_DOCX]) {
        await expect
          .poll(async () => (await measureLabel(page, name)).found, { timeout: 15000, intervals: [500] })
          .toBe(true)
        const lab = await measureLabel(page, name)
        if (!lab.found) throw new Error(`label vanished: ${name}`)
        const icon = await iconCenter(page, 'xlsx-pic', name)
        expect(icon.found, `${name} pic exists`).toBe(true)
        expect(Math.abs(lab.cx! - icon.cx!), `${name} centered`).toBeLessThanOrEqual(2)
        if (name === LONG_DOCX) {
          expect(lab.ellipsis, 'long name ellipsis').toBe(true)
        }
      }
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('E1-xlsx-cover-short: sp 카드는 세로 배치이고 영역을 넘지 않는다', async ({ browser }) => {
    const ctx = await mkCtx(browser, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const seg = `c53e1cov-${Date.now().toString(36)}`
    await mkRepo(seg, ['embed-pdf.xlsx'])
    try {
      await openViaWorkspace(page, 'embed-pdf.xlsx', seg)
      // oleObject1.bin → CFB 라벨 payload.pdf
      const cover = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('[data-testid="ole-cover"]')]
        if (cards.length === 0) return { found: false }
        const card = cards[0] as HTMLElement
        const r = card.getBoundingClientRect()
        const cs = getComputedStyle(card)
        const icon = card.querySelector('svg')
        const nameEl = card.querySelector('[data-testid="ole-label"]') as HTMLElement | null
        const ir = icon?.getBoundingClientRect()
        const nr = nameEl?.getBoundingClientRect()
        return {
          found: true,
          w: r.width,
          iconBottom: ir?.bottom,
          nameTop: nr?.top,
          nameTitle: nameEl?.getAttribute('title'),
          userSelect: cs.userSelect,
          pointerEvents: cs.pointerEvents,
        }
      })
      expect(cover.found, 'cover card exists').toBe(true)
      const box = await iconCenter(page, 'xlsx-box', 'oleObject1.bin')
      expect(box.found, 'unsupported box exists').toBe(true)
      // 세로 배치: 아이콘이 위, 이름이 아래
      expect(cover.iconBottom! <= cover.nameTop! + 1, 'icon above name').toBe(true)
      // 원래 영역을 넘지 않는다 (minWidth 강제 없음)
      expect(cover.w!, 'card width <= box width').toBeLessThanOrEqual(box.w! + 2)
      expect(cover.nameTitle, 'full name in title').toBeTruthy()
      expect(cover.userSelect, 'select-none').toBe('none')
      expect(cover.pointerEvents, 'no pointer events').toBe('none')
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('E1-xlsx-cover-long: 긴 이름 카드는 말줄임 + 전체 이름 title', async ({ browser }) => {
    const ctx = await mkCtx(browser, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const seg = `c53e1covl-${Date.now().toString(36)}`
    await mkRepo(seg, ['embed-pdf.xlsx'])
    try {
      const hostAbs = path.join(workspaceDir(), 'repos', seg, 'embed-pdf.xlsx')
      const docxBytes = fs.readFileSync(path.join(FIX, 'embed-docx.docx'))
      await addPackagePart(hostAbs, {
        dir: 'xl',
        sheetRels: 'xl/worksheets/_rels/sheet1.xml.rels',
        partName: LONG_DOCX,
        bytes: docxBytes,
      })
      await openViaWorkspace(page, 'embed-pdf.xlsx', seg)
      await expect
        .poll(async () => (await measureLabel(page, LONG_DOCX)).found, { timeout: 15000, intervals: [500] })
        .toBe(true)
      const lab = await measureLabel(page, LONG_DOCX)
      if (!lab.found) throw new Error('long cover label vanished')
      expect(lab.ellipsis, 'long name ellipsis').toBe(true)
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('E1-docx: 짧은/긴 이름 라벨이 오브젝트 중앙에 있다', async ({ browser }) => {
    const ctx = await mkCtx(browser, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const seg = `c53e1docx-${Date.now().toString(36)}`
    await mkRepo(seg, ['embed-pdf.docx'])
    try {
      const xlsxBytes = fs.readFileSync(path.join(FIX, 'embed-docx.xlsx'))
      await postEmbedFile(seg, 'embed-pdf.docx', 'Sh.xlsx', xlsxBytes)
      await postEmbedFile(seg, 'embed-pdf.docx', LONG_XLSX, xlsxBytes)
      await openViaWorkspace(page, 'embed-pdf.docx', seg)
      for (const name of ['Sh.xlsx', LONG_XLSX]) {
        await expect
          .poll(async () => (await measureLabel(page, name)).found, { timeout: 15000, intervals: [500] })
          .toBe(true)
        const lab = await measureLabel(page, name)
        if (!lab.found) throw new Error(`label vanished: ${name}`)
        const icon = await iconCenter(page, 'docx', name)
        expect(icon.found, `${name} object exists`).toBe(true)
        expect(Math.abs(lab.cx! - icon.cx!), `${name} centered`).toBeLessThanOrEqual(2)
        if (name === LONG_XLSX) {
          expect(lab.ellipsis, 'long name ellipsis').toBe(true)
        }
      }
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('E2-xlsx-edit: docx 첨부 더블클릭 → 편집 → Save, 해당 파트만 교체', async ({ browser }) => {
    const ctx = await mkCtx(browser, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const seg = `c53e2xlsx-${Date.now().toString(36)}`
    await mkRepo(seg, ['collab-features.xlsx'])
    try {
      const hostAbs = path.join(workspaceDir(), 'repos', seg, 'collab-features.xlsx')
      const docxBytes = fs.readFileSync(path.join(FIX, 'embed-docx.docx'))
      await addPackagePart(hostAbs, {
        dir: 'xl',
        sheetRels: 'xl/worksheets/_rels/sheet1.xml.rels',
        partName: 'report.docx',
        bytes: docxBytes,
      })
      await openViaWorkspace(page, 'collab-features.xlsx', seg)
      const before = await backendBytes(seg, 'collab-features.xlsx')
      const icon = page.getByRole('button', { name: '첨부 report.docx', exact: true }).first()
      await icon.waitFor({ timeout: 30000 })
      await icon.dblclick({ timeout: 15000 })
      await page.getByTestId('attach-editor').waitFor({ timeout: 30000 })
      await expect(page.getByTestId('attach-title')).toContainText('collab-features.xlsx › report.docx', {
        timeout: 15000,
      })
      // 편집 모드 직접 진입 (Edit 버튼 없음)
      const stamp = `E2X${Date.now().toString(36)}`
      const pm = await focusAttachEditor(page, 'E2-xlsx-edit')
      await page.keyboard.press('Control+End')
      await page.keyboard.type(stamp, { delay: 30 })
      await expect(pm, 'stamp typed in attachment').toContainText(stamp, { timeout: 15000 })
      await page.getByTestId('attach-save').click({ timeout: 15000 })
      await expect(page.getByText('저장했습니다'), 'attach save toast').toBeAttached({ timeout: 20000 })
      // 부모 zip: 해당 파트만 바뀌고 나머지는 바이트 동일
      // (expect.poll은 값을 반환하지 않으므로 스탬프로 대기 후 명시 재읽기)
      await expect
        .poll(
          async () => {
            try {
              const z = await JSZip.loadAsync(backendBytes(seg, 'collab-features.xlsx'))
              const f = z.files['xl/embeddings/report.docx']
              if (!f) return false
              const inner = await JSZip.loadAsync(await f.async('uint8array'))
              const doc = inner.files['word/document.xml']
              if (!doc) return false
              return (await doc.async('string')).includes(stamp)
            } catch {
              return false
            }
          },
          { timeout: 60000, intervals: [2000] },
        )
        .toBe(true)
      const after = backendBytes(seg, 'collab-features.xlsx')
      const z0 = await JSZip.loadAsync(before)
      const z1 = await JSZip.loadAsync(after as unknown as Buffer)
      const names0 = new Set(Object.keys(z0.files))
      const names1 = new Set(Object.keys(z1.files))
      expect([...names1].sort(), 'same part list').toEqual([...names0].sort())
      let changed = 0
      for (const n of names1) {
        const b0 = Buffer.from(await z0.files[n]!.async('uint8array'))
        const b1 = Buffer.from(await z1.files[n]!.async('uint8array'))
        if (b1.equals(b0)) continue
        changed++
        expect(n, 'only attachment part changes').toBe('xl/embeddings/report.docx')
      }
      expect(changed, 'exactly one part changed').toBe(1)
      const partZip = await JSZip.loadAsync(await z1.files['xl/embeddings/report.docx']!.async('uint8array'))
      const partDoc = await partZip.files['word/document.xml']!.async('string')
      expect(partDoc.includes(stamp), 'stamp in replaced part').toBe(true)
      await page.getByTestId('attach-done').click({ timeout: 15000 })
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('E2-lock: B가 같은 첨부를 열면 읽기 전용 + 토스트 1회', async ({ browser }) => {
    const ctxA = await mkCtx(browser, ADA)
    const ctxB = await mkCtx(browser, GRACE)
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    await gotoApp(pageA)
    await gotoApp(pageB)
    const seg = `c53e2lock-${Date.now().toString(36)}`
    await mkRepo(seg, ['collab-features.xlsx'])
    try {
      const hostAbs = path.join(workspaceDir(), 'repos', seg, 'collab-features.xlsx')
      const docxBytes = fs.readFileSync(path.join(FIX, 'embed-docx.docx'))
      await addPackagePart(hostAbs, {
        dir: 'xl',
        sheetRels: 'xl/worksheets/_rels/sheet1.xml.rels',
        partName: 'report.docx',
        bytes: docxBytes,
      })
      await openViaWorkspace(pageA, 'collab-features.xlsx', seg)
      await pageA.getByRole('button', { name: '첨부 report.docx', exact: true }).first().dblclick({ timeout: 15000 })
      await pageA.getByTestId('attach-editor').waitFor({ timeout: 30000 })
      await openViaWorkspace(pageB, 'collab-features.xlsx', seg)
      await pageB.getByRole('button', { name: '첨부 report.docx', exact: true }).first().dblclick({ timeout: 15000 })
      await pageB.getByTestId('attach-editor').waitFor({ timeout: 30000 })
      await expect(pageB.getByText('Ada님이 편집 중')).toHaveCount(1, { timeout: 15000 })
      await expect(pageB.getByTestId('attach-save')).toBeDisabled({ timeout: 15000 })
      await expect(pageB.getByTestId('attach-readonly')).toBeVisible({ timeout: 15000 })
      // A가 닫으면 B는 다음에 편집 가능 (잠금 해제 확인은 생략 — 해제는 단위 테스트에서 검증)
      await pageA.getByTestId('attach-done').click({ timeout: 15000 })
    } finally {
      await ctxA.close().catch(() => {})
      await ctxB.close().catch(() => {})
    }
  })

  test('E2-unsaved: 부모 방 미저장 편집이 첨부 저장 후에도 유실되지 않는다', async ({ browser }) => {
    const ctxA = await mkCtx(browser, ADA)
    const ctxB = await mkCtx(browser, GRACE)
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    await gotoApp(pageA)
    await gotoApp(pageB)
    const seg = `c53e2unsv-${Date.now().toString(36)}`
    await mkRepo(seg, ['collab-features.xlsx'])
    try {
      const hostAbs = path.join(workspaceDir(), 'repos', seg, 'collab-features.xlsx')
      const docxBytes = fs.readFileSync(path.join(FIX, 'embed-docx.docx'))
      await addPackagePart(hostAbs, {
        dir: 'xl',
        sheetRels: 'xl/worksheets/_rels/sheet1.xml.rels',
        partName: 'report.docx',
        bytes: docxBytes,
      })
      await openViaWorkspace(pageA, 'collab-features.xlsx', seg)
      await openViaWorkspace(pageB, 'collab-features.xlsx', seg)
      // 둘 다 편집 진입 (B가 방 참가자로 붙는다)
      await pageA.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20000 })
      await pageA.getByRole('button', { name: 'Done', exact: true }).waitFor({ timeout: 30000 })
      await pageB.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20000 })
      await pageB.getByRole('button', { name: 'Done', exact: true }).waitFor({ timeout: 30000 })
      // B가 셀 편집 (저장 안 함)
      const stampB = `E2U${Date.now().toString(36)}`
      await pageB.evaluate((ref) => {
        const el = document.querySelector('xlsx-editor') as unknown as { select?: (r: string) => void; focusGrid?: () => void } | null
        el?.select?.(ref)
        el?.focusGrid?.()
      }, 'B2')
      const barB = pageB.locator('xlsx-editor [part~="formula-bar"] textarea').last()
      await barB.waitFor({ timeout: 15000 })
      await barB.click({ timeout: 15000 })
      await barB.fill(stampB)
      await expect(barB, 'stampB in formula bar').toHaveValue(stampB, { timeout: 15000 })
      await barB.press('Enter')
      // A가 첨부를 열어 저장 (방 리셋 발생)
      await pageA.getByRole('button', { name: '첨부 report.docx', exact: true }).first().dblclick({ timeout: 15000 })
      await pageA.getByTestId('attach-editor').waitFor({ timeout: 30000 })
      const stampA = `E2A${Date.now().toString(36)}`
      const pmA = await focusAttachEditor(pageA, 'E2-unsaved')
      await pageA.keyboard.press('Control+End')
      await pageA.keyboard.type(stampA, { delay: 30 })
      await expect(pmA, 'stampA typed in attachment').toContainText(stampA, { timeout: 15000 })
      await pageA.getByTestId('attach-save').click({ timeout: 15000 })
      await expect(pageA.getByText('저장했습니다'), 'attach save toast').toBeAttached({ timeout: 20000 })
      await expect
        .poll(
          async () => {
            try {
              const b = await backendBytes(seg, 'collab-features.xlsx')
              const z = await JSZip.loadAsync(b)
              const f = z.files['xl/embeddings/report.docx']
              if (!f) return false
              const inner = await JSZip.loadAsync(await f.async('uint8array'))
              const doc = inner.files['word/document.xml']
              if (!doc) return false
              return (await doc.async('string')).includes(stampA)
            } catch {
              return false
            }
          },
          { timeout: 60000, intervals: [2000] },
        )
        .toBe(true)
      await pageA.getByTestId('attach-done').click({ timeout: 15000 })
      // B가 저장 → 미저장 편집이 디스크에 남아야 한다
      const saveB = pageB.locator('[data-testid="preview-doc-header"]').getByRole('button', { name: 'Save', exact: true })
      await saveB.click({ timeout: 20000 })
      await expect
        .poll(
          async () => {
            const b = await backendBytes(seg, 'collab-features.xlsx')
            const z = await JSZip.loadAsync(b)
            const names = Object.keys(z.files).filter((n) => n.endsWith('.xml') && !n.endsWith('.rels'))
            for (const n of names) {
              if ((await z.files[n]!.async('string')).includes(stampB)) return true
            }
            return false
          },
          { timeout: 60000, intervals: [2000] },
        )
        .toBe(true)
    } finally {
      await ctxA.close().catch(() => {})
      await ctxB.close().catch(() => {})
    }
  })

  test('E2-pptx-edit: pptx 안의 docx 첨부 편집 → Save', async ({ browser }) => {
    const ctx = await mkCtx(browser, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const seg = `c53e2pptx-${Date.now().toString(36)}`
    await mkRepo(seg, ['collab-3slides.pptx'])
    try {
      const docxBytes = fs.readFileSync(path.join(FIX, 'embed-docx.docx'))
      await postEmbedFile(seg, 'collab-3slides.pptx', 'Rp.docx', docxBytes, { slide: 1 })
      await openViaWorkspace(page, 'collab-3slides.pptx', seg)
      const before = await backendBytes(seg, 'collab-3slides.pptx')
      const icon = page.getByRole('button', { name: '첨부 Rp.docx', exact: true }).first()
      await icon.waitFor({ timeout: 30000 })
      await icon.dblclick({ timeout: 15000 })
      await page.getByTestId('attach-editor').waitFor({ timeout: 30000 })
      await expect(page.getByTestId('attach-title')).toContainText('collab-3slides.pptx › Rp.docx', { timeout: 15000 })
      const stamp = `E2P${Date.now().toString(36)}`
      const pm = await focusAttachEditor(page, 'E2-pptx-edit')
      await page.keyboard.press('Control+End')
      await page.keyboard.type(stamp, { delay: 30 })
      await expect(pm, 'stamp typed in attachment').toContainText(stamp, { timeout: 15000 })
      await page.getByTestId('attach-save').click({ timeout: 15000 })
      await expect(page.getByText('저장했습니다'), 'attach save toast').toBeAttached({ timeout: 20000 })
      await expect
        .poll(
          async () => {
            try {
              const z = await JSZip.loadAsync(backendBytes(seg, 'collab-3slides.pptx'))
              const f = z.files['ppt/embeddings/Rp.docx']
              if (!f) return false
              const inner = await JSZip.loadAsync(await f.async('uint8array'))
              const doc = inner.files['word/document.xml']
              if (!doc) return false
              return (await doc.async('string')).includes(stamp)
            } catch {
              return false
            }
          },
          { timeout: 60000, intervals: [2000] },
        )
        .toBe(true)
      const after = backendBytes(seg, 'collab-3slides.pptx')
      const z0 = await JSZip.loadAsync(before)
      const z1 = await JSZip.loadAsync(after as unknown as Buffer)
      expect([...Object.keys(z1.files)].sort()).toEqual([...Object.keys(z0.files)].sort())
      let changed = 0
      for (const n of Object.keys(z1.files)) {
        const b0 = Buffer.from(await z0.files[n]!.async('uint8array'))
        const b1 = Buffer.from(await z1.files[n]!.async('uint8array'))
        if (b1.equals(b0)) continue
        changed++
        expect(n, 'only attachment part changes').toBe('ppt/embeddings/Rp.docx')
      }
      expect(changed, 'exactly one part changed').toBe(1)
      const part = await JSZip.loadAsync(await z1.files['ppt/embeddings/Rp.docx']!.async('uint8array'))
      const partDoc = await part.files['word/document.xml']!.async('string')
      expect(partDoc.includes(stamp), 'stamp in replaced part').toBe(true)
      await page.getByTestId('attach-done').click({ timeout: 15000 })
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('E2-docx-edit: docx 안의 xlsx 첨부 편집 → Save', async ({ browser }) => {
    const ctx = await mkCtx(browser, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const seg = `c53e2docx-${Date.now().toString(36)}`
    await mkRepo(seg, ['collab-features.docx'])
    try {
      const xlsxBytes = fs.readFileSync(path.join(FIX, 'embed-docx.xlsx'))
      await postEmbedFile(seg, 'collab-features.docx', 'Sh.xlsx', xlsxBytes)
      await openViaWorkspace(page, 'collab-features.docx', seg)
      const before = await backendBytes(seg, 'collab-features.docx')
      const icon = page.getByRole('button', { name: '첨부 Sh.xlsx', exact: true }).first()
      await icon.waitFor({ timeout: 30000 })
      await icon.dblclick({ timeout: 15000 })
      await page.getByTestId('attach-editor').waitFor({ timeout: 30000 })
      await expect(page.getByTestId('attach-title')).toContainText('collab-features.docx › Sh.xlsx', { timeout: 15000 })
      // xlsx 첨부 편집: 수식 바에 입력
      const stamp = `E2D${Date.now().toString(36)}`
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="attach-editor"] xlsx-editor') as unknown as {
          select?: (r: string) => void
          focusGrid?: () => void
        } | null
        el?.select?.('B2')
        el?.focusGrid?.()
      })
      const bar = page.locator('[data-testid="attach-editor"] xlsx-editor [part~="formula-bar"] textarea').last()
      await bar.waitFor({ timeout: 30000 })
      await bar.click({ timeout: 15000 })
      await bar.fill(stamp)
      await expect(bar, 'stamp in formula bar').toHaveValue(stamp, { timeout: 15000 })
      await bar.press('Enter')
      await page.getByTestId('attach-save').click({ timeout: 15000 })
      await expect(page.getByText('저장했습니다'), 'attach save toast').toBeAttached({ timeout: 20000 })
      await expect
        .poll(
          async () => {
            try {
              const z = await JSZip.loadAsync(backendBytes(seg, 'collab-features.docx'))
              const f = z.files['word/embeddings/Sh.xlsx']
              if (!f) return false
              const inner = await JSZip.loadAsync(await f.async('uint8array'))
              const ss = inner.files['xl/sharedStrings.xml']
                ? await inner.files['xl/sharedStrings.xml']!.async('string')
                : ''
              const sh = inner.files['xl/worksheets/sheet1.xml']
                ? await inner.files['xl/worksheets/sheet1.xml']!.async('string')
                : ''
              return (ss + sh).includes(stamp)
            } catch {
              return false
            }
          },
          { timeout: 60000, intervals: [2000] },
        )
        .toBe(true)
      const after = backendBytes(seg, 'collab-features.docx')
      const z0 = await JSZip.loadAsync(before)
      const z1 = await JSZip.loadAsync(after as unknown as Buffer)
      expect([...Object.keys(z0.files)].sort()).toEqual([...Object.keys(z1.files)].sort())
      let changed = 0
      for (const n of Object.keys(z1.files)) {
        const b0 = Buffer.from(await z0.files[n]!.async('uint8array'))
        const b1 = Buffer.from(await z1.files[n]!.async('uint8array'))
        if (b1.equals(b0)) continue
        changed++
        expect(n, 'only attachment part changes').toBe('word/embeddings/Sh.xlsx')
      }
      expect(changed, 'exactly one part changed').toBe(1)
      await page.getByTestId('attach-done').click({ timeout: 15000 })
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('E2-pdf-preview: pdf 첨부 더블클릭은 새 탭 미리보기', async ({ browser }) => {
    const ctx = await mkCtx(browser, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const seg = `c53e2pdf-${Date.now().toString(36)}`
    await mkRepo(seg, ['collab-features.xlsx'])
    try {
      const hostAbs = path.join(workspaceDir(), 'repos', seg, 'collab-features.xlsx')
      const pdfBytes = Buffer.from(
        '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000056 00000 n \n0000000111 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n178\n%%EOF',
      )
      await addPackagePart(hostAbs, {
        dir: 'xl',
        sheetRels: 'xl/worksheets/_rels/sheet1.xml.rels',
        partName: 'note.pdf',
        bytes: pdfBytes,
      })
      await openViaWorkspace(page, 'collab-features.xlsx', seg)
      const icon = page.getByRole('button', { name: '첨부 note.pdf', exact: true }).first()
      await icon.waitFor({ timeout: 30000 })
      // headless-shell에는 PDF 뷰어가 없어 blob 탐색이 다운로드로 바뀐다.
      const dlWaiter = page.waitForEvent('download', { timeout: 25000 }).catch(() => null)
      const [popup] = await Promise.all([
        page.waitForEvent('popup', { timeout: 15000 }),
        icon.dblclick({ timeout: 15000 }),
      ])
      try {
        await expect.poll(() => popup.url(), { timeout: 10000, intervals: [500] }).toMatch(/^blob:/)
      } catch {
        const dl = await dlWaiter
        expect(dl, 'pdf download when no viewer').toBeTruthy()
        expect(await dl!.path(), 'pdf download path').toBeTruthy()
        expect(dl!.suggestedFilename(), 'pdf filename').toMatch(/note\.pdf$/)
      }
      await popup.close().catch(() => {})
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('E2-cfb-download: CFB 첨부 더블클릭은 다운로드', async ({ browser }) => {
    const ctx = await mkCtx(browser, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c53e2cfb', ['embed-pdf.xlsx'])
    try {
      await openViaWorkspace(page, 'embed-pdf.xlsx', 'c53e2cfb')
      const icon = page.getByRole('button', { name: /첨부 .*oleObject1\.bin|첨부 payload\.pdf/, exact: false }).first()
      await icon.waitFor({ timeout: 30000 })
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 20000 }),
        icon.dblclick({ timeout: 15000 }),
      ])
      expect(await dl.path(), 'download path').toBeTruthy()
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('E2-traversal: part 경로 조작 요청은 거부된다', async ({ browser }) => {
    const ctx = await mkCtx(browser, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    await mkRepo('c53e2trav', ['collab-features.xlsx'])
    try {
      const putRes = await fetch(
        `${backendBase()}/api/collab/embed?path=${encodeURIComponent('c53e2trav/collab-features.xlsx')}&part=${encodeURIComponent('../evil.docx')}`,
        {
          method: 'PUT',
          body: (() => {
            const fd = new FormData()
            fd.append('file', new Blob([new Uint8Array([80, 75, 3, 4])]), 'evil.docx')
            fd.append('baseHash', 'x')
            fd.append('lockId', 'nope')
            return fd
          })(),
        },
      )
      expect(putRes.status, 'PUT traversal rejected').toBe(400)
      const putBody = (await putRes.json().catch(() => ({}))) as { code?: string }
      expect(putBody.code, 'bad_part code').toBe('bad_part')
      const getRes = await fetch(
        `${backendBase()}/api/collab/embed?path=${encodeURIComponent('c53e2trav/collab-features.xlsx')}&part=${encodeURIComponent('../evil.docx')}`,
      )
      expect(getRes.status, 'GET traversal rejected').toBe(400)
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('E3-docx-view: 보기 모드 리본 표시, 첨부 탭은 편집 모드에서만', async ({ browser }) => {
    const ctx = await mkCtx(browser, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const seg = `c53e3docx-${Date.now().toString(36)}`
    await mkRepo(seg, ['embed-pdf.docx'])
    try {
      await openViaWorkspace(page, 'embed-pdf.docx', seg)
      const tabs = page.getByRole('tab')
      await expect(tabs.filter({ hasText: /^Insert$/ }).first()).toBeVisible({ timeout: 30000 })
      await tabs.filter({ hasText: /^Insert$/ }).first().click({ timeout: 15000 })
      await page.waitForTimeout(1500)
      // 첨부 탭은 보기 모드에서 없다
      await expect(tabs.filter({ hasText: '첨부' }).first()).toHaveCount(0, { timeout: 5000 })
      // 편집 모드에서는 생긴다
      await page.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20000 })
      await page.getByRole('button', { name: 'Done', exact: true }).waitFor({ timeout: 30000 })
      await expect(tabs.filter({ hasText: '첨부' }).first()).toBeVisible({ timeout: 30000 })
    } finally {
      await ctx.close().catch(() => {})
    }
  })
})
