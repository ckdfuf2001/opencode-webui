import { Hono } from 'hono'
import { z } from 'zod'
import type { Database } from 'bun:sqlite'
import { logger } from '../utils/logger'
import { getRepoById } from '../db/queries'
import { getReposPath } from '@opencode-webui/shared'
import { opencodeServerManager } from '../services/opencode-single-server'
import { ensureServerAuth } from '../services/opencode-auth'
import path from 'path'

interface ExposedRow {
  id: number
  command_name: string
  expose_name: string
  description: string
  enabled: number
  created_at: number
  updated_at: number
}

function rowToExpose(row: ExposedRow) {
  return {
    id: row.id,
    commandName: row.command_name,
    exposeName: row.expose_name,
    description: row.description,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const CreateExposeSchema = z.object({
  commandName: z.string().min(1).max(255),
  exposeName: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  enabled: z.boolean().optional(),
})

const UpdateExposeSchema = z.object({
  exposeName: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  enabled: z.boolean().optional(),
})

export function createExposeRoutes(db: Database) {
  const app = new Hono()

  // Internal CRUD: /api/expose/commands
  app.get('/commands', async (c) => {
    try {
      const rows = db.prepare('SELECT * FROM exposed_commands ORDER BY created_at DESC').all() as ExposedRow[]
      return c.json(rows.map(rowToExpose))
    } catch (error) {
      logger.error('Failed to list exposed commands:', error)
      return c.json({ error: 'Failed to list exposed commands' }, 500)
    }
  })

  app.post('/commands', async (c) => {
    try {
      const body = await c.req.json()
      const validated = CreateExposeSchema.parse(body)
      const exposeName = (validated.exposeName ?? validated.commandName).trim().replace(/\s+/g, '-')
      if (!exposeName) return c.json({ error: 'exposeName is required' }, 400)
      const exists = db.prepare('SELECT 1 FROM exposed_commands WHERE expose_name = ?').get(exposeName)
      if (exists) return c.json({ error: `Expose name "${exposeName}" already exists` }, 409)
      const now = Date.now()
      const result = db.prepare(
        'INSERT INTO exposed_commands (command_name, expose_name, description, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(validated.commandName.trim(), exposeName, validated.description ?? '', validated.enabled === false ? 0 : 1, now, now)
      const row = db.prepare('SELECT * FROM exposed_commands WHERE id = ?').get(Number(result.lastInsertRowid)) as ExposedRow
      return c.json(rowToExpose(row), 201)
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: 'Invalid expose data', details: error.issues }, 400)
      logger.error('Failed to create exposed command:', error)
      return c.json({ error: 'Failed to create exposed command' }, 500)
    }
  })

  app.put('/commands/:id', async (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10)
      if (Number.isNaN(id)) return c.json({ error: 'Invalid id' }, 400)
      const body = await c.req.json()
      const validated = UpdateExposeSchema.parse(body)
      const existing = db.prepare('SELECT * FROM exposed_commands WHERE id = ?').get(id) as ExposedRow | undefined
      if (!existing) return c.json({ error: 'Exposed command not found' }, 404)
      if (validated.exposeName) {
        const dup = db.prepare('SELECT 1 FROM exposed_commands WHERE expose_name = ? AND id != ?').get(validated.exposeName.trim(), id)
        if (dup) return c.json({ error: `Expose name "${validated.exposeName}" already exists` }, 409)
      }
      const nextExpose = validated.exposeName?.trim() ?? existing.expose_name
      const nextDesc = validated.description !== undefined ? validated.description : existing.description
      const nextEnabled = validated.enabled !== undefined ? (validated.enabled ? 1 : 0) : existing.enabled
      db.prepare('UPDATE exposed_commands SET expose_name = ?, description = ?, enabled = ?, updated_at = ? WHERE id = ?')
        .run(nextExpose, nextDesc, nextEnabled, Date.now(), id)
      const row = db.prepare('SELECT * FROM exposed_commands WHERE id = ?').get(id) as ExposedRow
      return c.json(rowToExpose(row))
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: 'Invalid expose data', details: error.issues }, 400)
      logger.error('Failed to update exposed command:', error)
      return c.json({ error: 'Failed to update exposed command' }, 500)
    }
  })

  app.delete('/commands/:id', async (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10)
      if (Number.isNaN(id)) return c.json({ error: 'Invalid id' }, 400)
      const existing = db.prepare('SELECT * FROM exposed_commands WHERE id = ?').get(id) as ExposedRow | undefined
      if (!existing) return c.json({ error: 'Exposed command not found' }, 404)
      db.prepare('DELETE FROM exposed_commands WHERE id = ?').run(id)
      return c.json({ success: true })
    } catch (error) {
      logger.error('Failed to delete exposed command:', error)
      return c.json({ error: 'Failed to delete exposed command' }, 500)
    }
  })

  return app
}

export function createPublicExposeRoutes(db: Database) {
  const app = new Hono()

  // GET /api/public/commands — MCP-like discovery: 외부에서 호출 가능한 커맨드 목록
  app.get('/commands', async (c) => {
    try {
      const rows = db.prepare('SELECT * FROM exposed_commands WHERE enabled = 1 ORDER BY expose_name ASC').all() as ExposedRow[]
      return c.json({
        commands: rows.map((r) => ({
          name: r.expose_name,
          commandName: r.command_name,
          description: r.description,
          enabled: true,
        })),
        count: rows.length,
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      logger.error('Failed to list public commands:', error)
      return c.json({ error: 'Failed to list public commands' }, 500)
    }
  })

  // POST /api/public/commands/:exposeName/run — 외부에서 커맨드 실행 (repoId 또는 directory 기반)
  app.post('/commands/:exposeName/run', async (c) => {
    try {
      const exposeName = c.req.param('exposeName')
      const row = db.prepare('SELECT * FROM exposed_commands WHERE expose_name = ? AND enabled = 1').get(exposeName) as ExposedRow | undefined
      if (!row) return c.json({ error: `Exposed command "${exposeName}" not found or disabled` }, 404)

      const body = await c.req.json().catch(() => ({})) as {
        repoId?: number
        directory?: string
        args?: string
        sessionId?: string
        agent?: string
        model?: string
      }

      let repo = body.repoId ? getRepoById(db, body.repoId) : undefined
      let directory = body.directory
      if (!directory && repo) {
        directory = path.join(getReposPath(), repo.localPath)
      }
      if (!directory && !repo) {
        // fallback to first repo if not specified (편의)
        const first = db.prepare('SELECT * FROM repos LIMIT 1').get() as { id: number; local_path: string } | undefined
        if (first) {
          repo = getRepoById(db, first.id) ?? undefined
          directory = path.join(getReposPath(), first.local_path)
        }
      }
      if (!directory) return c.json({ error: 'Repo/directory required. Provide repoId or directory' }, 400)

      await opencodeServerManager.ensureRunning()
      const base = opencodeServerManager.getUrl()
      const headers = ensureServerAuth({ 'Content-Type': 'application/json' })
      const directoryParam = encodeURIComponent(directory)

      // 세션 재사용 또는 새로 생성
      let sessionId = body.sessionId
      if (!sessionId) {
        const createRes = await fetch(`${base}/session?directory=${directoryParam}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ title: `[EXPOSE]${exposeName}` }),
          signal: AbortSignal.timeout(30_000),
        })
        if (!createRes.ok) {
          const txt = await createRes.text().catch(() => '')
          return c.json({ error: `Failed to create session: ${createRes.status} ${txt.slice(0, 300)}` }, 500)
        }
        const sess = (await createRes.json()) as { id: string }
        sessionId = sess.id
      }

      const args = body.args ?? ''
      const commandText = args ? `/${row.command_name} ${args}` : `/${row.command_name}`
      const messageBody: Record<string, unknown> = { parts: [{ type: 'text', text: commandText }] }
      if (body.agent) messageBody.agent = body.agent
      if (body.model) {
        const slash = body.model.indexOf('/')
        if (slash > 0) messageBody.model = { providerID: body.model.slice(0, slash), modelID: body.model.slice(slash + 1) }
      }

      const sendRes = await fetch(`${base}/session/${sessionId}/message?directory=${directoryParam}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(messageBody),
        signal: AbortSignal.timeout(60_000),
      })
      if (!sendRes.ok) {
        const txt = await sendRes.text().catch(() => '')
        return c.json({ error: `Command send failed: ${sendRes.status} ${txt.slice(0, 300)}`, sessionId }, 500)
      }
      void sendRes.text().catch(() => {})
      return c.json({ success: true, exposeName, commandName: row.command_name, sessionId, directory })
    } catch (error) {
      logger.error('Failed to run exposed command:', error)
      return c.json({ error: 'Failed to run exposed command' }, 500)
    }
  })

  return app
}
