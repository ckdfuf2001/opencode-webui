import { Hono } from 'hono'
import { z } from 'zod'
import { enqueueQueuedChat, listQueuedChats, moveQueuedChat, removeQueuedChat, clearQueuedChats, flushQueueForSession, retryQueuedChat, setQuickMode, updateQueuedChatsModel } from '../services/chat-queue'
import { logger } from '../utils/logger'

const EnqueueChatSchema = z.object({
  text: z.string().trim().min(1).max(16_000),
  directory: z.string().min(1).max(1024).optional(),
  model: z.object({ providerID: z.string().min(1), modelID: z.string().min(1) }).optional(),
  agent: z.string().min(1).max(255).optional(),
  reviewWanted: z.boolean().optional(),
  autoApply: z.boolean().optional(),
})

const MoveChatSchema = z.object({
  toTop: z.boolean().default(false),
})

const UpdateQueueModelSchema = z.object({
  providerID: z.string().min(1).max(255),
  modelID: z.string().min(1).max(255),
})

export function createChatQueueRoutes() {
  const app = new Hono()

  app.get('/:sessionId', async (c) => {
    try {
      const sessionId = c.req.param('sessionId')
      return c.json(listQueuedChats(sessionId))
    } catch (error) {
      logger.error('Failed to list queued chats:', error)
      return c.json({ error: 'Failed to list queued chats' }, 500)
    }
  })

  app.post('/:sessionId', async (c) => {
    try {
      const sessionId = c.req.param('sessionId')
      const body = await c.req.json()
      const validated = EnqueueChatSchema.parse(body)
      const queue = enqueueQueuedChat(sessionId, validated.text, validated.directory, {
        model: validated.model,
        agent: validated.agent,
        reviewWanted: validated.reviewWanted,
        autoApply: validated.autoApply,
      })
      // 폴러(1초)를 기다리지 않고 즉시 발송 시도 — idle이면 바로 나간다.
      flushQueueForSession(sessionId, validated.directory)
      return c.json(queue, 201)
    } catch (error: any) {
      if (error?.name === 'ZodError') {
        return c.json({ error: 'Invalid queue payload', details: error.issues }, 400)
      }
      logger.error('Failed to enqueue chat:', error)
      return c.json({ error: 'Failed to enqueue chat' }, 500)
    }
  })

  // 세션 중단(abort) 시 대기열 전체 정리용
  app.delete('/:sessionId', async (c) => {
    try {
      const cleared = clearQueuedChats(c.req.param('sessionId'))
      return c.json({ success: true, cleared })
    } catch (error) {
      logger.error('Failed to clear queued chats:', error)
      return c.json({ error: 'Failed to clear queued chats' }, 500)
    }
  })

  app.delete('/:sessionId/:itemId', async (c) => {
    try {
      const sessionId = c.req.param('sessionId')
      const itemId = c.req.param('itemId')
      // Idempotent: the item may already be mid-dispatch (optimistically
      // removed by the flusher), and deleting a vanished id is not an error.
      removeQueuedChat(sessionId, itemId)
      return c.json({ success: true })
    } catch (error) {
      logger.error('Failed to remove queued chat:', error)
      return c.json({ error: 'Failed to remove queued chat' }, 500)
    }
  })

  // 대기열 순서 변경: { toTop: true } 면 맨 앞(최우선), 아니면 한 칸 위로
  app.patch('/:sessionId/:itemId/move', async (c) => {
    try {
      const sessionId = c.req.param('sessionId')
      const itemId = c.req.param('itemId')
      const validated = MoveChatSchema.parse(await c.req.json().catch(() => ({})))
      const queue = moveQueuedChat(sessionId, itemId, validated.toTop)
      if (!queue) return c.json({ error: 'Queue not found' }, 404)
      return c.json(queue)
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: 'Invalid move payload' }, 400)
      logger.error('Failed to move queued chat:', error)
      return c.json({ error: 'Failed to move queued chat' }, 500)
    }
  })

  // 수동 재시도: sending 고착·failed를 queued로 되돌리고 즉시 발송 시도
  app.post('/:sessionId/:itemId/retry', async (c) => {
    try {
      const sessionId = c.req.param('sessionId')
      const itemId = c.req.param('itemId')
      const queue = retryQueuedChat(sessionId, itemId)
      if (!queue) return c.json({ error: 'Queue item not found' }, 404)
      return c.json(queue)
    } catch (error) {
      logger.error('Failed to retry queued chat:', error)
      return c.json({ error: 'Failed to retry queued chat' }, 500)
    }
  })

  // 세션 모델 변경 시 큐에 스냅샷된 모델 동기화.
  // 큐가 비어 있으면 빈 배열로 no-op 성공 (프론트는 실패로 취급하지 않는다).
  // sending 항목은 건드리지 않는다 — 이미 opencode로 발송된 슬롯이라 회수 불가.
  app.patch('/:sessionId/model', async (c) => {
    try {
      const sessionId = c.req.param('sessionId')
      const validated = UpdateQueueModelSchema.parse(await c.req.json().catch(() => ({})))
      const queue = updateQueuedChatsModel(sessionId, {
        providerID: validated.providerID,
        modelID: validated.modelID,
      })
      return c.json(queue ?? [])
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: 'Invalid model payload' }, 400)
      logger.error('Failed to update queued chat model:', error)
      return c.json({ error: 'Failed to update queued chat model' }, 500)
    }
  })

  // Quick mode: generation 끝마다 큐 투입 (Normal은 working 끝까지 대기)
  app.post('/:sessionId/quick-mode', async (c) => {
    try {
      const sessionId = c.req.param('sessionId')
      const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
      const enabled = !!(body as { enabled?: boolean }).enabled
      setQuickMode(sessionId, enabled)
      return c.json({ ok: true, enabled })
    } catch (error) {
      logger.error('Failed to set quick mode:', error)
      return c.json({ error: 'Failed to set quick mode' }, 500)
    }
  })

  return app
}
