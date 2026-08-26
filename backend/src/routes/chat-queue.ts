import { Hono } from 'hono'
import { z } from 'zod'
import { enqueueQueuedChat, listQueuedChats, moveQueuedChat, removeQueuedChat, clearQueuedChats } from '../services/chat-queue'
import { logger } from '../utils/logger'

const EnqueueChatSchema = z.object({
  text: z.string().trim().min(1).max(16_000),
})

const MoveChatSchema = z.object({
  toTop: z.boolean().default(false),
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
      const queue = enqueueQueuedChat(sessionId, validated.text)
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

  return app
}
