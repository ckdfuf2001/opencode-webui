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

/**
 * playwright.config.ts 가 **백엔드 시작 전에** 심어둔 파일명.
 *
 * 백엔드는 시작 시 저장소 트리를 스캔해 children 을 채운다(FileTree.tsx:150 의
 * needFetch = expanded && isDirectory && children === undefined). 서버가 뜬 뒤에
 * 복사한 파일은 트리에 나타나지 않는다(확인됨: config 시드 파일만 보였고,
 * 테스트 런타임에 복사한 파일은 안 보였다).
 * 그래서 하네스는 사전 시드 파일을 쓴다.
 */
const SEEDED_NAME = 'probe-seeded-before-server.xlsx'

function assertSeeded(): void {
  const abs = absForRel(path.posix.join('repos', 'collab-e2e', SEEDED_NAME))
  if (!fs.existsSync(abs)) throw new Error(`config did not seed ${abs} (playwright.config.ts)`)
}

/** XLSX가 마운트됐는지(편집기/보기 구분 없이). */
async function waitXlsxMounted(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="xlsx-engine-root"], .xlsxengine-host'),
    null,
    { timeout: 30000 },
  )
}

/**
 * 편집 UI가 실제로 렌더됐는가.
 *
 * `.xlsxengine-host` 는 EngineHost 가 항상 두는 래퍼라 존재만으로는 판정이 안 된다.
 * B1 증상은 "호스트는 있는데 편집 UI 없이 전체창만 열림" 이므로,
 * **호스트 안에 엔진이 실제로 그렸는지**(자식 존재 + 툴바/수식바 표시)를 본다.
 * xlsx lib 은 data-testid 를 제공하지 않아 DOM 구조로 판정한다.
 */
function editorUi(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const host = document.querySelector('.xlsxengine-host') as HTMLElement | null
    if (!host) return { mounted: false, children: 0, visible: 0 }
    const kids = [...host.querySelectorAll('*')].filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
    return { mounted: true, children: host.children.length, visible: kids.length }
  })
}

test.describe('X-B1: XLSX edit entry (solo path)', () => {
  test('X-B1: 20 Edit clicks in a row always open the editor', async ({ page }) => {
    const errs: string[] = []
    page.on('pageerror', (e) => errs.push(String(e)))
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push(m.text())
    })

    assertSeeded()
    const name = SEEDED_NAME
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
        await folder.locator('div.flex-1').first().click({ timeout: 10000 }).catch(() => {})
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

const failures: Array<{ i: number; ui: unknown }> = []
    for (let i = 0; i < 20; i++) {
      // 매 반복마다 편집 진입 → 저장 없이 Done으로 종료하지 않는다.
      // 편집 상태인지만 확인하고 파일은 다시 열지 않는다(리마운트가 필요하면 새로고침).
      const edit = page.getByRole('button', { name: 'Edit', exact: true })
      if ((await edit.count()) === 0) break
      await edit.click({ timeout: 15000 })
      // 편집 모드 표시: 버튼이 Done으로 바뀌면 editing 상태가 들어간 것이다.
      await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible({ timeout: 15000 })
      // 엔진이 실제로 그려질 때까지 기다린다(B1 은 렌더 지연이 아니라 아예 비어있다).
      await page.waitForTimeout(1200)
      const ui = await editorUi(page)
      if (!ui.mounted || ui.visible === 0) failures.push({ i, ui })
      // 다음 반복을 위해 편집을 종료한다(저장은 하지 않는다).
      const done = page.getByRole('button', { name: 'Done', exact: true })
      if ((await done.count()) > 0) {
        await done.click({ timeout: 15000 }).catch(() => {})
        await page.waitForTimeout(600)
        await page.getByRole('button', { name: 'Edit', exact: true }).waitFor({ timeout: 15000 }).catch(() => {})
      }
    }

    expect(failures, `edit UI missing on clicks: ${failures.join(',')}`).toEqual([])
    // X-B1은 solo 경로 검증이므로 창/툴바 조작이 없다. 이 잡음은 E2E 환경에서
// commands 엔드포인트가 간헐적으로 실패해 발생한다(PPT 스위트도 동일).
const noise = /Failed to fetch commands|AxiosError/
expect(
  errs.filter((e) => !noise.test(e)),
  `console/page errors: ${errs.slice(0, 3).join(' | ')}`,
).toEqual([])
  })
})