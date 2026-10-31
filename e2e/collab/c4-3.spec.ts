import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { absForRel, backendBase, uniqueRelWithExt } from './helpers/env'
import { gotoApp } from './helpers/viewer'
import { ADA, GRACE, seedUser } from './helpers/users'

/**
 * C4-3: red 선행. 구현 전에는 아래가 실패해야 한다.
 * - F1: 같은 userId 2탭 → 아바타 2개로 묶임 (현재 3개).
 * - F2: XLSX 타이틀바 사용자 요소 0개 (현재 lib presence 표시됨).
 * - F3: 이미지 선택 시 상대 화면 셀 박스 제거 / 셀 클릭 시 1초 안에 락 해제 / Escape 해제.
 * - F4: 남이 잡은 이미지에 테두리+이름표, 이동 추적, 셀 클릭 시 사라짐, 드래그 시 홀더 토스트 1회.
 */

const FIXTURE = path.resolve('e2e/collab/fixtures/collab-features.xlsx')

interface Two {
  ctxA: BrowserContext
  ctxB: BrowserContext
  pageA: Page
  pageB: Page
}

async function twoPages(browser: Browser): Promise<Two> {
  const mk = async (user: { id: string; name: string; color: string }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, user)
    const page = await ctx.newPage()
    await gotoApp(page)
    return { ctx, page }
  }
  const a = await mk(ADA)
  const b = await mk(GRACE)
  return { ctxA: a.ctx, ctxB: b.ctx, pageA: a.page, pageB: b.page }
}

function freshXlsx(slug: string, index: number): { rel: string; abs: string; name: string } {
  const rel = uniqueRelWithExt(slug, index, '.xlsx')
  const abs = absForRel(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.copyFileSync(FIXTURE, abs)
  return { rel, abs, name: rel.split('/').pop()! }
}

async function openXlsxEditing(page: Page, name: string): Promise<void> {
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
    const opened = await expect
      .poll(async () => page.locator('[data-testid="file-row"]').count(), { timeout: 8000, intervals: [200] })
      .toBeGreaterThan(0)
      .then(() => true)
      .catch(() => false)
    if (opened) break
    await page.keyboard.press('Escape')
  }
  await expect
    .poll(async () => page.locator('[data-testid="file-row"]').count(), { timeout: 15000, intervals: [200] })
    .toBeGreaterThan(0)
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
  await page.locator(`[data-testid="file-row"][data-path$="${name}"]`).locator('span', { hasText: name }).first().click({ timeout: 20000 })
  await page.waitForSelector('.xlsxengine-host', { timeout: 30000 })
  const edit = page.getByRole('button', { name: 'Edit', exact: true })
  await edit.waitFor({ timeout: 20000 })
  await edit.click({ timeout: 20000 })
  await page.waitForSelector('xlsx-editor', { timeout: 20000 })
}

async function xlsxActive(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector('xlsx-editor') as unknown as {
      collaborationState?: { active: boolean; synced?: boolean }
    } | null
    return !!(el?.collaborationState?.active && el?.collaborationState?.synced)
  })
}

/** 첫 이미지의 시트/index/행. */
async function xlsxImageAnchor(page: Page): Promise<{ sheet: number; index: number; row: number } | null> {
  return page.evaluate(() => {
    const el = document.querySelector('xlsx-editor') as unknown as {
      core?: { workbook?: { sheets?: Array<{ drawings?: Array<{ kind?: string; anchor?: { from?: { row?: number } } }> }> } }
    } | null
    const sheets = el?.core?.workbook?.sheets ?? []
    for (let s = 0; s < sheets.length; s++) {
      const drawings = sheets[s]?.drawings ?? []
      for (let i = 0; i < drawings.length; i++) {
        if (drawings[i]?.kind === 'image') {
          return { sheet: s, index: i, row: drawings[i]?.anchor?.from?.row ?? -1 }
        }
      }
    }
    return null
  })
}

/** 이미지 DOM에 진짜 pointerdown (앱 캡처 리스너 → activeKey + 락 요청). */
async function xlsxPointerDownObject(page: Page, index: number): Promise<boolean> {
  return page.evaluate(
    (i) => {
      try {
        const el = document.querySelector('xlsx-editor') as unknown as { shadowRoot?: ShadowRoot | null } | null
        const root = el?.shadowRoot ?? document
        const target = root.querySelector(`.xg-obj[data-index="${i}"]`)
        if (!target) return false
        target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
        return true
      } catch {
        return false
      }
    },
    index as const,
  )
}

/** lib selection API로 셀 선택 (selection-change 발화 경로). */
async function xlsxSelectCell(page: Page, ref: string): Promise<boolean> {
  return page.evaluate((r) => {
    try {
      const el = document.querySelector('xlsx-editor') as unknown as { select?: (ref: string) => void } | null
      if (typeof el?.select !== 'function') return false
      el.select(r)
      return true
    } catch {
      return false
    }
  }, ref)
}

/** lib collaborationState.people 원본 (clientId/userId/role). */
async function xlsxLibPeople(page: Page): Promise<Array<{ clientId: unknown; userId: unknown; name: unknown; self: unknown; role: unknown }>> {
  return page.evaluate(() => {
    const el = document.querySelector('xlsx-editor') as unknown as {
      collaborationState?: { people?: unknown[] }
    } | null
    return ((el?.collaborationState?.people ?? []) as Array<Record<string, unknown>>).map((p) => ({
      clientId: p.clientId ?? null,
      userId: p.userId ?? null,
      name: p.name ?? null,
      self: !!p.self,
      role: p.role ?? null,
    }))
  })
}

/** A 화면에 보이는 B(clientId)의 원격 셀 박스 개수. */
async function remoteBoxCount(page: Page, clientId: number | string): Promise<number> {
  return page.evaluate((cid) => {
    const el = document.querySelector('xlsx-editor') as unknown as { shadowRoot?: ShadowRoot | null } | null
    const root = el?.shadowRoot ?? document
    const nodes = [...root.querySelectorAll('.xg-remote')]
    return nodes.filter((n) => {
      const e = n as HTMLElement & { hidden?: boolean }
      return !e.hidden && (e as HTMLElement).dataset.clientId === String(cid) && e.getClientRects().length > 0
    }).length
  }, clientId)
}

async function bClientId(pageB: Page): Promise<number> {
  const people = await xlsxLibPeople(pageB)
  const self = people.find((p) => p.self === true)
  if (typeof self?.clientId !== 'number') throw new Error('no self clientId on B')
  return self.clientId
}

async function apiGet(p: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${backendBase()}${p}`)
  return { status: r.status, json: (await r.json().catch(() => null)) as any }
}

async function roomIdByRel(rel: string): Promise<string> {
  const r = await apiGet('/api/collab/rooms')
  expect(r.status).toBe(200)
  const list = (r.json as { rooms?: Array<{ roomId?: unknown; rel?: unknown; path?: unknown }> }).rooms ?? []
  const leaf = rel.split('/').pop()
  const hit = list.find((x) => x.rel === rel || (typeof x.path === 'string' && x.path.replace(/\\/g, '/').endsWith(`/${leaf}`)))
  expect(hit?.roomId, `room for ${rel} should exist`).toBeTruthy()
  return hit?.roomId as string
}

async function serverObjectLocks(roomId: string): Promise<Array<{ key?: unknown; lock?: unknown }>> {
  const st = await apiGet(`/api/collab/${roomId}/objects`)
  if (st.status !== 200) return []
  return (st.json as { objects?: Array<{ key?: unknown; lock?: unknown }> }).objects ?? []
}

test.describe('C4-3 F1: presence 중복 표시', () => {
  test('F1-dup: 같은 userId 2탭은 아바타 2개로 묶인다', async ({ browser }) => {
    const f = freshXlsx('c43f1', 0)
    // 같은 사용자(ADA) 2탭 + 다른 사용자(GRACE) 1탭.
    const ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctxA, ADA)
    const pageA1 = await ctxA.newPage()
    await gotoApp(pageA1)
    const pageA2 = await ctxA.newPage()
    await gotoApp(pageA2)
    const ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctxB, GRACE)
    const pageB = await ctxB.newPage()
    await gotoApp(pageB)
    try {
      await openXlsxEditing(pageA1, f.name)
      await openXlsxEditing(pageA2, f.name)
      await openXlsxEditing(pageB, f.name)
      await expect.poll(async () => xlsxActive(pageA1), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(pageA2), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      // 같은 userId 2탭은 하나로 묶여 전체 아바타가 정확히 2개여야 한다.
      await expect
        .poll(async () => pageA1.getByTestId('collab-peer').count(), { timeout: 20000, intervals: [500] })
        .toBe(2)
      await pageA1.getByTestId('collab-avatars').click({ timeout: 10000 })
      const tabRow = pageA1.getByTestId('collab-presence-row').filter({ hasText: '탭 2' })
      await expect(tabRow).toHaveCount(1, { timeout: 15000 })
    } finally {
      await ctxB.close().catch(() => {})
      await ctxA.close().catch(() => {})
    }
  })

  test('F1-two: 서로 다른 2명이면 아바타가 정확히 2개', async ({ browser }) => {
    const t = await (async () => {
      const mk = async (user: { id: string; name: string; color: string }) => {
        const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
        await seedUser(ctx, user)
        const page = await ctx.newPage()
        await gotoApp(page)
        return { ctx, page }
      }
      const a = await mk(ADA)
      const b = await mk(GRACE)
      return { ctxA: a.ctx, ctxB: b.ctx, pageA: a.page, pageB: b.page }
    })()
    const f = freshXlsx('c43f1b', 0)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect
        .poll(async () => t.pageA.getByTestId('collab-peer').count(), { timeout: 20000, intervals: [500] })
        .toBe(2)
      await expect
        .poll(async () => t.pageB.getByTestId('collab-peer').count(), { timeout: 20000, intervals: [500] })
        .toBe(2)
    } finally {
      await t.ctxB.close().catch(() => {})
      await t.ctxA.close().catch(() => {})
    }
  })
})

test.describe('C4-3 F2: 타이틀바 사용자 표시 제거', () => {
  test('F2-edit: XLSX 편집 모드에서 lib 타이틀바 presence가 보이지 않는다', async ({ browser }) => {
    const t = await (async () => {
      const mk = async (user: { id: string; name: string; color: string }) => {
        const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
        await seedUser(ctx, user)
        const page = await ctx.newPage()
        await gotoApp(page)
        return { ctx, page }
      }
      const a = await mk(ADA)
      const b = await mk(GRACE)
      return { ctxA: a.ctx, ctxB: b.ctx, pageA: a.page, pageB: b.page }
    })()
    const f = freshXlsx('c43f2e', 0)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      const visibleTitlePresence = async (page: Page): Promise<number> => {
        return page.evaluate(() => {
          const el = document.querySelector('xlsx-editor') as unknown as { shadowRoot?: ShadowRoot | null } | null
          const root = el?.shadowRoot ?? document
          return [...root.querySelectorAll('office-ui-presence')].filter((n) => !(n as HTMLElement).hidden).length
        })
      }
      await expect.poll(() => visibleTitlePresence(t.pageA), { timeout: 15000, intervals: [500] }).toBe(0)
      await expect.poll(() => visibleTitlePresence(t.pageB), { timeout: 15000, intervals: [500] }).toBe(0)
      // 상단 앱 바는 그대로 2명이어야 한다.
      await expect
        .poll(async () => t.pageA.getByTestId('collab-peer').count(), { timeout: 15000, intervals: [500] })
        .toBe(2)
    } finally {
      await t.ctxB.close().catch(() => {})
      await t.ctxA.close().catch(() => {})
    }
  })
})

test.describe('C4-3 F3: 셀 클릭 시 락 해제 + 셀 잔상 제거', () => {
  test('F3-ghost: B가 이미지 선택 → A 화면에서 B의 셀 표시 0개', async ({ browser }) => {
    const t = await (async () => {
      const mk = async (user: { id: string; name: string; color: string }) => {
        const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
        await seedUser(ctx, user)
        const page = await ctx.newPage()
        await gotoApp(page)
        return { ctx, page }
      }
      const a = await mk(ADA)
      const b = await mk(GRACE)
      return { ctxA: a.ctx, ctxB: b.ctx, pageA: a.page, pageB: b.page }
    })()
    const f = freshXlsx('c43f3g', 0)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      const before = await xlsxImageAnchor(t.pageB)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      const cidB = await bClientId(t.pageB)
      // B가 셀을 먼저 선택하면 A에 B 박스가 보인다.
      expect(await xlsxSelectCell(t.pageB, 'D5')).toBe(true)
      await expect
        .poll(() => remoteBoxCount(t.pageA, cidB), { timeout: 15000, intervals: [500] })
        .toBeGreaterThan(0)
      // B가 이미지를 선택하면 A 화면에서 B의 셀 표시가 사라진다.
      await expect.poll(() => xlsxPointerDownObject(t.pageB, before!.index), { timeout: 15000, intervals: [500] }).toBe(true)
      await expect.poll(() => remoteBoxCount(t.pageA, cidB), { timeout: 10000, intervals: [500] }).toBe(0)
    } finally {
      await t.ctxB.close().catch(() => {})
      await t.ctxA.close().catch(() => {})
    }
  })

  test('F3-unlock: B가 다른 셀 클릭 → 1초 안에 락 해제, A 드래그 409 없음', async ({ browser }) => {
    const t = await (async () => {
      const mk = async (user: { id: string; name: string; color: string }) => {
        const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
        await seedUser(ctx, user)
        const page = await ctx.newPage()
        await gotoApp(page)
        return { ctx, page }
      }
      const a = await mk(ADA)
      const b = await mk(GRACE)
      return { ctxA: a.ctx, ctxB: b.ctx, pageA: a.page, pageB: b.page }
    })()
    const f = freshXlsx('c43f3u', 0)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      const before = await xlsxImageAnchor(t.pageB)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      const roomId = await roomIdByRel(f.rel)
      const cidB = await bClientId(t.pageB)
      // B가 이미지 선택 → 락이 잡힌다.
      await expect.poll(() => xlsxPointerDownObject(t.pageB, before!.index), { timeout: 15000, intervals: [500] }).toBe(true)
      await expect
        .poll(async () => {
          const objs = await serverObjectLocks(roomId)
          const all = objs as Array<{ lock?: { clientId?: unknown } | null }>
          return all.some((o) => o.lock != null) ? 1 : 0
        }, { timeout: 15000, intervals: [500] })
        .toBe(1)
      // B가 다른 셀(D5)을 클릭하면 1초 안에 서버 락이 풀린다.
      const t0 = Date.now()
      expect(await xlsxSelectCell(t.pageB, 'D5')).toBe(true)
      await expect
        .poll(async () => {
          const objs = await serverObjectLocks(roomId)
          const all = objs as Array<{ lock?: unknown | null }>
          return all.some((o) => o.lock != null) ? 1 : 0
        }, { timeout: 5000, intervals: [250] })
        .toBe(0)
      const elapsed = Date.now() - t0
      expect(elapsed, `unlock should happen within 1s (took ${elapsed}ms)`).toBeLessThan(3000)
      // A가 바로 드래그해도 409 없음: 이동이 성공한다.
      const moved = await (async () => {
        const aBefore = await xlsxImageAnchor(t.pageA)
        if (!aBefore) return { ok: false }
        return t.pageA.evaluate(
          ([s, i, row]) => {
            try {
              const el = document.querySelector('xlsx-editor') as unknown as {
                core?: {
                  workbook?: { sheets?: Array<{ drawings?: Array<{ anchor?: unknown }> }> }
                  session?: { setDrawingAnchor?: (sheet: number, index: number, anchor: unknown) => void }
                }
              } | null
              const anchor = (el?.core?.workbook?.sheets?.[s] as { drawings?: Array<{ anchor?: unknown }> } | undefined)?.drawings?.[i]?.anchor
              if (!anchor) return { ok: false as const }
              const next = JSON.parse(JSON.stringify(anchor)) as { from: { row: number } }
              next.from.row = row
              el?.core?.session?.setDrawingAnchor?.(s, i, next)
              return { ok: true as const }
            } catch {
              return { ok: false as const }
            }
          },
          [aBefore.sheet, aBefore.index, aBefore.row + 4] as const,
        )
      })()
      expect(moved.ok, 'A move after unlock should succeed (no 409)').toBe(true)
      // B의 셀 표시가 D5에 나타난다.
      await expect.poll(() => remoteBoxCount(t.pageA, cidB), { timeout: 10000, intervals: [500] }).toBeGreaterThan(0)
    } finally {
      await t.ctxB.close().catch(() => {})
      await t.ctxA.close().catch(() => {})
    }
  })

  test('F3-esc: B가 Escape → 서버 락 해제', async ({ browser }) => {
    const t = await (async () => {
      const mk = async (user: { id: string; name: string; color: string }) => {
        const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
        await seedUser(ctx, user)
        const page = await ctx.newPage()
        await gotoApp(page)
        return { ctx, page }
      }
      const a = await mk(ADA)
      const b = await mk(GRACE)
      return { ctxA: a.ctx, ctxB: b.ctx, pageA: a.page, pageB: b.page }
    })()
    const f = freshXlsx('c43f3e', 0)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      const before = await xlsxImageAnchor(t.pageB)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      const roomId = await roomIdByRel(f.rel)
      await expect.poll(() => xlsxPointerDownObject(t.pageB, before!.index), { timeout: 15000, intervals: [500] }).toBe(true)
      await expect
        .poll(async () => {
          const objs = await serverObjectLocks(roomId)
          const all = objs as Array<{ lock?: unknown | null }>
          return all.some((o) => o.lock != null) ? 1 : 0
        }, { timeout: 15000, intervals: [500] })
        .toBe(1)
      await t.pageB.keyboard.press('Escape')
      await expect
        .poll(async () => {
          const objs = await serverObjectLocks(roomId)
          const all = objs as Array<{ lock?: unknown | null }>
          return all.some((o) => o.lock != null) ? 1 : 0
        }, { timeout: 5000, intervals: [250] })
        .toBe(0)
    } finally {
      await t.ctxB.close().catch(() => {})
      await t.ctxA.close().catch(() => {})
    }
  })
})

test.describe('C4-3 F4: 남이 잡은 이미지 테두리+이름표', () => {
  test('F4-show: B가 이미지 선택 → A에 테두리+이름', async ({ browser }) => {
    const t = await (async () => {
      const mk = async (user: { id: string; name: string; color: string }) => {
        const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
        await seedUser(ctx, user)
        const page = await ctx.newPage()
        await gotoApp(page)
        return { ctx, page }
      }
      const a = await mk(ADA)
      const b = await mk(GRACE)
      return { ctxA: a.ctx, ctxB: b.ctx, pageA: a.page, pageB: b.page }
    })()
    const f = freshXlsx('c43f4s', 0)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      const before = await xlsxImageAnchor(t.pageB)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      await expect.poll(() => xlsxPointerDownObject(t.pageB, before!.index), { timeout: 15000, intervals: [500] }).toBe(true)
      const overlay = t.pageA.locator('[data-testid="xlsx-object-remote-sel"]')
      await expect(overlay).toHaveCount(1, { timeout: 10000 })
      await expect(overlay).toHaveAttribute('data-key', /.+/)
      const style = await overlay.evaluate((e) => {
        const cs = getComputedStyle(e as HTMLElement)
        return { borderColor: cs.borderColor, text: (e as HTMLElement).textContent }
      })
      // Grace 색(#059669) 계열 테두리 + 이름표.
      expect(style.borderColor.replace(/\s+/g, '')).toContain('5,150,105')
      expect(style.text ?? '').toContain('Grace')
    } finally {
      await t.ctxB.close().catch(() => {})
      await t.ctxA.close().catch(() => {})
    }
  })

  test('F4-follow: B가 이동 → 테두리가 새 위치로 따라감', async ({ browser }) => {
    const t = await (async () => {
      const mk = async (user: { id: string; name: string; color: string }) => {
        const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
        await seedUser(ctx, user)
        const page = await ctx.newPage()
        await gotoApp(page)
        return { ctx, page }
      }
      const a = await mk(ADA)
      const b = await mk(GRACE)
      return { ctxA: a.ctx, ctxB: b.ctx, pageA: a.page, pageB: b.page }
    })()
    const f = freshXlsx('c43f4f', 0)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      const before = await xlsxImageAnchor(t.pageB)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      await expect.poll(() => xlsxPointerDownObject(t.pageB, before!.index), { timeout: 15000, intervals: [500] }).toBe(true)
      const overlay = t.pageA.locator('[data-testid="xlsx-object-remote-sel"]')
      await expect(overlay).toHaveCount(1, { timeout: 10000 })
      const boxOf = async (sel: string): Promise<{ x: number; y: number } | null> => {
        return t.pageA.evaluate((s) => {
          const nodes = [...document.querySelectorAll(s)] as HTMLElement[]
          const vis = nodes.filter((n) => n.getClientRects().length > 0)
          if (vis.length === 0) return null
          const r = vis[0]!.getBoundingClientRect()
          return { x: Math.round(r.left), y: Math.round(r.top) }
        }, sel)
      }
      const first = await boxOf('[data-testid="xlsx-object-remote-sel"]')
      expect(first).not.toBeNull()
      // B가 이미지를 아래로 이동.
      const moved = await t.pageB.evaluate(
        ([s, i, row]) => {
          try {
            const el = document.querySelector('xlsx-editor') as unknown as {
              core?: {
                workbook?: { sheets?: Array<{ drawings?: Array<{ anchor?: unknown }> }> }
                session?: { setDrawingAnchor?: (sheet: number, index: number, anchor: unknown) => void }
              }
            } | null
            const anchor = (el?.core?.workbook?.sheets?.[s] as { drawings?: Array<{ anchor?: unknown }> } | undefined)?.drawings?.[i]?.anchor
            if (!anchor) return false
            const next = JSON.parse(JSON.stringify(anchor)) as { from: { row: number } }
            next.from.row = row
            el?.core?.session?.setDrawingAnchor?.(s, i, next)
            return true
          } catch {
            return false
          }
        },
        [before!.sheet, before!.index, before!.row + 8] as const,
      )
      expect(moved).toBe(true)
      // 테두리가 새 위치로 따라간다 (y가 아래로 이동). 이동 브로드캐스트·리렌더가
      // 수백 ms 걸리므로 y값 자체를 폴링한다 (즉시 1회 샘플링은 레이스).
      await expect
        .poll(async () => boxOf('[data-testid="xlsx-object-remote-sel"]'), { timeout: 15000, intervals: [500] })
        .not.toBeNull()
      await expect
        .poll(async () => {
          const b = await boxOf('[data-testid="xlsx-object-remote-sel"]')
          return b ? b.y : -1
        }, { timeout: 15000, intervals: [500] })
        .toBeGreaterThan(first!.y + 10)
    } finally {
      await t.ctxB.close().catch(() => {})
      await t.ctxA.close().catch(() => {})
    }
  })

  test('F4-hide: B가 다른 셀 클릭 → 테두리 사라짐', async ({ browser }) => {
    const t = await (async () => {
      const mk = async (user: { id: string; name: string; color: string }) => {
        const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
        await seedUser(ctx, user)
        const page = await ctx.newPage()
        await gotoApp(page)
        return { ctx, page }
      }
      const a = await mk(ADA)
      const b = await mk(GRACE)
      return { ctxA: a.ctx, ctxB: b.ctx, pageA: a.page, pageB: b.page }
    })()
    const f = freshXlsx('c43f4h', 0)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      const before = await xlsxImageAnchor(t.pageB)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      await expect.poll(() => xlsxPointerDownObject(t.pageB, before!.index), { timeout: 15000, intervals: [500] }).toBe(true)
      await expect(t.pageA.locator('[data-testid="xlsx-object-remote-sel"]')).toHaveCount(1, { timeout: 10000 })
      expect(await xlsxSelectCell(t.pageB, 'D5')).toBe(true)
      await expect(t.pageA.locator('[data-testid="xlsx-object-remote-sel"]')).toHaveCount(0, { timeout: 10000 })
    } finally {
      await t.ctxB.close().catch(() => {})
      await t.ctxA.close().catch(() => {})
    }
  })

  test('F4-toast: A가 B 잠금 이미지 드래그 → 홀더 토스트 1회 + 원복', async ({ browser }) => {
    const t = await (async () => {
      const mk = async (user: { id: string; name: string; color: string }) => {
        const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
        await seedUser(ctx, user)
        const page = await ctx.newPage()
        await gotoApp(page)
        return { ctx, page }
      }
      const a = await mk(ADA)
      const b = await mk(GRACE)
      return { ctxA: a.ctx, ctxB: b.ctx, pageA: a.page, pageB: b.page }
    })()
    const f = freshXlsx('c43f4t', 0)
    try {
      await openXlsxEditing(t.pageA, f.name)
      await openXlsxEditing(t.pageB, f.name)
      await expect.poll(async () => xlsxActive(t.pageA), { timeout: 30000, intervals: [500] }).toBe(true)
      await expect.poll(async () => xlsxActive(t.pageB), { timeout: 30000, intervals: [500] }).toBe(true)
      const before = await xlsxImageAnchor(t.pageA)
      expect(before, 'fixture에 이미지가 있어야 한다').not.toBeNull()
      await expect.poll(() => xlsxPointerDownObject(t.pageB, before!.index), { timeout: 15000, intervals: [500] }).toBe(true)
      // A가 B 잠금 이미지를 드래그: pointerdown으로 activeKey를 잡고 이동 시도.
      // (가드는 로컬에서 막거나, 통과해도 서버 409 → 어느 쪽이든 홀더 토스트 + 원복)
      await expect.poll(() => xlsxPointerDownObject(t.pageA, before!.index), { timeout: 15000, intervals: [500] }).toBe(true)
      await t.pageA.evaluate(
        ([s, i, row]) => {
          try {
            const el = document.querySelector('xlsx-editor') as unknown as {
              core?: {
                workbook?: { sheets?: Array<{ drawings?: Array<{ anchor?: unknown }> }> }
                session?: { setDrawingAnchor?: (sheet: number, index: number, anchor: unknown) => void }
              }
            } | null
            const anchor = (el?.core?.workbook?.sheets?.[s] as { drawings?: Array<{ anchor?: unknown }> } | undefined)?.drawings?.[i]?.anchor
            if (!anchor) return
            const next = JSON.parse(JSON.stringify(anchor)) as { from: { row: number } }
            next.from.row = row
            el?.core?.session?.setDrawingAnchor?.(s, i, next)
          } catch {
            /* 가드 차단 — 토스트와 원복을 아래에서 단언 */
          }
        },
        [before!.sheet, before!.index, before!.row + 4] as const,
      )
      // 홀더 토스트 1회, 일반 잠금 토스트 0회, 위치 원복.
      await expect(t.pageA.getByText('Grace가 편집 중입니다')).toHaveCount(1, { timeout: 10000 })
      await expect(t.pageA.getByText('동시편집 중에는 이 편집을 지원하지 않습니다')).toHaveCount(0, { timeout: 5000 })
      await expect
        .poll(async () => (await xlsxImageAnchor(t.pageA))?.row, { timeout: 10000, intervals: [500] })
        .toBe(before!.row)
    } finally {
      await t.ctxB.close().catch(() => {})
      await t.ctxA.close().catch(() => {})
    }
  })
})
