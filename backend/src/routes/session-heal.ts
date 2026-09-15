import { Hono } from 'hono'
import { opencodeServerManager } from '../services/opencode-single-server'
import { ensureServerAuth } from '../services/opencode-auth'
import { healAbnormalTailIfNeeded } from '../services/reasoning-heal'
import { requeueStuckItems } from '../services/chat-queue'
import { logger } from '../utils/logger'

export function createSessionHealRoutes() {
  const app = new Hono()

  // POST /api/session-heal/:sessionId?directory=...
  // healable 꼬리(mismatch·aborted·ghost·empty)만 마지막 user부터 잘라내고 1회 정리.
  // 결제·쿼터·기타 오류는 프롬프트 보존을 위해 손대지 않는다 (healable=false).
  // 프론트 "정리" 버튼 전용 — 신선도 무관 force.
  app.post('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    const directory = c.req.query('directory') || undefined
    try {
      const base = opencodeServerManager.getUrl()
      // 생성 중 세션의 꼬리를 자르면 live 턴이 날아간다 — busy면 409로 거부.
      // (프론트도 isStreaming을 보지만, 다른 탭·레이스 대비 서버에서 최종 차단)
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
      const result = await healAbnormalTailIfNeeded(base, sessionId, directory, { force: true })
      if (result.healed) {
        // DB 꼬리만 자르면 반쪽 복구다: failed 고정된 큐 헤드가 뒤의 모든 전송을
        // 영구 봉쇄하므로, 되돌리고 즉시 flush해야 다음 전송이 나간다.
        let requeued = 0
        try {
          requeued = requeueStuckItems(sessionId).requeued
        } catch (e) {
          logger.warn(`session heal: requeue failed for ${sessionId}:`, e)
        }
        return c.json({ healed: true, ...result, requeued })
      }
      return c.json({ healed: false, reason: result.reason ?? 'history clean', kind: result.kind, healable: result.healable ?? false, suggestedModel: result.suggestedModel })
    } catch (e) {
      logger.error('session heal failed:', e)
      return c.json({ healed: false, reason: (e as Error)?.message ?? String(e) }, 500)
    }
  })

  return app
}
