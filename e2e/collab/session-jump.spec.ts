import { test, expect, type Browser, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { backendBase, workspaceDir } from './helpers/env'
import { gotoApp } from './helpers/viewer'
import { ADA, seedUser } from './helpers/users'

/**
 * F1-2: 검색 3단계 펼침 (SessionJumpDialog).
 * - 기본: 사용자 메시지만 + "응답에서 일치" 배지.
 * - 클릭: 그 턴의 마지막 assistant 응답을 펼친다.
 * - 상세: 턴 전체(도구 호출 포함)를 그때 불러온다. 상세 전에는 DOM에 없다.
 *
 * 인덱스는 하네스에서 FTS 테이블에 직접 심는다 (e2e의 reindex 경로는
 * node 호환 sqlite에서 실패하므로 우회 — 제품 코드는 그대로 둔다).
 */
const USER_TEXT = 'F2MARKER txt 목록 보여줘'
const TOOL_TEXT = '[tool:glob]\nf2tooltarget f2-tool-file-xyz.txt\nf2-notes.md'
const ASST_TEXT = '찾은 파일:\n- f2-tool-file-xyz.txt\n- f2-notes.md'
const QUERY = 'f2tooltarget'

async function seedFts(sessionId: string): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path.join(workspaceDir(), 'e2e.db'))
  try {
    db.exec('PRAGMA busy_timeout = 10000')
    db.prepare('DELETE FROM session_messages_fts WHERE session_id = ?').run(sessionId)
    const ins = db.prepare(
      'INSERT INTO session_messages_fts (text, session_id, message_id, role, repo_id, turn_index, ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    const now = Date.now()
    ins.run(USER_TEXT, sessionId, 'f2-u1', 'user', null, 0, now)
    ins.run(TOOL_TEXT, sessionId, 'f2-a1', 'assistant', null, 1, now + 1)
    ins.run(ASST_TEXT, sessionId, 'f2-a2', 'assistant', null, 2, now + 2)
  } finally {
    db.close()
  }
}

async function openJumpDialog(page: Page): Promise<void> {
  await page.getByTitle('More actions (search / jump / download)').first().click({ timeout: 15000 })
  await page.getByRole('menuitem', { name: /Search \/ Go to message/ }).click({ timeout: 10000 })
  await expect(page.getByRole('dialog')).toContainText(/Search \/ Go to message/, { timeout: 15000 })
}

test.describe('session jump stages', () => {
  test('F2: 사용자만 → 마지막 응답 → 상세(도구 호출 포함)', async ({ browser }: { browser: Browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    try {
      const seg = `f2-${Date.now().toString(36)}`
      const mk = await page.request.post(`${backendBase()}/api/repos`, { data: { localPath: seg }, timeout: 60000 }).then((r) => r.json())
      const repoId = (mk as { id: number }).id
      expect(repoId, 'repo created').toBeTruthy()
      fs.mkdirSync(path.join(workspaceDir(), 'repos', seg), { recursive: true })
      await gotoApp(page)
      await page.goto(`/repos/${repoId}?collabDebug=1&e2e=1`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.getByRole('button', { name: 'Session', exact: true }).first().click({ timeout: 30000 })
      await page.waitForURL(/\/sessions\/[^/?]+/, { timeout: 30000 })
      const sessionId = page.url().split('/').pop()!.split('?')[0]!
      await page.locator('textarea').first().waitFor({ timeout: 60000 })
      await openJumpDialog(page)
      const seenUrls: string[] = []
      page.on('request', (r) => {
        if (r.url().includes('/api/search/messages') && r.method() === 'GET') seenUrls.push(r.url())
      })
      const dialog = page.getByRole('dialog')
      // 시드가 reindex와 경합할 수 있어 와일드카드로 가시성 확정 후 진행한다.
      // reindex가 뒤늦게 지울 수 있으니 2회 연속으로 확인한다.
      let stableHits = 0
      await expect.poll(async () => {
        await seedFts(sessionId)
        const all = (await page.request.get(`${backendBase()}/api/search/messages?q=*&sessionId=${encodeURIComponent(sessionId)}`).then((r) => r.json()).catch(() => ({ hits: [] }))) as { hits?: unknown[] }
        const ui = (await page.request.get(`${backendBase()}/api/search/messages?q=${QUERY}&k=50&offset=0&sessionId=${encodeURIComponent(sessionId)}`).then((r) => r.json()).catch(() => ({ hits: [] }))) as { hits?: Array<{ messageId?: string }> }
        console.log(`[f2] wild=${(all.hits ?? []).length} term=${(ui.hits ?? []).length}`)
        const n = (all.hits ?? []).length
        stableHits = n >= 3 ? stableHits + 1 : 0
        return stableHits
      }, { timeout: 90000, intervals: [2000] }).toBeGreaterThanOrEqual(2)
      await dialog.locator('input[placeholder*="Search"]').fill(QUERY)
      const inBrowser = await page.evaluate(async ({ q, sid }) => {
        try {
          const r = await fetch(`/api/search/messages?q=${encodeURIComponent(q)}&k=50&offset=0&sessionId=${encodeURIComponent(sid)}`)
          const j = await r.json()
          return `status=${r.status} hits=${(j.hits ?? []).length}`
        } catch (e) {
          return 'ERR:' + String(e).slice(0, 120)
        }
      }, { q: QUERY, sid: sessionId })
      console.log('[f2] in-browser=' + inBrowser)
      await page.waitForTimeout(3000)
      // eslint-disable-next-line no-console
      console.log('[f2] ui-requests=' + JSON.stringify(seenUrls))
      const turnRow = dialog.getByTestId('jump-turn-row').first()
      await expect(turnRow).toBeVisible({ timeout: 30000 })
      // 0단계: 사용자 메시지만 보이고 "응답에서 일치" 배지가 있다.
      await expect(turnRow).toContainText(USER_TEXT, { timeout: 10000 })
      await expect(turnRow.getByText('응답에서 일치')).toBeVisible({ timeout: 10000 })
      // 상세 전에는 중간 내용이 DOM에 없다.
      await expect(dialog.getByTestId('jump-turn-detail')).toHaveCount(0)
      await expect(dialog.getByText('[tool:glob]', { exact: false })).toHaveCount(0)
      // 1단계: 클릭하면 마지막 assistant 응답이 보인다.
      await turnRow.click({ timeout: 10000 })
      await expect(dialog.getByTestId('jump-turn-last')).toBeVisible({ timeout: 10000 })
      await expect(dialog.getByTestId('jump-turn-last')).toContainText('f2-tool-file-xyz.txt')
      // 2단계: 상세를 누르면 도구 호출 포함 전체가 보인다.
      await dialog.getByTestId('jump-turn-detail-btn').first().click({ timeout: 10000 })
      const detail = dialog.getByTestId('jump-turn-detail')
      await expect(detail).toBeVisible({ timeout: 15000 })
      await expect(detail).toContainText('[tool:glob]')
      await expect(detail).toContainText('f2-tool-file-xyz.txt')
    // 이동 버튼: 다이얼로그가 닫힌다 (기존 점프 동작 유지).
    await turnRow.getByText('이동', { exact: true }).click({ timeout: 10000 })
    await expect(dialog).toBeHidden({ timeout: 10000 })
    } finally {
      await ctx.close().catch(() => {})
    }
  })
})
