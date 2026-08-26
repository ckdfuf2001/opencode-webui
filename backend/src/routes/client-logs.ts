import { Hono } from 'hono'
import { z } from 'zod'
import { appendFile, mkdir, open, readFile, stat } from 'fs/promises'
import os from 'os'
import path from 'path'
import { logger } from '../utils/logger'

const OPENCODE_LOG_PATH = path.join(os.homedir(), '.local', 'share', 'opencode', 'log', 'opencode.log')

const EntrySchema = z.object({
  level: z.enum(['error', 'warn', 'info']).default('error'),
  message: z.string().min(1).max(4000),
  detail: z.string().max(8000).optional(),
  href: z.string().max(1000).optional(),
})

/** 브라우저 토스트 오류를 받아 logs/frontend-YYYY-MM.log 에 JSONL로 적는다. */
export function createClientLogRoutes() {
  const app = new Hono()

  const logDir = path.join('logs')
  const logFile = () => {
    const d = new Date()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    return path.join(logDir, `frontend-${d.getFullYear()}-${mm}.log`)
  }

  app.post('/', async (c) => {
    try {
      const entry = EntrySchema.parse(await c.req.json())
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        level: entry.level,
        message: entry.message,
        href: entry.href,
        detail: entry.detail,
      })
      await mkdir(logDir, { recursive: true })
      await appendFile(logFile(), `${line}\n`, 'utf8')
      return c.json({ success: true, file: logFile() })
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid log entry', details: error.issues }, 400)
      }
      logger.warn('Failed to write client log:', error)
      return c.json({ error: 'Failed to write log' }, 500)
    }
  })

  // GET /api/logs?lines=200 — 최근 N줄(기본 200) 텍스트로 반환
  app.get('/', async (c) => {
    try {
      const lines = Math.min(Math.max(parseInt(c.req.query('lines') || '200', 10) || 200, 1), 5000)
      const file = logFile()
      try {
        await stat(file)
      } catch {
        return c.text('')
      }
      const content = await readFile(file, 'utf8')
      const all = content.split('\n').filter((l) => l.trim())
      return c.text(all.slice(-lines).join('\n'))
    } catch (error) {
      logger.warn('Failed to read client log:', error)
      return c.json({ error: 'Failed to read log' }, 500)
    }
  })

  // GET /api/logs/opencode?lines=200 — opencode 서버 로그 꼬리
  app.get('/opencode', async (c) => {
    try {
      const lines = Math.min(Math.max(parseInt(c.req.query('lines') || '80', 10) || 80, 1), 2000)
      const handle = await open(OPENCODE_LOG_PATH, 'r').catch(() => null)
      if (!handle) return c.text('')
      try {
        const size = (await handle.stat()).size
        const start = Math.max(0, size - 256 * 1024)
        const length = size - start
        const buf = Buffer.alloc(length)
        await handle.read(buf, 0, length, start)
        const all = buf.toString('utf8').split('\n').filter((l) => l.trim())
        return c.text(all.slice(-lines).join('\n'))
      } finally {
        await handle.close().catch(() => {})
      }
    } catch (error) {
      logger.warn('Failed to read opencode log:', error)
      return c.json({ error: 'Failed to read opencode log' }, 500)
    }
  })

  return app
}
