import { Hono } from 'hono'
import type { Database } from 'bun:sqlite'
import { getAgentBrowserDaemonStatus, warmUpAgentBrowserDaemon } from '../services/default-mcp'
import { logger } from '../utils/logger'

export function createMcpRoutes(_db: Database) {
  const app = new Hono()

  app.get('/agent-browser/status', async (c) => {
    try {
      const session = c.req.query('session') || undefined
      const status = getAgentBrowserDaemonStatus('opencode', session)
      return c.json({ ...status, namespace: 'opencode', timestamp: new Date().toISOString() })
    } catch (error) {
      logger.error('Failed to get agent-browser status:', error)
      return c.json({ error: 'Failed to get agent-browser status' }, 500)
    }
  })

  app.post('/agent-browser/warm', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({})) as { session?: string }
      const session = body.session || c.req.query('session') || undefined
      const ok = await warmUpAgentBrowserDaemon('opencode', session)
      const status = getAgentBrowserDaemonStatus('opencode', session)
      return c.json({ success: ok, ...status })
    } catch (error) {
      logger.error('Failed to warm agent-browser daemon:', error)
      return c.json({ error: 'Failed to warm agent-browser daemon' }, 500)
    }
  })

  return app
}
