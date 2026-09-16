import { Hono } from 'hono'
import { historyReasoningModels } from '../services/session-message-db'
import { logger } from '../utils/logger'

export function createSessionModelCheckRoutes() {
  const app = new Hono()

  // GET /api/session-model-check/:sessionId?provider=..&model=..
  // 모델 스위치 전 오염 검사: 히스토리에 목표 모델과 다른 모델의 reasoning이
  // 있으면 스위치 후 encrypted_content 400이 날 수 있어 경고를 돌려준다.
  // 차단하지 않는다 — 최종 선택은 사용자 몫 (프론트 다이얼로그에서 확인).
  app.get('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    const provider = (c.req.query('provider') || '').trim()
    const model = (c.req.query('model') || '').trim()
    try {
      const stats = await historyReasoningModels(sessionId)
      if (!stats) return c.json({ error: 'message store unavailable' }, 503)
      const others = provider && model
        ? stats.filter((s) => !(s.providerID === provider && s.modelID === model))
        : []
      return c.json({
        risk: others.length > 0,
        historyModels: stats,
        foreignModels: others,
        target: provider && model ? { providerID: provider, modelID: model } : null,
      })
    } catch (e) {
      logger.error('session model check failed:', e)
      return c.json({ error: (e as Error)?.message ?? String(e) }, 500)
    }
  })

  return app
}
