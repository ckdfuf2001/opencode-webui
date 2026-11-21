import { test, expect, type Browser, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { backendBase, workspaceDir } from './helpers/env'
import { gotoApp } from './helpers/viewer'
import { ADA, seedUser } from './helpers/users'
/**
 * F1-5 HTML 미리보기 [화면]/[소스] 탭.
 * - 화면: /api/html-view iframe (sandbox에 allow-same-origin 없음).
 * - 소스: 기존 텍스트 뷰어 (원문).
 * - 탭 기억: localStorage html-preview-tab.
 * - 회귀: xlsx/txt 미리보기에 탭이 생기지 않는다.
 */
const HTML = `<!doctype html><html><head><link rel="stylesheet" href="h5-style.css"></head><body><h1>H5-MARKER</h1><img src="h5-dot.png"></body></html>`
const CSS = `h1{color:rgb(1,2,3)}`
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function openRow(page: Page, seg: string, name: string, reopenWorkspace = true): Promise<void> {
  if (reopenWorkspace) {
    await page.getByTitle('Workspace').click({ timeout: 20000 })
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-row"]').length > 0, null, { timeout: 30000 })
  }
  // 레포가 루트로 뜬다 (c5-1 mkRepo 패턴). seg 폴더를 펼친 뒤 파일을 누른다.
  for (let i = 0; i < 8; i++) {
    const state = await page.evaluate(([n, s]) => {
      const norm = (p: string) => p.replace(/\\/g, '/')
      const rows = [...document.querySelectorAll('[data-testid="file-row"]')] as HTMLElement[]
      const file = rows.find((r) => {
        const p = norm(r.getAttribute('data-path') || '')
        return p === `${s}/${n}` || p.endsWith(`/${s}/${n}`)
      })
      if (file) {
        const span = [...file.querySelectorAll('span')].find((e) => (e.textContent || '').includes(n as string)) as HTMLElement | null
        ;(span ?? file).dispatchEvent(new MouseEvent('click', { bubbles: true }))
        return 'clicked'
      }
      const folder = rows.find((r) => {
        const p = norm(r.getAttribute('data-path') || '')
        return p === (s as string) || p.endsWith('/' + (s as string))
      })
      if (!folder) return 'no-folder'
      const btn = folder.querySelector('button[title="Expand"]') as HTMLElement | null
      const target = btn ?? folder.querySelector('div.flex-1') ?? folder
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return 'expanded'
    }, [name, seg]).catch(() => 'error' as const)
    if (state === 'clicked') return
    await page.waitForTimeout(1500)
  }
  throw new Error(`file row not found: ${seg}/${name}`)
}

test.describe('HTML preview tabs', () => {
  test('H5: 화면/소스 전환 + sandbox + 타확장자 불변', async ({ browser }: { browser: Browser }) => {
    const seg = `h5-${Date.now().toString(36)}`
    // 레포로 등록해야 트리에 뜬다 (c5-1 mkRepo 패턴).
    const mk = await fetch(`${backendBase()}/api/repos`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ localPath: seg }),
    }).then((r) => r.json())
    expect((mk as any)?.id, 'repo created').toBeTruthy()
    const dir = path.join(workspaceDir(), 'repos', seg)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'page.html'), HTML)
    fs.writeFileSync(path.join(dir, 'h5-style.css'), CSS)
    fs.writeFileSync(path.join(dir, 'h5-dot.png'), PNG_1PX)
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    try {
      await gotoApp(page)
      await openRow(page, seg, 'page.html')
      // 화면 탭: iframe이 보이고 src가 html-view다.
      const frame = page.getByTestId('html-preview-frame')
      await expect(frame).toBeVisible({ timeout: 30000 })
      const src = await frame.getAttribute('src')
      expect(src ?? '').toContain('/api/html-view?path=')
      // sandbox에 allow-same-origin이 없다.
      const sandbox = (await frame.getAttribute('sandbox')) ?? ''
      const tokens = sandbox.split(/\s+/).filter(Boolean)
      expect(tokens).toContain('allow-scripts')
      expect(tokens).not.toContain('allow-same-origin')
      // 상대 리소스가 에셋 엔드포인트로 서빙된다 (iframe과 같은 base).
      const css = await page.request.get(`${backendBase()}/api/html-view/asset/${seg}/h5-style.css`)
      expect(css.ok()).toBe(true)
      const img = await page.request.get(`${backendBase()}/api/html-view/asset/${seg}/h5-dot.png`)
      expect(img.ok()).toBe(true)
      // 소스 탭: 원문 텍스트가 보인다.
      await page.getByTestId('html-preview-tab-source').click({ timeout: 10000 })
      await expect(page.getByTestId('preview-container')).toContainText('H5-MARKER', { timeout: 10000 })
      expect(await page.evaluate(() => localStorage.getItem('html-preview-tab'))).toBe('source')
      // 화면 탭으로 복귀.
      await page.getByTestId('html-preview-tab-screen').click({ timeout: 10000 })
      await expect(page.getByTestId('html-preview-frame')).toBeVisible({ timeout: 10000 })
      // 회귀: xlsx 미리보기에 html 탭이 없다 (시트는 이미 열려 있음).
      await openRow(page, 'collab-e2e', 'probe-seeded-before-server.xlsx', false)
      await page.waitForTimeout(3000)
      await expect(page.getByTestId('html-preview-frame')).toHaveCount(0)
      await expect(page.getByTestId('html-preview-tab-screen')).toHaveCount(0)
    } finally {
      await ctx.close().catch(() => {})
    }
  })
})
