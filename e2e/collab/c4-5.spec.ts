import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { backendBase, workspaceDir } from './helpers/env'
import { gotoApp } from './helpers/viewer'
import { ADA, seedUser } from './helpers/users'

const FIXTURE_XLSX = path.resolve('e2e/collab/fixtures/collab-features.xlsx')
const FRONT = 'http://127.0.0.1:5183'

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

async function openInSheet(page: Page, name: string, hostSelector: string, hostCount: number): Promise<void> {
  const sheet = page.locator('div.fixed.inset-0.z-50')
  await page.getByTitle('Open fullscreen', { exact: true }).first().click({ timeout: 20000 })
  await sheet.locator('[data-testid="file-row"]').first().waitFor({ timeout: 90000 })
  let opened = false
  for (let attempt = 0; attempt < 3 && !opened; attempt++) {
    await sheet.locator(`[data-testid="file-row"][data-path$="${name}"]`).locator('span', { hasText: name }).first().click({ timeout: 20000 }).catch(() => {})
    opened = await page.waitForFunction((exp: number) => document.querySelectorAll('.xlsxengine-host').length >= exp, hostCount, { timeout: 30000 }).then(() => true).catch(() => false)
  }
  expect(opened, `sheet preview for ${name} should mount`).toBe(true)
  await page.waitForTimeout(3000)
}

/** self clientId 목록 (마운트 순서대로). */
async function selfClientIds(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    return [...document.querySelectorAll('xlsx-editor')].map((el) => {
      const self = ((el as unknown as { collaborationState?: { people?: Array<{ clientId?: unknown; self?: boolean }> } }).collaborationState?.people ?? []).find((p) => p.self === true)
      return typeof self?.clientId === 'number' ? self.clientId : -1
    })
  })
}

/** 특정 clientId의 보이는 원격 셀 박스 수 (전체 탭 합산, quadrants 중복 포함). */
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

async function roomByLeaf(suffix: string) {
  const rooms = await apiGet('/api/collab/rooms')
  const list = (rooms.rooms ?? []) as Array<{ roomId?: unknown; path?: unknown; participants?: unknown[] }>
  const hit = list.find((x) => typeof x.path === 'string' && x.path.replace(/\\/g, '/').endsWith(suffix))
  expect(hit, `room for ${suffix} should exist`).toBeTruthy()
  return hit!
}

test.describe('C4-5 같은 userId 원격 셀 박스 숨김', () => {
  test('G1-cell-dup: 같은 userId 다른 화면의 셀 박스는 안 보인다', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    await gotoApp(page)
    // 고유 prefix: 같은 실행 안의 이전 테스트 방과 겹치지 않게 한다.
    const slug = `g1cell${Date.now().toString(36)}`
    const mk = await mkRepoWithFiles(slug, [{ name: 'm.xlsx', fixture: FIXTURE_XLSX }])
    try {
      await openInPanel(page, mk.repoId, 'm.xlsx', '.xlsxengine-host')
      // 시트 열기 + 편집 진입 (편집 모드에서 셀 선택이 게시된다).
      await page.getByTitle('Open fullscreen', { exact: true }).first().click({ timeout: 20000 })
      const sheet = page.locator('div.fixed.inset-0.z-50')
      await sheet.locator('[data-testid="file-row"]').first().waitFor({ timeout: 90000 })
      await sheet.locator('[data-testid="file-row"][data-path$="m.xlsx"]').locator('span', { hasText: 'm.xlsx' }).first().click({ timeout: 20000 })
      await page.waitForFunction(() => document.querySelectorAll('.xlsxengine-host').length >= 2, null, { timeout: 30000 }).catch(() => {})
      await page.waitForTimeout(4000)
      await sheet.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20000 })
      await page.waitForTimeout(4000)
      // 시트 에디터에서 D5 선택 (viewer인 패널은 A1 유지).
      const selOk = await page.evaluate(() => {
        const eds = [...document.querySelectorAll('xlsx-editor')] as any[]
        const el = eds[eds.length - 1]
        try {
          if (typeof el?.select !== 'function') return 'no-select-fn'
          el.select('D5')
          return 'selected'
        } catch { return 'error' }
      })
      expect(selOk).toBe('selected')
      await page.waitForTimeout(4000)
      const cids = await selfClientIds(page)
      expect(cids.length).toBe(2)
      expect(cids[0]).toBeGreaterThan(0)
      expect(cids[1]).toBeGreaterThan(0)
      // 같은 userId 다른 화면의 셀 박스는 보이지 않아야 한다 (RED: 보임).
      await expect.poll(async () => visibleRemoteCount(page, cids[0]!), { timeout: 15000, intervals: [500] }).toBe(0)
      await expect.poll(async () => visibleRemoteCount(page, cids[1]!), { timeout: 15000, intervals: [500] }).toBe(0)
      // 서버 참가자는 userId 기준 1명 유지.
      const room = await roomByLeaf(`/${slug}/m.xlsx`)
      expect(((room.participants ?? []) as unknown[]).length).toBe(1)
    } finally {
      await ctx.close().catch(() => {})
    }
  })
})
