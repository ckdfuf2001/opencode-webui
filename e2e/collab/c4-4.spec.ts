import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { absForRel, backendBase, uniqueRelWithExt, workspaceDir } from './helpers/env'
import { gotoApp } from './helpers/viewer'
import { ADA, GRACE, seedUser } from './helpers/users'

/**
 * C4-4 red 선행.
 * G1 (C4-6 H2로 대체): 같은 파일을 패널+시트에 열면 시트만 마운트되고
 * 패널은 플레이스홀더로 양보한다. 같은 userId는 1명으로 보여야 한다.
 * G2: 사용자 표시(CollabPresence)는 lib 타이틀바 actions 슬롯(검색창 오른쪽) 한 곳에만.
 *     위쪽(앱 헤더)의 collab-presence는 제거한다. lib 자체 표시는 계속 숨김.
 */

const FRONT = 'http://127.0.0.1:5183'
const FIXTURE_XLSX = path.resolve('e2e/collab/fixtures/collab-features.xlsx')
const FIXTURE_PPTX = path.resolve('e2e/collab/fixtures/collab-3slides.pptx')
const FIXTURE_DOCX = path.resolve('e2e/collab/fixtures/collab-features.docx')

async function apiGet(p: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${backendBase()}${p}`)
  return { status: r.status, json: (await r.json().catch(() => null)) as any }
}

async function roomByLeaf(leaf: string) {
  const r = await apiGet('/api/collab/rooms')
  expect(r.status).toBe(200)
  const list = (r.json as { rooms?: Array<{ roomId?: unknown; rel?: unknown; path?: unknown; participants?: unknown[] }> }).rooms ?? []
  const hit = list.find((x) => typeof x.path === 'string' && x.path.replace(/\\/g, '/').endsWith(`/${leaf}`))
  expect(hit, `room for ${leaf} should exist`).toBeTruthy()
  return hit!
}

async function mkRepoWithFiles(localPath: string, files: Array<{ name: string; fixture: string }>): Promise<{ repoId: number; dir: string }> {
  const mk = await fetch(`${backendBase()}/api/repos`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ localPath }),
  }).then((r) => r.json())
  const repoId = (mk as any)?.id as number
  expect(repoId, 'repo created').toBeTruthy()
  const dir = path.join(workspaceDir(), 'repos', localPath)
  fs.mkdirSync(dir, { recursive: true })
  for (const f of files) fs.copyFileSync(f.fixture, path.join(dir, f.name))
  return { repoId, dir }
}

/** RepoDetail 패널에서 파일 열기 (viewer 마운트 1). */
async function openInPanel(page: Page, repoId: number, name: string, hostSelector: string): Promise<void> {
  await page.goto(`${FRONT}/repos/${repoId}?collabDebug=1&e2e=1`)
  await page.getByTitle('Files', { exact: true }).click({ timeout: 20000 })
  await page.locator('[data-testid="file-row"]').first().waitFor({ timeout: 90000 })
  // 콜드 시작 시 클릭이 씹히거나 프리뷰 로드가 느릴 수 있어 재시도한다.
  let opened = false
  for (let attempt = 0; attempt < 3 && !opened; attempt++) {
    await page.locator(`[data-testid="file-row"][data-path$="${name}"]`).locator('span', { hasText: name }).first().click({ timeout: 20000 }).catch(() => {})
    opened = await page.waitForSelector(hostSelector, { timeout: 30000 }).then(() => true).catch(() => false)
  }
  expect(opened, `panel preview for ${name} should mount`).toBe(true)
}

/** 시트(FileBrowserSheet) 안에서 같은 파일 열기 (C4-6 H2: 패널은 양보하고 시트만 마운트). */
async function openInSheet(page: Page, name: string, hostSelector: string, hostCount: number): Promise<void> {
  const sheet = page.locator('div.fixed.inset-0.z-50')
  await page.getByTitle('Open fullscreen', { exact: true }).first().click({ timeout: 20000 })
  await sheet.locator('[data-testid="file-row"]').first().waitFor({ timeout: 90000 })
  await sheet.locator(`[data-testid="file-row"][data-path$="${name}"]`).locator('span', { hasText: name }).first().click({ timeout: 20000 })
  // C4-6 H2: 시트가 같은 파일을 열면 패널이 플레이스홀더로 양보하므로
  // hosts>=2가 안정 상태가 아니다. 시트에 호스트가 뜨거나 양보가 끝났으면 성공.
  await page.waitForFunction(() => {
    const sheetEl = document.querySelector('div.fixed.inset-0.z-50')
    const sheetHosts = sheetEl ? sheetEl.querySelectorAll('.xlsxengine-host, [data-testid="pptx-viewer-root"]').length : 0
    if (sheetHosts >= 1) return true
    const shadowed = document.querySelectorAll('[data-testid="preview-shadowed"]').length
    const hosts = document.querySelectorAll('.xlsxengine-host, [data-testid="pptx-viewer-root"]').length
    return shadowed >= 1 && hosts >= 1
  }, null, { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(6000)
}

async function closeSheet(page: Page): Promise<void> {
  const sheet = page.locator('div.fixed.inset-0.z-50')
  await sheet.getByLabel('Close explorer').click({ timeout: 20000 }).catch(() => {})
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(4000)
}

/** presence 바별 아바타 수 (바 순서대로). */
async function avatarsPerBar(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const bars: number[] = []
    const pushBar = (root: Element | ShadowRoot | Document) => {
      for (const b of root.querySelectorAll('[data-testid="collab-presence"]')) {
        bars.push(b.querySelectorAll('[data-testid="collab-peer"]').length)
      }
    }
    pushBar(document)
    for (const tag of ['xlsx-editor', 'docx-editor']) {
      for (const el of document.querySelectorAll(tag)) {
        const sr = (el as unknown as { shadowRoot?: ShadowRoot | null }).shadowRoot
        if (sr) pushBar(sr)
      }
    }
    return bars
  })
}

test.describe('C4-4 G1: 미리보기+큰 화면 중복 접속', () => {
  test('G1-panel-sheet-xlsx: 같은 파일은 시트만 마운트, 아바타 1개·참가자 1명', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const { repoId } = await mkRepoWithFiles('g1a', [{ name: 'm.xlsx', fixture: FIXTURE_XLSX }])
    try {
      await openInPanel(page, repoId, 'm.xlsx', '.xlsxengine-host')
      // presence는 collab 참가+타이틀바 슬롯 장착 뒤에 나타나므로 폴링한다.
      await expect.poll(async () => avatarsPerBar(page), { timeout: 30000, intervals: [500] }).toEqual([1])
      await openInSheet(page, 'm.xlsx', '.xlsxengine-host', 2)
      // C4-6 H2: 패널은 플레이스홀더로 양보하고 시트만 마운트된다.
      await expect(page.getByTestId('preview-shadowed').first()).toBeVisible({ timeout: 15000 })
      expect(await page.locator('xlsx-editor').count()).toBe(1)
      // 바 1개(시트), 아바타 1개.
      expect(await avatarsPerBar(page)).toEqual([1])
      // 팝오버에 단일 항목만 있고 탭 표시 없음 (마운트 1).
      await page.getByTestId('collab-avatars').last().click({ timeout: 10000 })
      await expect(page.getByTestId('collab-popover').last()).toBeVisible({ timeout: 10000 })
      await expect(page.getByTestId('collab-popover').last()).not.toContainText('탭 2', { timeout: 10000 })
      await page.keyboard.press('Escape')
      // 서버 참가자는 같은 userId 1명.
      const room = await roomByLeaf('m.xlsx')
      const parts = (room.participants ?? []) as Array<{ userId?: unknown }>
      expect(parts.length).toBe(1)
      expect(parts[0]?.userId).toBeTruthy()
      // 시트 닫기 → 패널 뷰어 복귀, 유령 없음.
      await closeSheet(page)
      await expect.poll(async () => page.locator('.xlsxengine-host').count(), { timeout: 20000, intervals: [500] }).toBe(1)
      await expect(page.getByTestId('preview-shadowed')).toHaveCount(0, { timeout: 10000 })
      expect(await avatarsPerBar(page)).toEqual([1])
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('G1-panel-sheet-pptx: 같은 파일은 시트만 마운트, 아바타 1개·참가자 1명', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const { repoId } = await mkRepoWithFiles('g1b', [{ name: 's.pptx', fixture: FIXTURE_PPTX }])
    try {
      await openInPanel(page, repoId, 's.pptx', '[data-testid="pptx-viewer-root"]')
      await expect.poll(async () => avatarsPerBar(page), { timeout: 30000, intervals: [500] }).toEqual([1])
      await openInSheet(page, 's.pptx', '[data-testid="pptx-viewer-root"]', 2)
      // C4-6 H2: 패널은 플레이스홀더로 양보하고 시트만 마운트된다.
      await expect(page.getByTestId('preview-shadowed').first()).toBeVisible({ timeout: 15000 })
      expect(await page.locator('[data-testid="pptx-viewer-root"]').count()).toBe(1)
      expect(await avatarsPerBar(page)).toEqual([1])
      // PPT는 단일 마운트라 팝오버에 단일 항목만 있고 탭 표시 없음.
      await page.getByTestId('collab-avatars').last().click({ timeout: 10000 })
      await expect(page.getByTestId('collab-popover').last()).toBeVisible({ timeout: 10000 })
      await expect(page.getByTestId('collab-popover').last()).not.toContainText('탭 2', { timeout: 10000 })
      await page.keyboard.press('Escape')
      const room = await roomByLeaf('s.pptx')
      const parts = (room.participants ?? []) as Array<{ userId?: unknown }>
      expect(parts.length).toBe(1)
      await closeSheet(page)
      await expect.poll(async () => page.locator('[data-testid="pptx-viewer-root"]').count(), { timeout: 20000, intervals: [500] }).toBe(1)
      await expect(page.getByTestId('preview-shadowed')).toHaveCount(0, { timeout: 10000 })
      expect(await avatarsPerBar(page)).toEqual([1])
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('G1-pptx-twotabs: 같은 userId 2탭도 아바타 1개', async ({ browser }) => {
    const mk = async () => {
      const c = await browser.newContext({ viewport: { width: 1400, height: 900 } })
      await seedUser(c, ADA)
      const p = await c.newPage()
      await gotoApp(p)
      return { ctx: c, page: p }
    }
    const t = { a: await mk(), b: await mk() }
    const rel = uniqueRelWithExt('c44g1p', 0, '.pptx')
    const abs = absForRel(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.copyFileSync(FIXTURE_PPTX, abs)
    const name = rel.split('/').pop()!
    const openPptx = async (page: Page) => {
      for (let i = 0; i < 6; i++) {
        try { await page.getByTitle('Workspace').waitFor({ timeout: 12000 }); break }
        catch { await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}) }
      }
      await page.getByTitle('Workspace').click({ timeout: 20000 })
      await expect.poll(async () => page.locator('[data-testid="file-row"]').count(), { timeout: 15000, intervals: [200] }).toBeGreaterThan(0)
      for (let i = 0; i < 8; i++) {
        const has = await page.evaluate(
          (n) => [...document.querySelectorAll('[data-testid="file-row"]')].some((r) => (r.textContent || '').includes(n)),
          name,
        )
        if (has) break
        const folder = page.locator('[data-testid="file-row"][data-path$="collab-e2e"]')
        if ((await folder.count()) > 0) {
          await folder.locator('div.flex-1').first().click({ timeout: 10000 }).catch(() => {})
        }
        await page.waitForTimeout(1500)
      }
      await expect.poll(async () => page.locator('[data-testid="file-row"]').count(), { timeout: 15000, intervals: [200] }).toBeGreaterThan(0)
      await page.locator(`[data-testid="file-row"][data-path$="${name}"]`).locator('span', { hasText: name }).first().click({ timeout: 20000 })
      await page.getByTestId('pptx-viewer-root').waitFor({ timeout: 30000 })
    }
    try {
      await openPptx(t.a.page)
      await openPptx(t.b.page)
      await t.a.page.waitForTimeout(6000)
      // 각 탭 바에 아바타 1개 (같은 userId 묶음).
      expect(await avatarsPerBar(t.a.page)).toEqual([1])
      expect(await avatarsPerBar(t.b.page)).toEqual([1])
    } finally {
      await t.b.ctx.close().catch(() => {})
      await t.a.ctx.close().catch(() => {})
    }
  })

  test('G1-sheet-close-unlock: 시트에서 락 잡고 닫으면 서버 락 해제', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const { repoId } = await mkRepoWithFiles('g1c', [{ name: 'm.xlsx', fixture: FIXTURE_XLSX }])
    try {
      await openInPanel(page, repoId, 'm.xlsx', '.xlsxengine-host')
      await page.waitForTimeout(3000)
      // 시트에서 같은 파일 열기 → 시트 쪽에서 Edit 진입.
      await page.getByTitle('Open fullscreen', { exact: true }).first().click({ timeout: 20000 })
      const sheet = page.locator('div.fixed.inset-0.z-50')
      await sheet.locator('[data-testid="file-row"]').first().waitFor({ timeout: 90000 })
      await sheet.locator('[data-testid="file-row"][data-path$="m.xlsx"]').locator('span', { hasText: 'm.xlsx' }).first().click({ timeout: 20000 })
      await page.waitForFunction(() => document.querySelectorAll('.xlsxengine-host').length >= 2, null, { timeout: 30000 }).catch(() => {})
      await page.waitForTimeout(4000)
      // 시트 쪽 Edit 버튼으로 편집 진입.
      const sheetScope = page.locator('div.fixed.inset-0.z-50')
      await sheetScope.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20000 })
      await page.waitForTimeout(3000)
      // 첫 이미지 pointerdown → 락.
      const locked = await page.evaluate(() => {
        const eds = [...document.querySelectorAll('xlsx-editor')] as any[]
        const target = eds[eds.length - 1]
        const root = target?.shadowRoot ?? document
        const node = root.querySelector('.xg-obj[data-index="1"]')
        if (!node) return 'no-target'
        node.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
        return 'dispatched'
      })
      expect(locked).toBe('dispatched')
      const room = await roomByLeaf('m.xlsx')
      const roomId = room.roomId as string
      await expect.poll(async () => {
        const st = await apiGet(`/api/collab/${roomId}/objects`)
        return (st.json.objects ?? []).some((o: any) => o.lock != null) ? 1 : 0
      }, { timeout: 15000, intervals: [500] }).toBe(1)
      // 시트 닫기 → 락 해제.
      await closeSheet(page)
      await expect.poll(async () => {
        const st = await apiGet(`/api/collab/${roomId}/objects`)
        return (st.json.objects ?? []).some((o: any) => o.lock != null) ? 1 : 0
      }, { timeout: 15000, intervals: [500] }).toBe(0)
    } finally {
      await ctx.close().catch(() => {})
    }
  })
})

test.describe('C4-4 G2: 사용자 표시는 타이틀바 슬롯 한 곳', () => {
  test('G2-pptx-titlebar: presence는 타이틀바에 1개, 앱 헤더에 0개', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const rel = uniqueRelWithExt('c44g2p', 0, '.pptx')
    const abs = absForRel(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.copyFileSync(FIXTURE_PPTX, abs)
    const name = rel.split('/').pop()!
    try {
      await page.getByTitle('Workspace').click({ timeout: 20000 })
      await expect.poll(async () => page.locator('[data-testid="file-row"]').count(), { timeout: 15000, intervals: [200] }).toBeGreaterThan(0)
      for (let i = 0; i < 8; i++) {
        const has = await page.evaluate(
          (n) => [...document.querySelectorAll('[data-testid="file-row"]')].some((r) => (r.textContent || '').includes(n)),
          name,
        )
        if (has) break
        const folder = page.locator('[data-testid="file-row"][data-path$="collab-e2e"]')
        if ((await folder.count()) > 0) {
          await folder.locator('div.flex-1').first().click({ timeout: 10000 }).catch(() => {})
        }
        await page.waitForTimeout(1500)
      }
      await expect.poll(async () => page.locator('[data-testid="file-row"]').count(), { timeout: 15000, intervals: [200] }).toBeGreaterThan(0)
      await page.locator(`[data-testid="file-row"][data-path$="${name}"]`).locator('span', { hasText: name }).first().click({ timeout: 20000 })
      await page.getByTestId('pptx-viewer-root').waitFor({ timeout: 30000 })
      await page.waitForTimeout(4000)
      // lib 타이틀바(actions 슬롯)는 편집 모드에만 렌더된다.
      await page.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20000 })
      await page.waitForTimeout(4000)
      const loc = await page.evaluate(() => {
        const all = [...document.querySelectorAll('[data-testid="collab-presence"]')]
        const inTitleSlot = [...document.querySelectorAll('[slot="actions"] [data-testid="collab-presence"]')]
        return { all: all.length, inTitleSlot: inTitleSlot.length }
      })
      expect(loc.inTitleSlot, 'presence in titlebar actions slot').toBe(1)
      expect(loc.all, 'presence only in titlebar').toBe(1)
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('G2-xlsx-titlebar: presence는 타이틀바에 1개, 앱 헤더에 0개', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const rel = uniqueRelWithExt('c44g2x', 0, '.xlsx')
    const abs = absForRel(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.copyFileSync(FIXTURE_XLSX, abs)
    const name = rel.split('/').pop()!
    try {
      await page.getByTitle('Workspace').click({ timeout: 20000 })
      await expect.poll(async () => page.locator('[data-testid="file-row"]').count(), { timeout: 15000, intervals: [200] }).toBeGreaterThan(0)
      for (let i = 0; i < 8; i++) {
        const has = await page.evaluate(
          (n) => [...document.querySelectorAll('[data-testid="file-row"]')].some((r) => (r.textContent || '').includes(n)),
          name,
        )
        if (has) break
        const folder = page.locator('[data-testid="file-row"][data-path$="collab-e2e"]')
        if ((await folder.count()) > 0) {
          await folder.locator('div.flex-1').first().click({ timeout: 10000 }).catch(() => {})
        }
        await page.waitForTimeout(1500)
      }
      await expect.poll(async () => page.locator('[data-testid="file-row"]').count(), { timeout: 15000, intervals: [200] }).toBeGreaterThan(0)
      await page.locator(`[data-testid="file-row"][data-path$="${name}"]`).locator('span', { hasText: name }).first().click({ timeout: 20000 })
      await page.waitForSelector('.xlsxengine-host', { timeout: 30000 })
      await page.waitForTimeout(4000)
      const loc = await page.evaluate(() => {
        const els = [...document.querySelectorAll('xlsx-editor')] as any[]
        let inTitle = 0
        for (const el of els) {
          const tb = el.shadowRoot?.querySelector('office-ui-title-bar, .xve-titlebar')
          if (tb && tb.querySelector('[data-testid="collab-presence"]')) inTitle += 1
        }
        const all = [...document.querySelectorAll('[data-testid="collab-presence"]')].length
        return { inTitle }
      })
      expect(loc.inTitle, 'presence in xlsx titlebar').toBe(1)
      // document.querySelectorAll은 shadow DOM을 못 뚫으므로 전체 개수는 piercing locator로 센다.
      expect(await page.locator('[data-testid="collab-presence"]').count(), 'presence only in titlebar').toBe(1)
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('G2-docx-titlebar: presence는 타이틀바에 1개, 앱 헤더에 0개(빈 표시 없음)', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const rel = uniqueRelWithExt('c44g2d', 0, '.docx')
    const abs = absForRel(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.copyFileSync(FIXTURE_DOCX, abs)
    const name = rel.split('/').pop()!
    try {
      await page.getByTitle('Workspace').click({ timeout: 20000 })
      await expect.poll(async () => page.locator('[data-testid="file-row"]').count(), { timeout: 15000, intervals: [200] }).toBeGreaterThan(0)
      for (let i = 0; i < 8; i++) {
        const has = await page.evaluate(
          (n) => [...document.querySelectorAll('[data-testid="file-row"]')].some((r) => (r.textContent || '').includes(n)),
          name,
        )
        if (has) break
        const folder = page.locator('[data-testid="file-row"][data-path$="collab-e2e"]')
        if ((await folder.count()) > 0) {
          await folder.locator('div.flex-1').first().click({ timeout: 10000 }).catch(() => {})
        }
        await page.waitForTimeout(1500)
      }
      await expect.poll(async () => page.locator('[data-testid="file-row"]').count(), { timeout: 15000, intervals: [200] }).toBeGreaterThan(0)
      await page.locator(`[data-testid="file-row"][data-path$="${name}"]`).locator('span', { hasText: name }).first().click({ timeout: 20000 })
      await page.waitForSelector('.docxengine-host', { timeout: 30000 })
      await page.waitForTimeout(4000)
      const loc = await page.evaluate(() => {
        const eds = [...document.querySelectorAll('docx-editor')] as any[]
        let inTitle = 0
        for (const el of eds) {
          const tb = el.shadowRoot?.querySelector('office-ui-title-bar, .dve-titlebar')
          if (tb && tb.querySelector('[data-testid="collab-presence"]')) inTitle += 1
        }
        const all = [...document.querySelectorAll('[data-testid="collab-presence"]')].length
        const peers = [...document.querySelectorAll('[data-testid="collab-peer"]')].length
        return { inTitle }
      })
      expect(loc.inTitle, 'presence shell in docx titlebar').toBe(1)
      expect(await page.locator('[data-testid="collab-presence"]').count(), 'presence only in titlebar').toBe(1)
      expect(await page.locator('[data-testid="collab-peer"]').count(), 'no peers shown without collab').toBe(0)
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('G2-rename-titlebar: 타이틀바에서 이름 변경 → 상대 화면 반영', async ({ browser }) => {
    const mk = async (user: { id: string; name: string; color: string }) => {
      const c = await browser.newContext({ viewport: { width: 1400, height: 900 } })
      await seedUser(c, user)
      const p = await c.newPage()
      await gotoApp(p)
      return { ctx: c, page: p }
    }
    const { GRACE } = await import('./helpers/users')
    const tA = await mk(ADA)
    const tB = await mk(GRACE)
    const rel = uniqueRelWithExt('c44g2r', 0, '.pptx')
    const abs = absForRel(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.copyFileSync(FIXTURE_PPTX, abs)
    const name = rel.split('/').pop()!
    const openPptx = async (page: Page) => {
      await page.getByTitle('Workspace').click({ timeout: 20000 })
      await expect.poll(async () => page.locator('[data-testid="file-row"]').count(), { timeout: 15000, intervals: [200] }).toBeGreaterThan(0)
      for (let i = 0; i < 8; i++) {
        const has = await page.evaluate(
          (n) => [...document.querySelectorAll('[data-testid="file-row"]')].some((r) => (r.textContent || '').includes(n)),
          name,
        )
        if (has) break
        const folder = page.locator('[data-testid="file-row"][data-path$="collab-e2e"]')
        if ((await folder.count()) > 0) {
          await folder.locator('div.flex-1').first().click({ timeout: 10000 }).catch(() => {})
        }
        await page.waitForTimeout(1500)
      }
      await expect.poll(async () => page.locator('[data-testid="file-row"]').count(), { timeout: 15000, intervals: [200] }).toBeGreaterThan(0)
      await page.locator(`[data-testid="file-row"][data-path$="${name}"]`).locator('span', { hasText: name }).first().click({ timeout: 20000 })
      await page.getByTestId('pptx-viewer-root').waitFor({ timeout: 30000 })
    }
    try {
      await openPptx(tA.page)
      await openPptx(tB.page)
      await tA.page.waitForTimeout(5000)
      // lib 타이틀바는 편집 모드에만 렌더된다.
      await tA.page.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20000 })
      await tA.page.waitForTimeout(3000)
      // A가 타이틀바 presence에서 이름 변경.
      const slotAvatars = tA.page.locator('[slot="actions"] [data-testid="collab-avatars"]')
      await slotAvatars.first().click({ timeout: 15000 })
      await tA.page.getByTestId('collab-rename-edit').first().click({ timeout: 10000 })
      await tA.page.getByTestId('collab-rename-input').first().fill('AdaTitle')
      await tA.page.getByTestId('collab-rename-submit').first().click({ timeout: 10000 })
      // B 화면에 반영 (B는 보기 모드 헤더 presence — 팝업인을 열어 확인).
      await tB.page.getByTestId('collab-avatars').first().click({ timeout: 10000 })
      await expect(tB.page.getByTestId('collab-popover').first()).toBeVisible({ timeout: 10000 })
      await expect.poll(async () => tB.page.getByTestId('collab-peer-name').allInnerTexts(), { timeout: 20000, intervals: [500] }).toContain('AdaTitle')
    } finally {
      await tB.ctx.close().catch(() => {})
      await tA.ctx.close().catch(() => {})
    }
  })

  test('G2-fullscreen-u3: 전체화면 편집에서도 타이틀바 presence 보임', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const rel = uniqueRelWithExt('c44g2f', 0, '.xlsx')
    const abs = absForRel(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.copyFileSync(FIXTURE_XLSX, abs)
    const name = rel.split('/').pop()!
    try {
      await page.getByTitle('Workspace').click({ timeout: 20000 })
      await expect.poll(async () => page.locator('[data-testid="file-row"]').count(), { timeout: 15000, intervals: [200] }).toBeGreaterThan(0)
      for (let i = 0; i < 8; i++) {
        const has = await page.evaluate(
          (n) => [...document.querySelectorAll('[data-testid="file-row"]')].some((r) => (r.textContent || '').includes(n)),
          name,
        )
        if (has) break
        const folder = page.locator('[data-testid="file-row"][data-path$="collab-e2e"]')
        if ((await folder.count()) > 0) {
          await folder.locator('div.flex-1').first().click({ timeout: 10000 }).catch(() => {})
        }
        await page.waitForTimeout(1500)
      }
      await expect.poll(async () => page.locator('[data-testid="file-row"]').count(), { timeout: 15000, intervals: [200] }).toBeGreaterThan(0)
      await page.locator(`[data-testid="file-row"][data-path$="${name}"]`).locator('span', { hasText: name }).first().click({ timeout: 20000 })
      await page.waitForSelector('.xlsxengine-host', { timeout: 30000 })
      await page.waitForTimeout(3000)
      // 전체화면 진입 (미리보기 우측 상단).
      await page.getByTitle('Enter fullscreen', { exact: true }).first().click({ timeout: 20000 })
      await page.waitForTimeout(2000)
      const loc = await page.evaluate(() => {
        const els = [...document.querySelectorAll('xlsx-editor')] as any[]
        let inTitle = 0
        for (const el of els) {
          const tb = el.shadowRoot?.querySelector('office-ui-title-bar, .xve-titlebar')
          if (tb && tb.querySelector('[data-testid="collab-presence"]')) inTitle += 1
        }
        return { inTitle, fs: document.querySelectorAll('[data-testid="preview-fullscreen-root"]').length }
      })
      expect(loc.fs, 'fullscreen root').toBe(1)
      expect(loc.inTitle, 'presence in titlebar while fullscreen').toBe(1)
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('G2-no-dup-collapse: 탐색기 접기/펼치기 후에도 바별 1개', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const mk = await fetch(`${backendBase()}/api/repos`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ localPath: 'g1d' }),
    }).then((r) => r.json())
    const repoId = (mk as any)?.id as number
    const dir = path.join(workspaceDir(), 'repos', 'g1d')
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(FIXTURE_XLSX, path.join(dir, 'm.xlsx'))
    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true })
    try {
      await page.goto(`${FRONT}/repos/${repoId}?collabDebug=1&e2e=1`)
      await page.getByTitle('Files', { exact: true }).click({ timeout: 20000 })
      await page.locator('[data-testid="file-row"]').first().waitFor({ timeout: 90000 })
      await page.locator('[data-testid="file-row"][data-path$="m.xlsx"]').locator('span', { hasText: 'm.xlsx' }).first().click({ timeout: 20000 })
      await page.waitForSelector('.xlsxengine-host', { timeout: 30000 })
      await expect.poll(async () => avatarsPerBar(page), { timeout: 30000, intervals: [500] }).toEqual([1])
      // 탐색기 닫기 (Close explorer) → 패널 언마운트.
      await page.getByLabel('Close explorer').first().click({ timeout: 20000 }).catch(() => {})
      await page.waitForTimeout(3000)
      // 다시 열기.
      await page.getByTitle('Files', { exact: true }).click({ timeout: 20000 })
      await page.locator('[data-testid="file-row"]').first().waitFor({ timeout: 90000 })
      await page.locator('[data-testid="file-row"][data-path$="m.xlsx"]').locator('span', { hasText: 'm.xlsx' }).first().click({ timeout: 20000 })
      await page.waitForSelector('.xlsxengine-host', { timeout: 30000 })
      await page.waitForTimeout(5000)
      expect(await avatarsPerBar(page)).toEqual([1])
    } finally {
      await ctx.close().catch(() => {})
    }
  })
})
