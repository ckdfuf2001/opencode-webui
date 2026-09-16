import { Hono } from 'hono'
import { opencodeServerManager } from '../services/opencode-single-server'
import { ensureServerAuth } from '../services/opencode-auth'
import { healMismatchTailManual } from '../services/reasoning-heal'
import { logger } from '../utils/logger'

export function createSessionHealRoutes() {
  const app = new Hono()

  // POST /api/session-heal/:sessionId?directory=...
  // 수동 백업용 narrow 정리: 꼬리가 reasoning/security 암호문 거부(mismatch)일
  // 때만 마지막 user부터 잘라내고 sweep한다. 그 외(clean·결제·쿼터 등)는 거부.
  // 자동 복구가 실패했을 때의 비상 출구 — 프론트 버튼/팝업 없음, API 직접 호출용.
  app.post('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    const directory = c.req.query('directory') || undefined
    try {
      const base = opencodeServerManager.getUrl()
      // 생성 중 세션의 꼬리를 자르면 live 턴이 날아간다 — busy면 409로 거부.
      try {
        const dirQs = directory ? `?directory=${encodeURIComponent(directory)}` : ''
        const statusRes = await fetch(`${base}/session/status${dirQs}`, {
          headers: ensureServerAuth({}),
          signal: AbortSignal.timeout(5_000),
        })
        if (statusRes.ok) {
          const map = (await statusRes.json()) as Record<string, { type?: string }>
          if (map[sessionId]?.type === 'busy') {
            return c.json({ healed: false, reason: 'session busy — 생성 중에는 정리할 수 없어요', kind: 'busy', healable: false }, 409)
          }
        }
      } catch {
        // 상태 조회 실패는 막지 않는다 (opencode가 느린 경우 정리 자체가 복구 수단)
      }
      const result = await healMismatchTailManual(base, sessionId, directory)
      if (result.healed && directory) {
        // DB만 자르면 opencode 메모리 캐시가 오염 part를 그대로 보내므로
        // 다음 전송 전에 인스턴스를 dispose해 캐시를 비운다.
        try {
          const reloaded = await opencodeServerManager.reloadAndVerify(directory)
          return c.json({ ...result, instanceReloaded: reloaded })
        } catch (e) {
          logger.warn(`session heal: instance reload threw for ${sessionId}:`, e)
          return c.json({ ...result, instanceReloaded: false })
        }
      }
      return c.json(result)
    } catch (e) {
      logger.error('session heal failed:', e)
      return c.json({ healed: false, reason: (e as Error)?.message ?? String(e) }, 500)
    }
  })

  return app
}
