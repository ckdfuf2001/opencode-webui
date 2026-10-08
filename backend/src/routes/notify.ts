import { Hono } from 'hono'
import type { Database } from 'bun:sqlite'
import {
  deleteNotifyOverride,
  getNotifyOverride,
  listNotifyOverrides,
  upsertNotifyOverride,
  type NotifyOverridePatch,
  type NotifyScope,
} from '../db/notify-queries'
import { showOsToast } from '../services/os-notify'
import { logger } from '../utils/logger'

/**
 * 알림 오버라이드 (세션/레포별 push·sound·skill 설정).
 * 프론트 localStorage에서 이전한 단일 진실 통로 — 백단 OS 알림이 push 값을 본다.
 */
export function createNotifyRoutes(db: Database) {
  const app = new Hono()

  const parseScope = (scope: string): NotifyScope | null =>
    scope === 'session' || scope === 'repo' ? scope : null

  const parsePatch = (body: Record<string, unknown>): NotifyOverridePatch => {
    const patch: NotifyOverridePatch = {}
    const norm = (v: unknown): boolean | null | undefined => {
      if (v === undefined) return undefined
      if (v === null) return null
      if (typeof v === 'boolean') return v
      if (v === 1 || v === '1' || v === 'true') return true
      if (v === 0 || v === '0' || v === 'false') return false
      return undefined
    }
    const pushEnabled = norm(body.pushEnabled)
    if (pushEnabled !== undefined) patch.pushEnabled = pushEnabled
    const soundEnabled = norm(body.soundEnabled)
    if (soundEnabled !== undefined) patch.soundEnabled = soundEnabled
    const soundOnCancelEnabled = norm(body.soundOnCancelEnabled)
    if (soundOnCancelEnabled !== undefined) patch.soundOnCancelEnabled = soundOnCancelEnabled
    const skillAutoEnabled = norm(body.skillAutoEnabled)
    if (skillAutoEnabled !== undefined) patch.skillAutoEnabled = skillAutoEnabled
    const skillReviewEnabled = norm(body.skillReviewEnabled)
    if (skillReviewEnabled !== undefined) patch.skillReviewEnabled = skillReviewEnabled
    return patch
  }

  // GET /api/notify/overrides — 전체 (프론트 bulk 로드용)
  app.get('/overrides', (c) => {
    try {
      return c.json(listNotifyOverrides(db))
    } catch (error) {
      logger.error('Failed to list notify overrides:', error)
      return c.json({ error: 'Failed to list notify overrides' }, 500)
    }
  })

  // GET /api/notify/overrides/:scope/:target
  app.get('/overrides/:scope/:target', (c) => {
    try {
      const scope = parseScope(c.req.param('scope'))
      if (!scope) return c.json({ error: 'Invalid scope' }, 400)
      return c.json(getNotifyOverride(db, scope, c.req.param('target')) ?? null)
    } catch (error) {
      logger.error('Failed to get notify override:', error)
      return c.json({ error: 'Failed to get notify override' }, 500)
    }
  })

  // PUT /api/notify/overrides/:scope/:target — 부분 업데이트 (null=상속)
  app.put('/overrides/:scope/:target', async (c) => {
    try {
      const scope = parseScope(c.req.param('scope'))
      if (!scope) return c.json({ error: 'Invalid scope' }, 400)
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
      const updated = upsertNotifyOverride(db, scope, c.req.param('target'), parsePatch(body))
      return c.json(updated)
    } catch (error) {
      logger.error('Failed to update notify override:', error)
      return c.json({ error: 'Failed to update notify override' }, 500)
    }
  })

  // DELETE /api/notify/overrides/:scope/:target — 상속으로 리셋
  app.delete('/overrides/:scope/:target', (c) => {
    try {
      const scope = parseScope(c.req.param('scope'))
      if (!scope) return c.json({ error: 'Invalid scope' }, 400)
      deleteNotifyOverride(db, scope, c.req.param('target'))
      return c.json({ ok: true })
    } catch (error) {
      logger.error('Failed to delete notify override:', error)
      return c.json({ error: 'Failed to delete notify override' }, 500)
    }
  })

  // POST /api/notify/test — OS 토스트 테스트 (설정 화면용)
  app.post('/test', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { title?: unknown; body?: unknown }
      const title = typeof body.title === 'string' && body.title ? body.title.slice(0, 200) : '테스트 알림'
      const text = typeof body.body === 'string' && body.body ? body.body.slice(0, 400) : 'PC 알림이 정상적으로 동작합니다.'
      const ok = showOsToast(title, text, { path: '/' })
      return c.json({ ok })
    } catch (error) {
      logger.error('Failed to send test notification:', error)
      return c.json({ error: 'Failed to send test notification' }, 500)
    }
  })

  return app
}
