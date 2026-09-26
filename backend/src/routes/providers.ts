import { Hono } from 'hono'
import { z } from 'zod'
import type { Database } from 'bun:sqlite'
import { AuthService } from '../services/auth'
import { SetCredentialRequestSchema } from '../../../shared/src/schemas/auth'
import { logger } from '../utils/logger'

export function createProvidersRoutes(db: Database) {
  const app = new Hono()
  const authService = new AuthService()

  app.get('/credentials', async (c) => {
    try {
      const providers = await authService.list()
      return c.json({ providers })
    } catch (error) {
      logger.error('Failed to list provider credentials:', error)
      return c.json({ error: 'Failed to list provider credentials' }, 500)
    }
  })

  app.get('/:id/credentials/status', async (c) => {
    try {
      const providerId = c.req.param('id')
      const hasCredentials = await authService.has(providerId)
      return c.json({ hasCredentials })
    } catch (error) {
      logger.error('Failed to check credential status:', error)
      return c.json({ error: 'Failed to check credential status' }, 500)
    }
  })

  // 키 값 조회 — 키 설정 다이얼로그를 기존 값으로 프리필하기 위한 것.
  // (저장된 키를 편집 화면에 노출하므로 인증을 전제로 하는 배포에서는 주의)
  app.get('/:id/credentials', async (c) => {
    try {
      const providerId = c.req.param('id')
      const entry = await authService.get(providerId)
      const apiKey = typeof entry?.apiKey === 'string' ? entry.apiKey : null
      return c.json({ apiKey })
    } catch (error) {
      logger.error('Failed to read provider credentials:', error)
      return c.json({ error: 'Failed to read provider credentials' }, 500)
    }
  })

  // 커스텀 provider 의 모델 목록 조회.
  // openai 호환 엔드포인트의 GET {baseURL}/models 를 저장된 키로 호출한다.
  // config 에 models 를 미리 박아둔 경우가 아니라면(Add Provider 의 Models 칸을
  // 비운 경우) 이 경로가 없으면 opencode 는 모델을 하나도 모를 수 없다.
  app.get('/:id/models', async (c) => {
    try {
      const providerId = decodeURIComponent(c.req.param('id'))

      const row = db
        .query("SELECT config_content FROM opencode_configs WHERE user_id = 'default' AND is_default = 1")
        .get() as { config_content: string } | undefined
      if (!row) return c.json({ error: 'No default config' }, 404)

      let content: { provider?: Record<string, { options?: { baseURL?: string } }> }
      try {
        content = JSON.parse(row.config_content)
      } catch {
        return c.json({ error: 'Failed to parse config' }, 500)
      }
      const baseURL = content.provider?.[providerId]?.options?.baseURL
      if (!baseURL) {
        return c.json({ error: 'Provider has no baseURL' }, 400)
      }

      const entry = await authService.get(providerId)
      const apiKey = typeof entry?.apiKey === 'string' ? entry.apiKey : null
      if (!apiKey) {
        return c.json({ error: 'No API key stored for this provider' }, 400)
      }

      const res = await fetch(`${baseURL.replace(/\/+$/, '')}/models`, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        return c.json({ error: `Upstream responded ${res.status}`, models: [] }, 502)
      }
      const body = await res.json() as { data?: Array<{ id?: unknown }>; models?: Array<{ id?: unknown }> }
      const ids = [...(body.data ?? []), ...(body.models ?? [])]
        .map((m) => (typeof m?.id === 'string' ? m.id : ''))
        .filter(Boolean)
      // 중복 제거 (카탈로그에 같은 id 가 두 번 나오는 provider 가 있다)
      const models = [...new Set(ids)].map((id) => ({ id, name: id }))
      logger.info(`Fetched ${models.length} model(s) for provider '${providerId}' from ${baseURL}`)
      return c.json({ models })
    } catch (error) {
      logger.error('Failed to fetch provider models:', error)
      return c.json({ error: 'Failed to fetch provider models', models: [] }, 502)
    }
  })

  app.post('/:id/credentials', async (c) => {
    try {
      const providerId = c.req.param('id')
      const body = await c.req.json()
      const validated = SetCredentialRequestSchema.parse(body)
      
      await authService.set(providerId, validated.apiKey)
      return c.json({ success: true })
    } catch (error) {
      logger.error('Failed to set provider credentials:', error)
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid request data', details: error.issues }, 400)
      }
      return c.json({ error: 'Failed to set provider credentials' }, 500)
    }
  })

  app.delete('/:id/credentials', async (c) => {
    try {
      const providerId = c.req.param('id')
      await authService.delete(providerId)
      return c.json({ success: true })
    } catch (error) {
      logger.error('Failed to delete provider credentials:', error)
      return c.json({ error: 'Failed to delete provider credentials' }, 500)
    }
  })

  return app
}
