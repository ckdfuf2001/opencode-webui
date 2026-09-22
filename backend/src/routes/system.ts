import { Hono } from 'hono'
import type { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { opencodeServerManager } from '../services/opencode-single-server'
import { getWorkspacePath, getReposPath, getConfigPath, ENV } from '@opencode-webui/shared'
import { logger } from '../utils/logger'

declare const PACKAGE_VERSION: string | undefined

function getVersion(): string {
  try {
    // portable 빌드에서 --define으로 박힌 버전 (exe 옆 package.json이 없어도 동작)
    if (typeof PACKAGE_VERSION !== 'undefined' && PACKAGE_VERSION) return PACKAGE_VERSION
    const pkgPath = path.join(process.cwd(), 'package.json')
    const raw = readFileSync(pkgPath, 'utf-8')
    const pkg = JSON.parse(raw) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export function createSystemRoutes(_db: Database) {
  const app = new Hono()

  // GET /api/system/info — 외부에서 시스템 정보 조회 (포트, 버전, 경로 등)
  app.get('/info', async (c) => {
    try {
      const version = getVersion()
      const opencodePort = opencodeServerManager.getPort()
      const opencodeHealthy = await opencodeServerManager.checkHealth().catch(() => false)
      const startedAt = (global as unknown as { __systemStartedAt?: number }).__systemStartedAt ?? Date.now()
      return c.json({
        version,
        backend: {
          port: ENV.SERVER.PORT,
          host: ENV.SERVER.HOST,
          nodeVersion: process.version,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          workspacePath: getWorkspacePath(),
          reposPath: getReposPath(),
          configPath: getConfigPath(),
        },
        opencode: {
          port: opencodePort,
          healthy: opencodeHealthy,
        },
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      logger.error('Failed to get system info:', error)
      return c.json({ error: 'Failed to get system info' }, 500)
    }
  })

  // GET /api/system/logs — 인메모리 최근 로그 (콘솔 접근 불가 환경 진단용)
  app.get('/logs', async (c) => {
    try {
      const limitRaw = c.req.query('limit')
      const limit = limitRaw ? parseInt(limitRaw, 10) || 200 : 200
      const level = (c.req.query('level') || '').toLowerCase()
      const { getRecentLogs } = await import('../utils/logger')
      const lines = getRecentLogs(limit)
      return c.json({
        lines: level ? lines.filter((l) => l.level === level) : lines,
      })
    } catch (error) {
      logger.error('Failed to get system logs:', error)
      return c.json({ error: 'Failed to get system logs' }, 500)
    }
  })

  // GET /api/system — alias
  app.get('/', async (c) => {
    c.header('Location', '/api/system/info')
    return c.json({ redirect: '/api/system/info' }, 302)
  })

  return app
}

// Set start time for uptime
;(global as unknown as { __systemStartedAt?: number }).__systemStartedAt = Date.now()
