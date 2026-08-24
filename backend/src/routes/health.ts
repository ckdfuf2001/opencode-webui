import { Hono } from 'hono'
import type { Database } from 'bun:sqlite'
import { opencodeServerManager } from '../services/opencode-single-server'

// opencode 프로브 결과를 5초 캐시한다. 생성 중엔 프로브가 3초까지 늘어질 수 있어
// 다수 클라이언트의 폴링이 매번 프로브를 때리지 않도록 한다.
let probeCache: { at: number; healthy: boolean } | null = null
const PROBE_CACHE_TTL_MS = 5_000

async function probeOpencode(): Promise<boolean> {
  const now = Date.now()
  if (probeCache && now - probeCache.at < PROBE_CACHE_TTL_MS) {
    return probeCache.healthy
  }
  const healthy = await opencodeServerManager.checkHealth()
  probeCache = { at: Date.now(), healthy }
  return healthy
}

export function createHealthRoutes(db: Database) {
  const app = new Hono()

  app.get('/', async (c) => {
    try {
      const dbCheck = db.prepare('SELECT 1').get()
      const opencodeHealthy = await probeOpencode()
      const status = dbCheck && opencodeHealthy ? 'healthy' : 'degraded'
      
      return c.json({
        status,
        timestamp: new Date().toISOString(),
        database: dbCheck ? 'connected' : 'disconnected',
        opencode: opencodeHealthy ? 'healthy' : 'unhealthy',
        opencodePort: opencodeServerManager.getPort()
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
