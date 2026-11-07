import { Hono } from 'hono'
import type { Database } from 'bun:sqlite'
import { opencodeServerManager } from '../services/opencode-single-server'

declare const BUILD_SHA: string | undefined

/** P1: exe 식별용 빌드 커밋 (portable 빌드에서 --define으로 박힌다). */
function getCommit(): string {
  try {
    if (typeof BUILD_SHA !== 'undefined' && BUILD_SHA) return BUILD_SHA
  } catch { /* ignore */ }
  return 'dev'
}

export function createHealthRoutes(db: Database) {
  const app = new Hono()

  app.get('/', async (c) => {
    try {
      const dbCheck = db.prepare('SELECT 1').get()
      const opencodeHealthy = await opencodeServerManager.checkHealth()
      
      const status = dbCheck && opencodeHealthy ? 'healthy' : 'degraded'
      
      return c.json({
        status,
        timestamp: new Date().toISOString(),
        database: dbCheck ? 'connected' : 'disconnected',
        opencode: opencodeHealthy ? 'healthy' : 'unhealthy',
        opencodePort: opencodeServerManager.getPort(),
        commit: getCommit()
      })
    } catch (error) {
      return c.json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 503)
    }
  })

  app.get('/processes', async (c) => {
    try {
      const opencodeHealthy = await opencodeServerManager.checkHealth()
      
      return c.json({
        opencode: {
          port: opencodeServerManager.getPort(),
          healthy: opencodeHealthy
        },
        timestamp: new Date().toISOString()
      })
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      }, 500)
    }
  })

  return app
}
