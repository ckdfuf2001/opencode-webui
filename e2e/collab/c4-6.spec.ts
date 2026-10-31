import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { absForRel, backendBase, uniqueRelWithExt, workspaceDir } from './helpers/env'
import { gotoApp } from './helpers/viewer'
import { ADA, GRACE, seedUser } from './helpers/users'

const FIXTURE_XLSX = path.resolve('e2e/collab/fixtures/collab-features.xlsx')
const FRONT = 'http://127.0.0.1:5183'

/**
 * C4-6: 한 탭 편집기 하나 + 보기 세션 셀 미게시 + 정리. red 선행.
 * - H1: Edit을 누르면 그 화면이 전체화면+편집 모드가 된다 (다른 화면은 안 켜짐).
 * - H2: 미리보기+큰 화면에 같은 파일이면 한쪽만 마운트된다 (placeholder + remount).
 * - H3: 보기 모드 셀 선택은 상대 화면에 박스로 보이지 않는다.
 * - H4: 반복 편집해도 WS/참가자/슬롯 래퍼가 늘지 않는다.
 */

async function apiGet(p: string) {
  const r = await fetch(`${backendBase()}${p}`)
  return r.json()
}

async function mkRepoWithFiles(localPath: string, files: Array<{ name: string; fixture: string }>) {
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

async function openInPanel(page: Page, repoId: number, name: string, hostSelector: string): Promise<void> {
  await page.goto(`${FRONT}/repos/${repoId}?collabDebug=1&e2e=1`)
  await page.getByTitle('Files', { exact: true }).click({ timeout: 20000 })
  await page.locator('[data-testid="file-row"]').first().waitFor({ timeout: 90000 })
  let opened = false
  for (let attempt = 0; attempt < 3 && !opened; attempt++) {
    await page.locator(`[data-testid="file-row"][data-path$="${name}"]`).locator('span', { hasText: name }).first().click({ timeout: 20000 }).catch(() => {})
    opened = await page.waitForSelector(hostSelector, { timeout: 30000 }).then(() => true).catch(() => false)
  }
  expect(opened, `panel preview for ${name} should mount`).toBe(true)
}

async function openInSheet(page: Page, name: string, _hostSelector: string, _hostCount: number): Promise<void> {
  const sheet = page.locator('div.fixed.inset-0.z-50')
  await page.getByTitle('Open fullscreen', { exact: true }).first().click({ timeout: 20000 })
  await sheet.locator('[data-testid="file-row"]').first().waitFor({ timeout: 90000 })
  let opened = false
  for (let attempt = 0; attempt < 3 && !opened; attempt++) {
    await sheet.locator(`[data-testid="file-row"][data-path$="${name}"]`).locator('span', { hasText: name }).first().click({ timeout: 20000 }).catch(() => {})
    // C4-6 H2: 시트가 같은 파일을 열면 패널이 플레이스홀더로 양보하므로
    // hosts>=2가 안정 상태가 아니다. 시트에 호스트가 뜨거나 양보가 끝났으면 성공.
    opened = await page.waitForFunction(() => {
      const sheetEl = document.querySelector('div.fixed.inset-0.z-50')
      const sheetHosts = sheetEl ? sheetEl.querySelectorAll('.xlsxengine-host, [data-testid="pptx-viewer-root"]').length : 0
      if (sheetHosts >= 1) return true
      const shadowed = document.querySelectorAll('[data-testid="preview-shadowed"]').length
      const hosts = document.querySelectorAll('.xlsxengine-host, [data-testid="pptx-viewer-root"]').length
      return shadowed >= 1 && hosts >= 1
    }, null, { timeout: 30000 }).then(() => true).catch(() => false)
  }
  expect(opened, `sheet preview for ${name} should mount`).toBe(true)
  await page.waitForTimeout(3000)
}

async function closeSheet(page: Page): Promise<void> {
  const sheet = page.locator('div.fixed.inset-0.z-50')
  await sheet.getByLabel('Close explorer').click({ timeout: 20000 }).catch(() => {})
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(4000)
}

function roomBySuffix(rooms: any, suffix: string) {
  const list = (rooms.rooms ?? []) as Array<{ roomId?: unknown; path?: unknown; participants?: unknown[] }>
  const hit = list.find((x) => typeof x.path === 'string' && x.path.replace(/\\/g, '/').endsWith(suffix))
  expect(hit, `room for ${suffix} should exist`).toBeTruthy()
  return hit!
}

async function xlsxEditors(page: Page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll('xlsx-editor')].map((el) => {
      const st = (el as unknown as { collaborationState?: { active?: boolean; people?: Array<{ clientId?: unknown; userId?: unknown; self?: boolean; role?: unknown; range?: unknown }> } }).collaborationState
      const root = (el as unknown as { shadowRoot?: ShadowRoot | null }).shadowRoot ?? document
      return {
        readOnly: (el as unknown as { readOnly?: boolean }).readOnly ?? null,
        people: (st?.people ?? []).map((p) => ({ cid: p.clientId, uid: p.userId ?? null, self: !!p.self, role: p.role ?? null, range: (p as { range?: unknown }).range ?? null })),
      }
    })
  })
}

/** 특정 clientId의 보이는 원격 셀 박스 수 (모든 에디터 합산). */
async function visibleRemoteCount(page: Page, cid: number): Promise<number> {
  return page.evaluate((c: number) => {
    let n = 0
    for (const el of document.querySelectorAll('xlsx-editor')) {
      const root = (el as unknown as { shadowRoot?: ShadowRoot | null }).shadowRoot ?? document
      for (const b of root.querySelectorAll('.xg-remote')) {
        const be = b as HTMLElement
        if (be.hidden) continue
        if ((be as unknown as { dataset?: { clientId?: string } }).dataset?.clientId !== String(c)) continue
        const r = be.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) n += 1
      }
    }
    return n
  }, cid)
}

test.describe('C4-6 H1: Edit을 누르면 그 화면이 편집 모드로', () => {
  test('H1-panel-edit: 패널 Edit → 전체화면+편집, 편집기 1개', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const { repoId } = await mkRepoWithFiles('g6h1a', [{ name: 'm.xlsx', fixture: FIXTURE_XLSX }])
    try {
      await openInPanel(page, repoId, 'm.xlsx', '.xlsxengine-host')
      const t0 = Date.now()
      await page.getByRole('button', { name: 'Edit', exact: true }).first().click({ timeout: 20000 })
      // 5초 안에 편집 가능 상태가 된다.
      await expect.poll(async () => {
        const eds = await xlsxEditors(page)
        return eds.length === 1 && eds[0]!.readOnly === false ? 'editing' : 'wait'
      }, { timeout: 30000, intervals: [500] }).toBe('editing')
      const elapsed = Date.now() - t0
      console.log(`DBG_H1_EDIT_MS ${elapsed}`)
      // 미리보기 편집기는 0개 (같은 게 편집기로 전환됐으므로 전체 에디터 1개).
      const eds = await xlsxEditors(page)
      expect(eds.length).toBe(1)
      // 셀 입력이 실제로 먹는다: 빈 곳 클릭 → 선택이 바뀐다.
      const box = await page.locator('.xlsxengine-host').boundingBox()
      expect(box).not.toBeNull()
      await page.mouse.click(box!.x + 200, box!.y + 650)
      await expect.poll(async () => {
        return page.evaluate(() => {
          const el = document.querySelector('xlsx-editor') as any
          try { return el.getSelection() } catch { return '' }
        })
      }, { timeout: 10000, intervals: [500] }).not.toBe('A1')
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('H1-fanout: 시트에서 Edit해도 Edit한 쪽만 전체화면', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const { repoId } = await mkRepoWithFiles('g6h1b', [
      { name: 'a.xlsx', fixture: FIXTURE_XLSX },
      { name: 'b.xlsx', fixture: FIXTURE_XLSX },
    ])
    try {
      // 패널/시트는 selection을 공유하므로(기존 설계) 시트에서 b를 열면
      // 패널도 b로 따라오고 H2에 의해 플레이스홀더가 된다.
      // 서로 다른 파일을 양쪽에 고정하는 상태는 앱 설계상 만들 수 없다.
      await page.goto(`${FRONT}/repos/${repoId}?collabDebug=1&e2e=1`)
      await page.getByTitle('Files', { exact: true }).click({ timeout: 20000 })
      await page.locator('[data-testid="file-row"]').first().waitFor({ timeout: 90000 })
      await page.locator('[data-testid="file-row"][data-path$="a.xlsx"]').locator('span', { hasText: 'a.xlsx' }).first().click({ timeout: 20000 })
      await page.waitForSelector('.xlsxengine-host', { timeout: 60000 })
      await page.waitForTimeout(3000)
      await page.getByTitle('Open fullscreen', { exact: true }).first().click({ timeout: 20000 })
      const sheet = page.locator('div.fixed.inset-0.z-50')
      await sheet.locator('[data-testid="file-row"]').first().waitFor({ timeout: 90000 })
      await sheet.locator('[data-testid="file-row"][data-path$="b.xlsx"]').locator('span', { hasText: 'b.xlsx' }).first().click({ timeout: 20000 })
      // 패널이 b로 따라오고 플레이스홀더가 된다 (H2).
      await expect(page.getByTestId('preview-shadowed').first()).toBeVisible({ timeout: 30000 })
      await page.waitForTimeout(3000)
      // 시트(b.xlsx)에서 Edit → 시트 쪽만 전체화면이 된다 (H1 path 스코프).
      await sheet.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20000 })
      await page.waitForTimeout(4000)
      const fsCount = await page.locator('[data-testid="preview-fullscreen-root"]').count()
      expect(fsCount, 'only the editing FilePreview goes fullscreen').toBe(1)
      const fsHasB = await page.locator('[data-testid="preview-fullscreen-root"]').first().getByText('b.xlsx', { exact: false }).count()
      expect(fsHasB, 'fullscreen shows the edited file').toBeGreaterThan(0)
    } finally {
      await ctx.close().catch(() => {})
    }
  })
})

test.describe('C4-6 H2: 한 탭에 편집기는 하나', () => {
  test('H2-unmount: 시트에 같은 파일 열면 패널은 플레이스홀더, 편집기 1개', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const { repoId } = await mkRepoWithFiles('g6h2a', [{ name: 'm.xlsx', fixture: FIXTURE_XLSX }])
    try {
      await openInPanel(page, repoId, 'm.xlsx', '.xlsxengine-host')
      await openInSheet(page, 'm.xlsx', '.xlsxengine-host', 2)
      // 패널 쪽은 플레이스홀더로 바뀌고 에디터는 시트 것만 남는다.
      await expect(page.getByTestId('preview-shadowed').first()).toBeVisible({ timeout: 15000 })
      expect(await page.locator('xlsx-editor').count()).toBe(1)
      // 서버 참가자는 userId 기준 1명.
      const rooms = await apiGet('/api/collab/rooms')
      const room = roomBySuffix(rooms, `/g6h2a/m.xlsx`)
      expect(((room.participants ?? []) as unknown[]).length).toBe(1)
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('H2-edit-single: 시트에서 Edit해도 편집기는 1개, 보는 쪽 0개', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const { repoId } = await mkRepoWithFiles('g6h2b', [{ name: 'm.xlsx', fixture: FIXTURE_XLSX }])
    try {
      await openInPanel(page, repoId, 'm.xlsx', '.xlsxengine-host')
      await page.getByTitle('Open fullscreen', { exact: true }).first().click({ timeout: 20000 })
      const sheet = page.locator('div.fixed.inset-0.z-50')
      await sheet.locator('[data-testid="file-row"]').first().waitFor({ timeout: 90000 })
      await sheet.locator('[data-testid="file-row"][data-path$="m.xlsx"]').locator('span', { hasText: 'm.xlsx' }).first().click({ timeout: 20000 })
      await page.waitForFunction(() => document.querySelectorAll('.xlsxengine-host').length >= 2, null, { timeout: 30000 }).catch(() => {})
      await page.waitForTimeout(3000)
      await sheet.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20000 })
      await page.waitForTimeout(5000)
      const eds = await xlsxEditors(page)
      const editing = eds.filter((e) => e.readOnly === false)
      const viewing = eds.filter((e) => e.readOnly !== false)
      expect(eds.length, 'single editor per tab').toBe(1)
      expect(editing.length, 'the one editor is editing').toBe(1)
      expect(viewing.length, 'no viewing editor left').toBe(0)
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('H2-close-restore: 시트 닫으면 패널에 뷰어 복귀', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    const { repoId } = await mkRepoWithFiles('g6h2c', [{ name: 'm.xlsx', fixture: FIXTURE_XLSX }])
    try {
      await openInPanel(page, repoId, 'm.xlsx', '.xlsxengine-host')
      await openInSheet(page, 'm.xlsx', '.xlsxengine-host', 2)
      await expect(page.getByTestId('preview-shadowed').first()).toBeVisible({ timeout: 15000 })
      await closeSheet(page)
      // 패널이 뷰어로 돌아온다.
      await expect.poll(async () => page.locator('xlsx-editor').count(), { timeout: 30000, intervals: [500] }).toBe(1)
      await expect(page.getByTestId('preview-shadowed')).toHaveCount(0, { timeout: 10000 })
    } finally {
      await ctx.close().catch(() => {})
    }
    async function closeSheet(page: Page) {
      const sheet = page.locator('div.fixed.inset-0.z-50')
      await sheet.getByLabel('Close explorer').click({ timeout: 20000 }).catch(() => {})
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(4000)
    }
  })

  test('H2-close-clean: 미리보기까지 닫으면 WS 0개·참가자 0명·유령 없음', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    const wsEvents: string[] = []
    page.on('websocket', (ws) => {
      if (!ws.url().includes('/collab/')) return
      wsEvents.push('open')
      ws.on('close', () => wsEvents.push('close'))
    })
    await gotoApp(page)
    const { repoId } = await mkRepoWithFiles('g6h2d', [{ name: 'm.xlsx', fixture: FIXTURE_XLSX }])
    try {
      await openInPanel(page, repoId, 'm.xlsx', '.xlsxengine-host')
      await page.waitForTimeout(3000)
      // 패널 닫기 (Files 토글이 아니라 X 버튼).
      await page.getByLabel('Close explorer').first().click({ timeout: 20000 })
      await page.waitForTimeout(3000)
      expect(await page.locator('xlsx-editor').count()).toBe(0)
      const rooms = await apiGet('/api/collab/rooms')
      const mine = (rooms.rooms ?? []).filter((r: any) => typeof r.path === 'string' && r.path.replace(/\\/g, '/').endsWith('/g6h2d/m.xlsx'))
      expect(mine.length, 'room gone after panel close').toBe(0)
      await page.waitForTimeout(40000)
      const rooms2 = await apiGet('/api/collab/rooms')
      const mine2 = (rooms2.rooms ?? []).filter((r: any) => typeof r.path === 'string' && r.path.replace(/\\/g, '/').endsWith('/g6h2d/m.xlsx'))
      expect(mine2.length, 'no ghost after 40s').toBe(0)
      const opens = wsEvents.filter((e) => e === 'open').length
      const closes = wsEvents.filter((e) => e === 'close').length
      expect(opens - closes, 'no leaked collab sockets').toBe(0)
    } finally {
      await ctx.close().catch(() => {})
    }
  })
})

test.describe('C4-6 H3: 보기 모드는 셀을 게시하지 않는다', () => {
  test('H3-viewer-silent: 보기에서 셀을 골라도 상대 화면 박스 0개', async ({ browser }) => {
    const mk = async (user: { id: string; name: string; color: string }) => {
      const c = await browser.newContext({ viewport: { width: 1400, height: 900 } })
      await seedUser(c, user)
      const p = await c.newPage()
      await gotoApp(p)
      return { ctx: c, page: p }
    };
    const tA = await mk(ADA)
    const tB = await mk(GRACE)
    const rel = uniqueRelWithExt('c46h3', 0, '.xlsx')
    const abs = absForRel(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.copyFileSync(FIXTURE_XLSX, abs)
    const name = rel.split('/').pop()!
    const openView = async (page: Page) => {
      await page.getByTitle('Workspace').click({ timeout: 20000 })
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-row"]').length > 0, null, { timeout: 20000 })
      for (let i = 0; i < 8; i++) {
        const has = await page.evaluate((n: string) => [...document.querySelectorAll('[data-testid="file-row"]')].some((r) => (r.textContent || '').includes(n)), name)
        if (has) break
        const folder = page.locator('[data-testid="file-row"][data-path$="collab-e2e"]')
        if ((await folder.count()) > 0) await folder.locator('div.flex-1').first().click({ timeout: 10000 }).catch(() => {})
        await page.waitForTimeout(1500)
      }
      await page.locator(`[data-testid="file-row"][data-path$="${name}"]`).locator('span', { hasText: name }).first().click({ timeout: 20000 })
      await page.waitForSelector('.xlsxengine-host', { timeout: 30000 })
      await page.waitForTimeout(3000)
    }
    try {
      // B가 먼저 편집 (방 시드).
      await openView(tB.page)
      await tB.page.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20000 })
      await tB.page.waitForTimeout(4000)
      const cidB = await tB.page.evaluate(() => {
        const el = document.querySelector('xlsx-editor') as any
        return (el?.collaborationState?.people ?? []).find((p: any) => p.self)?.clientId ?? -1
      })
      expect(cidB).toBeGreaterThan(0)
      // A는 보기 모드로 연다.
      await openView(tA.page)
      await tA.page.waitForTimeout(4000)
      const cidA = await tA.page.evaluate(() => {
        const el = document.querySelector('xlsx-editor') as any
        return (el?.collaborationState?.people ?? []).find((p: any) => p.self)?.clientId ?? -1
      })
      expect(cidA).toBeGreaterThan(0)
      // A가 D5 선택 (viewer).
      const sel = await tA.page.evaluate(() => {
        const el = document.querySelector('xlsx-editor') as any
        try {
          if (typeof el?.select !== 'function') return 'no-select-fn'
          el.select('D5')
          return typeof el.getSelection === 'function' ? String(el.getSelection()) : 'selected'
        } catch { return 'error' }
      })
      expect(sel).toContain('D5')
      await tA.page.waitForTimeout(3000)
      // B 화면에 A의 박스가 뜨지 않는다.
      await expect.poll(async () => visibleRemoteCount(tB.page, cidA), { timeout: 10000, intervals: [500] }).toBe(0)
      // A도 B의 박스를 보면 안 된다... B는 편집자라 게시하므로 A는 B를 본다. (편집자 박스는 정상 표시)
      const nB = await visibleRemoteCount(tA.page, cidB)
      expect(nB, 'editor boxes still visible to viewer').toBeGreaterThan(0)
    } finally {
      await tB.ctx.close().catch(() => {})
      await tA.ctx.close().catch(() => {})
    }
  })

  async function visibleRemoteCount(page: Page, cid: number): Promise<number> {
    return page.evaluate((c: number) => {
      let n = 0
      for (const el of document.querySelectorAll('xlsx-editor')) {
        const root = (el as unknown as { shadowRoot?: ShadowRoot | null }).shadowRoot ?? document
        for (const b of root.querySelectorAll('.xg-remote')) {
          const be = b as HTMLElement
          if (be.hidden) continue
          if ((be as unknown as { dataset?: { clientId?: string } }).dataset?.clientId !== String(c)) continue
          const r = be.getBoundingClientRect()
          if (r.width > 0 && r.height > 0) n += 1
        }
      }
      return n
    }, cid)
  }
})

test.describe('C4-6 H4: 반복 편집해도 늘지 않는다', () => {
  test('H4-cycles: Edit→Done 10회 후에도 WS·참가자·슬롯 래퍼 1개', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    const wsEvents: string[] = []
    page.on('websocket', (ws) => {
      if (!ws.url().includes('/collab/')) return
      wsEvents.push('open')
      ws.on('close', () => wsEvents.push('close'))
    })
    await gotoApp(page)
    const { repoId } = await mkRepoWithFiles('g6h4', [{ name: 'm.xlsx', fixture: FIXTURE_XLSX }])
    const slotWrappers = () => page.evaluate(() => {
      let n = 0
      for (const el of document.querySelectorAll('xlsx-editor')) {
        const root = (el as unknown as { shadowRoot?: ShadowRoot | null }).shadowRoot
        if (root) n += root.querySelectorAll('[data-testid="app-titlebar-slot"]').length
      }
      return n
    })
    try {
      await openInPanel(page, repoId, 'm.xlsx', '.xlsxengine-host')
      await page.waitForTimeout(3000)
      for (let i = 0; i < 10; i++) {
        await page.getByRole('button', { name: 'Edit', exact: true }).first().click({ timeout: 20000 })
        await page.waitForFunction(() => {
          const el = document.querySelector('xlsx-editor') as any
          return el && el.readOnly === false
        }, null, { timeout: 20000 })
        await page.getByRole('button', { name: 'Done', exact: true }).first().click({ timeout: 20000 })
        await page.waitForFunction(() => {
          const el = document.querySelector('xlsx-editor') as any
          return el && el.readOnly !== false
        }, null, { timeout: 20000 })
      }
      await page.waitForTimeout(3000)
      expect(await page.locator('xlsx-editor').count(), 'editors stay 1').toBe(1)
      expect(await slotWrappers(), 'titlebar slots do not accumulate').toBe(1)
      const rooms = await apiGet('/api/collab/rooms')
      const mine = (rooms.rooms ?? []).filter((r: any) => typeof r.path === 'string' && r.path.replace(/\\/g, '/').endsWith('/g6h4/m.xlsx'))
      expect(mine.length, 'single room').toBe(1)
      expect((((mine[0] as any).participants ?? []) as unknown[]).length, 'single participant').toBe(1)
      const opens = wsEvents.filter((e) => e === 'open').length
      const closes = wsEvents.filter((e) => e === 'close').length
      expect(opens - closes, 'no leaked collab sockets').toBe(1)
    } finally {
      await ctx.close().catch(() => {})
    }
  })
})
