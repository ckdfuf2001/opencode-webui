import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { absForRel } from './helpers/env'

/**
 * X-B1: Chrome에서 XLSX Edit을 누르면 편집 UI 없이 전체창만 열리는 버그.
 *
 * 원인(B1-b, 저장소 근거):
 * - DocumentPreview.tsx:452 의 officeSaveDone 핸들러가 전역 이벤트라 다른 뷰어의
 *   저장 완료에도 editing=false 로 내려간다.
 * - officeSaveRequest 핸들러가 editing 과 무관하게 항상 등록되어 있었다.
 * 수정: 이벤트에 path를 붙이고, 그 경로가 ours일 때만 반영 + 편집 중에만 요청 수신.
 *
 * 통과 기준: Edit 클릭 20회 반복, 매회 편집 UI가 보인다. 실패 0.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(here, 'fixtures', 'collab-features.xlsx')

/** fixture를 E2E 워크스페이스(repos/collab-e2e 아래)에 고유 이름으로 복사한다. */
function seedFixture(slug: string): { rel: string; name: string } {
  const stamp = Date.now().toString(36)
  const rel = path.posix.join('repos', 'collab-e2e', `${slug}-${stamp}.xlsx`)
  const abs = absForRel(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.copyFileSync(FIXTURE, abs)
  return { rel, name: path.basename(rel) }
}

/** XLSX가 마운트됐는지(편집기/보기 구분 없이). */
async function waitXlsxMounted(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="xlsx-engine-root"], .xlsxengine-host'),
    null,
    { timeout: 30000 },
  )
}

/** 편집 UI(리본/툴바/수식바)가 실제로 보이는가. */
function editorUi(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const host = document.querySelector('.xlsxengine-host') as HTMLElement | null
    if (!host) return { mounted: false, toolbars: 0, visible: false }
    // 툴바/수식바 후보를 넓게 잡는다(클래스명은 lib 소유라 안정적이지 않다).
    const bars = [...host.querySelectorAll('[role="toolbar"], [data-testid*="toolbar"], formBar, .formula-bar, [class*="formula"]')]
    const visible = bars.filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
    return { mounted: true, toolbars: bars.length, visible: visible.length }
  })
}

test.describe('X-B1: XLSX edit entry (solo path)', () => {
  test('X-B1: 20 Edit clicks in a row always open the editor', async ({ page }) => {
    const errs: string[] = []
    page.on('pageerror', (e) => errs.push(String(e)))
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push(m.text())
    })

    const { name } = seedFixture('xb1')
    await page.goto('/?collabDebug=1', { waitUntil: 'domcontentloaded', timeout: 30000 })

    // 워크스페이스를 열고 파일을 연다 (collab 없이 solo 경로).
    // PPT openFile과 같은 재시도 구조: 백엔드 스캔이 늦을 수 있다.
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
      if (i === 4) throw new Error('workspace sheet has no rows after retries')
    }
    // 폴더 펼치기 (PPT openFile과 동일 구조: 폴더 행 자체는 안 눌리고 안쪽 div가 대상)
    for (let i = 0; i < 8; i++) {
      const has = await page.evaluate(
        (n) => [...document.querySelectorAll('[data-testid="file-row"]')].some((r) => (r.textContent || '').includes(n)),
        name,
      )
      if (has) break
      const folder = page.locator('[data-testid="file-row"][data-path$="collab-e2e"]')
      if ((await folder.count()) > 0) {
        // 행 바깥 div에는 핸들러가 없고 안쪽 div에 onClick이 있다(PPT openFile 주석 참고).
        // span 클릭이 통하지 않아 행 자체에 실제 클릭을 시도한다.
        await folder.first().click({ timeout: 10000, force: true }).catch(() => {})
      } else {
        await page.evaluate(() => {
          const rows = [...document.querySelectorAll('[data-testid="file-row"]')]
          const target =
            rows.find((r) => (r.getAttribute('data-path') || '').replace(/\\/g, '/').endsWith('collab-e2e')) ||
            rows.find((r) => !(r.getAttribute('data-path') || '').includes('.'))
          const inner = target?.querySelector('div.flex-1') ?? target?.querySelector('div')
          inner?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        })
      }
      await page.waitForTimeout(2500)
    }
    await page.locator(`[data-testid="file-row"][data-path$="${name}"]`).locator('span', { hasText: name }).first().click({
      timeout: 20000,
    })
    await waitXlsxMounted(page)

    const failures: number[] = []
    for (let i = 0; i < 20; i++) {
      // 매 반복마다 편집 진입 → 저장 없이 Done으로 종료하지 않는다.
      // 편집 상태인지만 확인하고 파일은 다시 열지 않는다(리마운트가 필요하면 새로고침).
      const edit = page.getByRole('button', { name: 'Edit', exact: true })
      if ((await edit.count()) === 0) break
      await edit.click({ timeout: 15000 })
      // 편집 모드 표시: 버튼이 Done으로 바뀌면 editing 상태가 들어간 것이다.
      await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible({ timeout: 15000 })
      await page.waitForTimeout(400)
      const ui = await editorUi(page)
      if (!ui.visible) failures.push(i)
      // 다음 반복을 위해 편집을 종료한다(저장은 하지 않는다).
      const done = page.getByRole('button', { name: 'Done', exact: true })
      if ((await done.count()) > 0) {
        await done.click({ timeout: 15000 }).catch(() => {})
        await page.waitForTimeout(600)
        await page.getByRole('button', { name: 'Edit', exact: true }).waitFor({ timeout: 15000 }).catch(() => {})
      }
    }

    expect(failures, `edit UI missing on clicks: ${failures.join(',')}`).toEqual([])
    expect(errs, `console/page errors: ${errs.slice(0, 3).join(' | ')}`).toEqual([])
  })
})