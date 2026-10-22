import { test, expect, type Page } from '@playwright/test'
import { openFile, closePreview } from './helpers/viewer'

/**
 * UI 개편 트랙(U1~U3) 수용 기준 테스트.
 *
 * U1: 미리보기 닫기 버튼이 없고, 탐색기를 축소하면 미리보기가 언마운트된다.
 * U2: 편집 모드에서 Done/Save/Comments 가 에디터의 기능 search 오른쪽에 있다.
 * U3: 편집 모드는 전체화면 — 탐색기/파일 행/앱 헤더가 보이지 않는다.
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

/** 네 귀퉁이가 어디에 걸리는지 + 앱 헤더/탐색기가 가려졌는지. */
async function cornerProbe(page: Page) {
  return page.evaluate(() => {
    const desc = (el: Element | null): string => {
      if (!el) return 'null'
      const cls = String((el as HTMLElement).className || '')
      const tid = el.getAttribute('data-testid')
      return `${el.tagName.toLowerCase()}${tid ? '#' + tid : ''}${cls.includes('inset-0') ? '.inset0' : ''}`
    }
    const overlay = document.querySelector('[data-testid="preview-fullscreen-root"]')
    const appHeader = document.querySelector('[data-testid="preview-file-header"]')
    const w = window.innerWidth
    const h = window.innerHeight
    const points: Array<[number, number]> = [[2, 2], [w - 2, 2], [2, h - 2], [w - 2, h - 2]]
    const corners = points.map(([x, y]) => {
      const el = document.elementFromPoint(x, y)
      return {
        el: desc(el),
        insideOverlay: !!(overlay && el && overlay.contains(el)),
        insideAppHeader: !!(appHeader && el && appHeader.contains(el)),
      }
    })
    const row = document.querySelector('[data-testid="file-row"]')
    let rowCovered: boolean | null = null
    if (row) {
      const b = row.getBoundingClientRect()
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
      rowCovered = !(hit && (row === hit || row.contains(hit)))
    }
    return {
      corners,
      rowCovered,
      appHeaderPresent: !!appHeader,
      docHeaderPresent: !!document.querySelector('[data-testid="preview-doc-header"]'),
      fileRows: document.querySelectorAll('[data-testid="file-row"]').length,
    }
  })
}

test.describe('UI 개편 (U1~U3)', () => {
  test('U1: Close preview 버튼이 없고 탐색기 축소로 미리보기가 언마운트된다', async ({ page }) => {
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

  test('U3: 편집 모드는 전체화면 — 탐색기/파일 행/앱 헤더가 보이지 않는다', async ({ page }) => {
    await openFile(page, PPTX, 'view')
    await page.waitForSelector('[data-testid="pptx-viewer-root"]', { timeout: 30000 })
    await page.getByRole('button', { name: 'Edit' }).click({ timeout: 20000 })
    await page.waitForSelector('[data-testid="preview-fullscreen-root"]', { timeout: 20000 })
    await page.waitForTimeout(1500)

    const inEdit = await cornerProbe(page)
    // 앱 헤더(파일명/액션 바)는 편집 화면에서 사라진다.
    expect(inEdit.appHeaderPresent).toBe(false)
    // 문서 헤더(View/Office(PDF)/Done/Save/Comments)도 사라진다.
    expect(inEdit.docHeaderPresent).toBe(false)
    // 네 귀퉁이가 모두 에디터 컨테이너 안이다.
    for (const c of inEdit.corners) {
      expect(c.insideOverlay, `corner element ${c.el}`).toBe(true)
      expect(c.insideAppHeader).toBe(false)
    }
    // 파일 행은 화면에서 가려져 있다(탐색기 자체가 보이지 않는다).
    expect(inEdit.rowCovered).toBe(true)

    // Escape → 원래 레이아웃으로 돌아온다.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1500)
    const after = await cornerProbe(page)
    expect(after.appHeaderPresent).toBe(true)
    expect(after.fileRows).toBeGreaterThan(0)
  })

  test('U2: 편집 모드에서 Done/Save/Comments 가 기능 search 오른쪽에 있다', async ({ page }) => {
    await openFile(page, PPTX, 'view')
    await page.waitForSelector('[data-testid="pptx-viewer-root"]', { timeout: 30000 })
    await page.getByRole('button', { name: 'Edit' }).click({ timeout: 20000 })
    await page.waitForTimeout(2000)

    const layout = await page.evaluate(() => {
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
    // lib 타이틀바의 슬롯(slot="after-search")에 투영되어 있다.
    expect(layout.inShadowSlot).toBe('after-search')
    // 기능 search 의 오른쪽에 있다.
    expect(layout.searchRect).not.toBeNull()
    expect(layout.actionsRect).not.toBeNull()
    expect(layout.actionsRect!.x).toBeGreaterThanOrEqual(layout.searchRect!.x + layout.searchRect!.w - 1)
    // 자동 저장 토글(꺼는 수단)은 표시되지 않는다.
    expect(layout.autosaveVisible).toBe(false)
  })
})
