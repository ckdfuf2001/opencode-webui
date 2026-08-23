import { Hono } from 'hono'
import { z } from 'zod'
import { enqueueQueuedChat, listQueuedChats, removeQueuedChat } from '../services/chat-queue'
import { logger } from '../utils/logger'

const EnqueueChatSchema = z.object({
  text: z.string().trim().min(1).max(16_000),
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

  app.delete('/:sessionId/:itemId', async (c) => {
    try {
      const sessionId = c.req.param('sessionId')
      const itemId = c.req.param('itemId')
      const removed = removeQueuedChat(sessionId, itemId)
      if (!removed) {
        return c.json({ error: 'Queued chat not found' }, 404)
      }
      return c.json({ success: true })
    } catch (error) {
      logger.error('Failed to remove queued chat:', error)
      return c.json({ error: 'Failed to remove queued chat' }, 500)
    }
  })

  return app
}
