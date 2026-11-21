import { test, expect, type Browser } from '@playwright/test'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AddressInfo } from 'node:net'
import { backendBase, workspaceDir } from './helpers/env'
import { gotoApp } from './helpers/viewer'
import { ADA, seedUser } from './helpers/users'

/**
 * F1-1: 모델 새로고침 (커스텀 provider + stub /models).
 * - 헤더 새로고침 → 없어진 모델이 `--` + "제공 중지" 행으로 남는다.
 * - 사용 중(기본값) 모델이 없어지면 경고가 뜬다.
 * - 없어진 행만 삭제 가능 (커스텀은 config에서 삭제, 카탈로그는 스냅샷에서만).
 * - 다시 열면 삭제된 모델이 사라진다.
 */
test.describe('model refresh', () => {
  test('F1: 새로고침→없어진 모델 표시·삭제', async ({ browser }: { browser: Browser }) => {
    // stub /models 서버 (응답 목록을 바꿀 수 있다).
    let stubIds = ['f1m1', 'f1m2']
    const stub = http.createServer((req, res) => {
      if (req.url === '/models' || req.url?.startsWith('/models?')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: stubIds.map((id) => ({ id })) }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
    const stubPort = (stub.address() as AddressInfo).port
    const stubBase = `http://127.0.0.1:${stubPort}`
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctx, ADA)
    const page = await ctx.newPage()
    try {
      // 키 저장 (재시작 없음).
      await page.request.post(`${backendBase()}/api/providers/f1stub/credentials`, { data: { apiKey: 'e2e-test-key' } })
      // 커스텀 provider는 DB에 직접 심는다 (HTTP 등록은 opencode를 재시작시켜 e2e가 깨진다).
      // 다이얼로그·refresh는 DB를 직접 읽으므로 재시작 없이 동작한다.
      {
        const db = new DatabaseSync(path.join(workspaceDir(), 'e2e.db'))
        try {
          db.exec('PRAGMA busy_timeout = 10000')
          const row = db.prepare("SELECT config_content as c FROM opencode_configs WHERE user_id = 'default' AND config_name = 'default'").get() as { c: string } | undefined
          const content = row ? JSON.parse(row.c) : {}
          const provider = (content.provider ?? {}) as Record<string, unknown>
          provider['f1stub'] = {
            name: 'F1 Stub', npm: '@ai-sdk/openai-compatible',
            options: { baseURL: stubBase },
            models: { f1m1: { name: 'f1m1' }, f1m2: { name: 'f1m2' } },
          }
          content.provider = provider
          const now = Date.now()
          const updated = db.prepare('UPDATE opencode_configs SET config_content = ?, updated_at = ? WHERE user_id = ? AND config_name = ?').run(JSON.stringify(content), now, 'default', 'default')
          if (updated.changes === 0) {
            db.prepare('INSERT INTO opencode_configs (user_id, config_name, config_content, is_default, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)').run('default', 'default', JSON.stringify(content), now, now)
          }
        } finally {
          db.close()
        }
      }
      // 레포+세션.
      const seg = `f1-${Date.now().toString(36)}`
      const mk = await page.request.post(`${backendBase()}/api/repos`, { data: { localPath: seg }, timeout: 60000 }).then((r) => r.json())
      const repoId = (mk as { id: number }).id
      expect(repoId, 'repo created').toBeTruthy()
      fs.mkdirSync(path.join(workspaceDir(), 'repos', seg), { recursive: true })
      await gotoApp(page)
      await page.goto(`/repos/${repoId}?collabDebug=1&e2e=1`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.getByRole('button', { name: 'Session', exact: true }).first().click({ timeout: 30000 })
      await page.waitForURL(/\/sessions\/[^/?]+/, { timeout: 30000 })
      // 기본값을 f1m2로 둔다 (없어지면 경고 대상).
      await page.request.patch(`${backendBase()}/api/settings`, { data: { preferences: { defaultModel: 'f1stub/f1m2' } } })
      // 다이얼로그 열기 (모델 버튼).
      const openDialog = async (): Promise<void> => {
        await page.getByRole('button', { name: /No model|Select model|^f1m/i }).first().click({ timeout: 30000 })
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 30000 })
      }
      await openDialog()
      const dialog = page.getByRole('dialog')
      // 1차 새로고침: 둘 다 정상 행.
      await dialog.getByTestId('model-refresh-all').click({ timeout: 10000 })
      await expect(dialog.getByText('f1m1', { exact: true }).first()).toBeVisible({ timeout: 60000 })
      await expect(dialog.getByText('f1m2', { exact: true }).first()).toBeVisible({ timeout: 60000 })
      // stub에서 f1m2 제거 후 2차 새로고침: -- 행 + 배지 + 경고.
      stubIds = ['f1m1']
      await dialog.getByTestId('model-refresh-all').click({ timeout: 10000 })
      const removedRow = dialog.locator('[data-testid="model-row-removed"]', { hasText: 'f1m2' })
      await expect(removedRow).toBeVisible({ timeout: 60000 })
      await expect(removedRow).toContainText('--')
      await expect(removedRow).toContainText('제공 중지')
      await expect(dialog.getByTestId('model-removed-warning')).toBeVisible({ timeout: 10000 })
      // 삭제: 커스텀이라 config에서도 지워진다 (2단 확인).
      await removedRow.getByTestId('model-delete-f1stub-f1m2').click({ timeout: 10000 })
      await removedRow.getByTestId('model-delete-confirm').click({ timeout: 10000 })
      await expect.poll(async () => {
        const cfg = await page.request.get(`${backendBase()}/api/settings/opencode-configs/default`).then((r) => r.json()).catch(() => null)
        const models = (cfg as any)?.content?.provider?.f1stub?.models ?? null
        return models && !('f1m2' in models) ? 'gone' : 'still'
      }, { timeout: 60000, intervals: [2000] }).toBe('gone')
      // 닫고 다시 열면 사라져 있다.
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden({ timeout: 10000 })
      await openDialog()
      await expect(page.getByRole('dialog').getByText('f1m2', { exact: true })).toHaveCount(0)
    } finally {
      await ctx.close().catch(() => {})
      stub.close()
    }
  })
})
