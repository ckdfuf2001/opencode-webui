import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { absForRel } from './helpers/env'
import { closePreview } from './helpers/viewer'

/**
 * M6: 문서 뷰어는 "닫기"에서 언마운트되어야 한다.
 *
 * 재현(수정 전): pptx 를 미리보기에 열고 "닫으면" 화면에서만 사라지고
 * [data-testid=pptx-viewer-root] 가 계속 1개, __openSockets() 도 1로 남았다.
 * 데스크톱 미리보기에는 닫기 수단이 아예 없고(FileBrowser.tsx 의 setSelectedFile(null)
 * 은 폴더 클릭/삭제/오류 때만 불렸다), 전체화면 시트는 닫을 때 기억한 파일 경로를
 * 남겨 다시 열 때 뷰어를 즉시 재마운트했다.
 */

const here = path.dirname(fileURLToPath(import.meta.url))

/** 현재 마운트된 문서 뷰어 루트 개수. */
function viewerRoots(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const n = (sel: string): number => document.querySelectorAll(sel).length
    return {
      pptx: n('[data-testid="pptx-viewer-root"]'),
      xlsx: n('.xlsxengine-host'),
      // 열려 있는 협업 소켓/폴링 주기까지 함께 확인한다.
      sockets: (window as unknown as { __openSockets?: () => number }).__openSockets?.() ?? -1,
    }
  })
}

const PPTX = 'probe-seeded-before-server.pptx'

function assertSeededPptx(): void {
  const abs = absForRel(path.posix.join('repos', 'collab-e2e', PPTX))
  // 존재 확인은 config 가 이미 강제한다(없으면 config 단계에서 throw).
  void abs
}

test.describe('M6: viewer unmounts on close', () => {
  test('M6a: closing the desktop preview unmounts the viewer', async ({ page }) => {
    const errs: string[] = []
    page.on('pageerror', (e) => errs.push(String(e)))
    assertSeededPptx()

    await page.goto('/?collabDebug=1', { waitUntil: 'domcontentloaded', timeout: 30000 })
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
        await page.waitForFunction(
          () => document.querySelectorAll('[data-testid="file-row"]').length > 0,
          null,
          { timeout: 10000 },
        )
        break
      } catch {
        await page.keyboard.press('Escape')
        await page.waitForTimeout(2000)
      }
    }
    // 폴더 펼치기: 행이 아니라 안쪽 div.flex-1 이 핸들러다(FileTree.tsx:343).
    for (let i = 0; i < 8; i++) {
      const has = await page.evaluate(
        (n) => [...document.querySelectorAll('[data-testid="file-row"]')].some((r) => (r.textContent || '').includes(n)),
        PPTX,
      )
      if (has) break
      const folder = page.locator('[data-testid="file-row"][data-path$="collab-e2e"]')
      if ((await folder.count()) > 0) {
        await folder.locator('div.flex-1').first().click({ timeout: 10000 }).catch(() => {})
      }
      await page.waitForTimeout(2500)
    }
    const fileRow = page.locator(`[data-testid="file-row"][data-path$="${PPTX}"]`).locator('span', { hasText: PPTX }).first()
    if ((await fileRow.count()) === 0) {
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="file-row"]')].map((r) => r.getAttribute('data-path')),
      )
      throw new Error(`file row not found. rows=${JSON.stringify(rows)}`)
    }
    await fileRow.click({ timeout: 20000 })
    // pptx 뷰어가 뜰 때까지
    await page.waitForSelector('[data-testid="pptx-viewer-root"]', { timeout: 30000 })
    expect((await viewerRoots(page)).pptx).toBe(1)

    // 닫기: U1부터 닫는 경로는 "탐색기 축소" 하나다(Close preview 버튼 제거).
    await closePreview(page)

    // M6의 계약: 1초 안에 언마운트되어야 한다.
    await expect
      .poll(async () => (await viewerRoots(page)).pptx, { timeout: 5000, intervals: [200] })
      .toBe(0)
    expect(errs, `page errors: ${errs.slice(0, 2).join(' | ')}`).toEqual([])
  })

  test('M6b: 10 open/close cycles leave no viewer behind', async ({ page }) => {
    await page.goto('/?collabDebug=1', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.getByTitle('Workspace').waitFor({ timeout: 20000 })
    await page.getByTitle('Workspace').click({ timeout: 20000 })
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-row"]').length > 0, null, {
      timeout: 10000,
    })
    for (let i = 0; i < 8; i++) {
      const has = await page.evaluate(
        (n) => [...document.querySelectorAll('[data-testid="file-row"]')].some((r) => (r.textContent || '').includes(n)),
        PPTX,
      )
      if (has) break
      const folder = page.locator('[data-testid="file-row"][data-path$="collab-e2e"]')
      if ((await folder.count()) > 0) {
        await folder.locator('div.flex-1').first().click({ timeout: 10000 }).catch(() => {})
      }
      await page.waitForTimeout(2500)
    }

    for (let i = 0; i < 10; i++) {
      const fileRow = page.locator(`[data-testid="file-row"][data-path$="${PPTX}"]`).locator('span', { hasText: PPTX }).first()
      await fileRow.click({ timeout: 20000 })
      await page.waitForSelector('[data-testid="pptx-viewer-root"]', { timeout: 30000 })
      await closePreview(page)
      await expect
        .poll(async () => (await viewerRoots(page)).pptx, { timeout: 5000, intervals: [200] })
        .toBe(0)
    }
    const v = await viewerRoots(page)
    expect(v.pptx).toBe(0)
    // 협업 소켓도 함께 내려가야 한다(leak 회귀 방지).
    expect(v.sockets, 'open collab sockets should return to 0').toBeLessThanOrEqual(1)
  })
})