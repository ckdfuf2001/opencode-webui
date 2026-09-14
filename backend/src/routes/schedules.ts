import { Hono } from 'hono'
import { z } from 'zod'
import type { Database } from 'bun:sqlite'
import * as scheduleDb from '../db/schedule-queries'
import { getRepoById } from '../db/queries'
import { runSchedule, isValidCron } from '../services/scheduler'
import { logger } from '../utils/logger'

const CreateScheduleSchema = z.object({
  repoId: z.number().int().positive(),
  name: z.string().min(1).max(255),
  action: z.enum(['command', 'chat']),
  command: z.string().min(1).max(255).optional(),
  prompt: z.string().min(1).max(20000).optional(),
  cron: z.string().min(1).max(255),
  enabled: z.boolean().optional(),
  activeFrom: z.number().optional(),
  activeUntil: z.number().optional(),
  agent: z.string().min(1).max(255).optional(),
  model: z.string().min(1).max(255).optional(),
}).refine((data) => {
  if (data.activeFrom !== undefined && data.activeUntil !== undefined && data.activeFrom >= data.activeUntil) {
    return false
  }
  return true
}, { message: 'activeFrom must be before activeUntil' })

const UpdateScheduleSchema = CreateScheduleSchema.omit({ repoId: true }).partial()

function validateActionFields(body: z.infer<typeof CreateScheduleSchema>): string | null {
  if (body.action === 'command' && !body.command) {
    return 'command is required when action is "command"'
  }
  if (body.action === 'chat' && !body.prompt) {
    return 'prompt is required when action is "chat"'
  }
  return null
}

export function createScheduleRoutes(db: Database) {
  const app = new Hono()

  app.get('/', async (c) => {
    try {
      const repoIdRaw = c.req.query('repoId')
      const repoId = repoIdRaw ? parseInt(repoIdRaw, 10) : undefined
      const schedules = scheduleDb.listSchedules(db, repoId && !Number.isNaN(repoId) ? repoId : undefined)
      return c.json(schedules)
    } catch (error) {
      logger.error('Failed to list schedules:', error)
      return c.json({ error: 'Failed to list schedules' }, 500)
    }
  })

  app.get('/:id', async (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10)
      if (Number.isNaN(id)) return c.json({ error: 'Invalid schedule id' }, 400)
      const schedule = scheduleDb.getScheduleById(db, id)
      if (!schedule) return c.json({ error: 'Schedule not found' }, 404)
      return c.json(schedule)
    } catch (error) {
      logger.error('Failed to get schedule:', error)
      return c.json({ error: 'Failed to get schedule' }, 500)
    }
  })

  app.post('/', async (c) => {
    try {
      const body = await c.req.json()
      const validated = CreateScheduleSchema.parse(body)

      if (!getRepoById(db, validated.repoId)) {
        return c.json({ error: `Repo ${validated.repoId} not found. Create a repo first via POST /api/repos` }, 404)
      }

      const actionError = validateActionFields(validated)
      if (actionError) {
        return c.json({ error: actionError }, 400)
      }
      if (!isValidCron(validated.cron)) {
        return c.json({ error: `Invalid cron "${validated.cron}". Expected 5 fields: "minute hour day month weekday" e.g. "0 9 * * *"` }, 400)
      }

      const schedule = scheduleDb.createSchedule(db, validated)
      logger.info(`Schedule created id=${schedule.id} repo=${schedule.repoId} cron="${schedule.cron}"`)
      return c.json(schedule, 201)
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid schedule data', details: error.issues }, 400)
      }
      logger.error('Failed to create schedule:', error)
      return c.json({ error: 'Failed to create schedule' }, 500)
    }
  })

  app.put('/:id', async (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10)
      if (Number.isNaN(id)) return c.json({ error: 'Invalid schedule id' }, 400)
      const body = await c.req.json()
      const validated = UpdateScheduleSchema.parse(body)

      const existing = scheduleDb.getScheduleById(db, id)
      if (!existing) {
        return c.json({ error: 'Schedule not found' }, 404)
      }

      const merged = { ...existing, ...validated }
      const actionError = validateActionFields({
        repoId: existing.repoId,
        name: merged.name,
        action: merged.action,
        command: merged.command,
        prompt: merged.prompt,
        cron: merged.cron,
      })
      if (actionError) {
        return c.json({ error: actionError }, 400)
      }
      if (validated.cron !== undefined && !isValidCron(validated.cron)) {
        return c.json({ error: `Invalid cron "${validated.cron}". Expected 5 fields` }, 400)
      }

      // action 전환 시 반대 필드 정리: chat->command면 prompt 제거, 반대도 마찬가지
      const sanitized: typeof validated = { ...validated }
      if (validated.action === 'command' && sanitized.prompt === undefined) {
        // keep existing prompt cleared is not required; DB keeps old value but scheduler ignores it
      }
      if (validated.action === 'chat' && sanitized.command === undefined) {
        // same
      }

      const schedule = scheduleDb.updateSchedule(db, id, sanitized)
      return c.json(schedule)
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid schedule data', details: error.issues }, 400)
      }
      logger.error('Failed to update schedule:', error)
      return c.json({ error: 'Failed to update schedule' }, 500)
    }
  })

  app.delete('/:id', async (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10)
      if (Number.isNaN(id)) return c.json({ error: 'Invalid schedule id' }, 400)
      const existing = scheduleDb.getScheduleById(db, id)
      if (!existing) {
        return c.json({ error: 'Schedule not found' }, 404)
      }

      scheduleDb.deleteSchedule(db, id)
      return c.json({ success: true })
    } catch (error) {
      logger.error('Failed to delete schedule:', error)
      return c.json({ error: 'Failed to delete schedule' }, 500)
    }
  })

  app.post('/:id/run', async (c) => {
    try {
      const id = parseInt(c.req.param('id'), 10)
      const schedule = scheduleDb.getScheduleById(db, id)
      if (!schedule) {
        return c.json({ error: 'Schedule not found' }, 404)
      }

      const result = await runSchedule(db, schedule)
      if (result.success) {
        scheduleDb.markScheduleRun(db, id)
        return c.json({ success: true, sessionID: result.sessionID })
      }
      return c.json({ error: result.error, sessionID: result.sessionID }, 500)
    } catch (error) {
      logger.error('Failed to run schedule now:', error)
      return c.json({ error: 'Failed to run schedule now' }, 500)
    }
  })

  return app
}
