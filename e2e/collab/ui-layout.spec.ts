import { test, expect, type Browser, type Page } from '@playwright/test'
import { gotoApp, openFile, closePreview } from './helpers/viewer'
import { ADA, seedUser } from './helpers/users'

/**
 * UI 개편 트랙(U1~U3) 수용 기준 테스트.
 *
 * U1: 미리보기 닫기 버튼이 없고, 탐색기를 축소하면 미리보기가 언마운트된다.
 * U2: /edit 새 탭에서 Done/Save/Comments 가 에디터의 기능 search 오른쪽에 있다.
 * U3: /edit 새 탭은 크롬리스 — 탐색기/파일 행/앱 헤더가 보이지 않는다.
 *
 * 원래/변경/이유 (D64 URL 편집 분리, 2026-11):
 * - 원래: 미리보기에서 Edit 버튼을 누르면 같은 탭이 전체화면 편집 모드로 전환됐다
 *   (preview-fullscreen-root 오버레이, 탐색기·헤더 숨김, Escape로 복귀).
 * - 변경: Edit은 /edit/<경로> 새 탭을 연다. in-page 전체화면 전환은 없어졌다.
 *   U2/U3는 새 탭 기준으로 다시 썼다: 편집 탭 자체가 크롬리스이고,
 *   Done/Save/Comments는 lib 타이틀바 actions 슬롯(기능 search 오른쪽)에 있다.
 * - 이유: C5-4 D64에서 편집 진입점이 새 탭으로 바뀌어, 구 단언(오버레이·Escape 복귀)이
 *   더 이상 성립하지 않는다. in-page 미리보기(보기 모드)는 그대로이므로 U1은 유지.
 *
 * 픽스처: config 가 서버 기동 전에 심는 probe-seeded-before-server.pptx
 * (테스트 중 새로 만들면 백엔드 파일 트리에 안 올라가 행을 못 찾는다 — M9/6절).
 */
const PPTX = 'probe-seeded-before-server.pptx'

function viewerRoots(page: Page) {
  return page.evaluate(() => {
    const n = (sel: string): number => document.querySelectorAll(sel).length
    return {
      pptx: n('[data-testid="pptx-viewer-root"]'),
      sockets: (window as unknown as { __openSockets?: () => number }).__openSockets?.() ?? -1,
    }
  })
}

test.describe('UI 개편 (U1~U3)', () => {
  test('U1: Close preview 버튼이 없고 탐색기 축소로 미리보기가 언마운트된다', async ({ page }) => {
    await gotoApp(page)
    await openFile(page, PPTX, 'view')
    await page.waitForSelector('[data-testid="pptx-viewer-root"]', { timeout: 30000 })

    // 1) 화면 어디에도 "Close preview" 버튼이 없어야 한다.
    expect(await page.locator('[aria-label="Close preview"]').count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Close preview' }).count()).toBe(0)

    // 2) 탐색기를 축소하면 미리보기가 언마운트된다(뷰어 0, 소켓 0).
    await closePreview(page)
    await expect.poll(async () => (await viewerRoots(page)).pptx, { timeout: 8000, intervals: [200] }).toBe(0)
    await expect.poll(async () => (await viewerRoots(page)).sockets, { timeout: 8000, intervals: [200] }).toBe(0)
  })

  test('U3: /edit 새 탭은 크롬리스 — 탐색기/파일 행/앱 헤더가 보이지 않는다', async ({ browser }: { browser: Browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    try {
      await gotoApp(page)
      await openFile(page, PPTX, 'view')
      await page.waitForSelector('[data-testid="pptx-viewer-root"]', { timeout: 30000 })
      const [editor] = await Promise.all([
        page.waitForEvent('popup', { timeout: 15000 }),
        page.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20000 }),
      ])
      await editor.waitForLoadState('domcontentloaded', { timeout: 30000 })
      expect(editor.url()).toMatch(/\/edit\//)
      await editor.getByTestId('pptx-viewer-root').waitFor({ timeout: 60000 })
      // 새 탭은 크롬리스: 탐색기 파일 행도 앱 헤더도 없다.
      await expect(editor.locator('[data-testid="file-row"]')).toHaveCount(0)
      await expect(editor.locator('[data-testid="preview-file-header"]')).toHaveCount(0)
      // Escape는 탭을 닫지 않는다 (편집 유지 — 닫기는 Done/탭 닫기).
      await editor.keyboard.press('Escape')
      await editor.waitForTimeout(1000)
      await expect(editor.getByTestId('pptx-viewer-root')).toBeVisible()
      expect(editor.url()).toMatch(/\/edit\//)
      await editor.close()
      // 원본 탭은 그대로 (파일 행 살아 있음).
      await expect(page.locator('[data-testid="file-row"]').first()).toBeVisible()
    } finally {
      await ctx.close().catch(() => {})
    }
  })

  test('U2: /edit 탭에서 Done/Save/Comments 가 기능 search 오른쪽에 있다', async ({ browser }: { browser: Browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    try {
      await gotoApp(page)
      await openFile(page, PPTX, 'view')
      await page.waitForSelector('[data-testid="pptx-viewer-root"]', { timeout: 30000 })
      const [editor] = await Promise.all([
        page.waitForEvent('popup', { timeout: 15000 }),
        page.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20000 }),
      ])
      await editor.waitForLoadState('domcontentloaded', { timeout: 30000 })
      expect(editor.url()).toMatch(/\/edit\//)
      await editor.getByTestId('pptx-viewer-root').waitFor({ timeout: 60000 })
      await editor.waitForTimeout(2000)

      const layout = await editor.evaluate(() => {
      const bar = document.querySelector('pptx-ui-title-bar')
      const root = bar?.shadowRoot
      const search = root?.querySelector('.search')
      const searchBox = root?.querySelector('.search .box')
      const actions = document.querySelector('[data-testid="preview-editor-actions"]')
      const r = (el: Element | null) => {
        if (!el) return null
        const b = el.getBoundingClientRect()
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
      }
      const inShadowSlot = (() => {
        if (!actions) return false
        let n: Node | null = actions
        while (n) {
          const slot = (n as Element).getAttribute?.('slot')
          if (slot) return slot
          n = (n as Node).parentNode
        }
        return false
      })()
      return {
        hasBar: !!bar,
        searchRect: r(searchBox ?? null),
        actionsRect: r(actions),
        inShadowSlot,
        labels: actions ? [...actions.querySelectorAll('button')].map((b) => (b.textContent || '').trim()) : [],
        autosaveVisible: !!(root?.querySelector('.autosave') && (root.querySelector('.autosave') as HTMLElement).offsetParent !== null),
      }
    })

    expect(layout.hasBar).toBe(true)
    // Done/Save/Comments 세 개가 존재한다.
    expect(layout.labels).toContain('Done')
    expect(layout.labels).toContain('Save')
    expect(layout.labels.some((l) => l.includes('Comment'))).toBe(true)
    // lib 타이틀바의 슬롯(slot="actions", 기능 search 우측)에 투영되어 있다.
    expect(layout.inShadowSlot).toBe('actions')
    // 기능 search 의 오른쪽에 있다.
    expect(layout.searchRect).not.toBeNull()
    expect(layout.actionsRect).not.toBeNull()
    expect(layout.actionsRect!.x).toBeGreaterThanOrEqual(layout.searchRect!.x + layout.searchRect!.w - 1)
    // 자동 저장 토글(꺼는 수단)은 표시되지 않는다.
    expect(layout.autosaveVisible).toBe(false)
    await editor.close()
    } finally {
      await ctx.close().catch(() => {})
    }
  })
})
