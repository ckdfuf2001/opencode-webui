import type { Database } from 'bun:sqlite'
import type { Schedule } from '../types/schedule'
import * as scheduleDb from '../db/schedule-queries'
import { getRepoById } from '../db/queries'
import { getReposPath } from '@opencode-webui/shared'
import { opencodeServerManager } from './opencode-single-server'
import { ensureServerAuth } from './opencode-auth'
import { logger } from '../utils/logger'
import path from 'path'

const CHECK_INTERVAL_MS = 30_000

function expandField(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^([\d*]+)(?:-(\d+))?(?:\/(\d+))?$/)
    if (!stepMatch) return null

    const startRaw = stepMatch[1]
    const endRaw = stepMatch[2]
    const stepRaw = stepMatch[3]
    if (!startRaw) return null
    const step = stepRaw ? parseInt(stepRaw, 10) : 1
    if (step < 1) return null

    const start = startRaw === '*' ? min : parseInt(startRaw, 10)
    const end = endRaw
      ? parseInt(endRaw, 10)
      : stepRaw
        ? max
        : startRaw === '*' ? max : start

    for (let v = start; v <= end; v += step) {
      if (v >= min && v <= max) values.add(v)
    }
  }
  return [...values]
}

export function matchesCron(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return false

  const minute = parts[0]
  const hour = parts[1]
  const day = parts[2]
  const month = parts[3]
  const weekday = parts[4]
  if (!minute || !hour || !day || !month || !weekday) return false

  const minutes = expandField(minute, 0, 59)
  const hours = expandField(hour, 0, 23)
  const days = expandField(day, 1, 31)
  const months = expandField(month, 1, 12)
  const weekdays = expandField(weekday, 0, 6)

  if (!minutes || !hours || !days || !months || !weekdays) return false

  return (
    minutes.includes(date.getMinutes()) &&
    hours.includes(date.getHours()) &&
    days.includes(date.getDate()) &&
    months.includes(date.getMonth() + 1) &&
    weekdays.includes(date.getDay())
  )
}

function formatSessionTitle(name: string): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}`
  return `[BATCH]${name}_${datePart}-${timePart}`
}

export async function runSchedule(db: Database, schedule: Schedule): Promise<{ success: boolean; sessionID?: string; error?: string }> {
  try {
    return await doRunSchedule(db, schedule)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function doRunSchedule(db: Database, schedule: Schedule): Promise<{ success: boolean; sessionID?: string; error?: string }> {
  const repo = getRepoById(db, schedule.repoId)
  if (!repo) {
    return { success: false, error: `Repo ${schedule.repoId} not found` }
  }

  const prompt = schedule.action === 'command'
    ? schedule.command?.trim()
    : schedule.prompt?.trim()
  if (!prompt) {
    return { success: false, error: schedule.action === 'command' ? 'Command name is required' : 'Prompt is required' }
  }

  await opencodeServerManager.ensureRunning()

  const base = opencodeServerManager.getUrl()
  const directory = path.join(getReposPath(), repo.localPath)
  const headers = ensureServerAuth({ 'Content-Type': 'application/json' })
  const directoryParam = encodeURIComponent(directory)

  const createResponse = await fetch(`${base}/session?directory=${directoryParam}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: formatSessionTitle(schedule.name) }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!createResponse.ok) {
    const body = await createResponse.text()
    return { success: false, error: `Failed to create session: ${createResponse.status} ${body}` }
  }

  const session = await createResponse.json() as { id: string }
  const sessionID = session.id

  const text = schedule.action === 'command' ? `/${prompt}` : prompt
  void sendSchedulePrompt(base, sessionID, schedule.agent, text, headers, directoryParam, schedule.name)
    .catch((error: unknown) => {
      logger.error(`Failed to send scheduled prompt for "${schedule.name}":`, error)
    })

  return { success: true, sessionID }
}

async function sendSchedulePrompt(
  base: string,
  sessionID: string,
  agent: string | undefined,
  text: string,
  headers: Record<string, string>,
  directoryParam: string,
  scheduleName: string,
): Promise<void> {
  const messageBody: Record<string, unknown> = { parts: [{ type: 'text', text }] }
  if (agent) {
    messageBody.agent = agent
  }
  const response = await fetch(`${base}/session/${sessionID}/message?directory=${directoryParam}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(messageBody),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) {
    const body = await response.text()
    logger.error(`Failed to send scheduled prompt for "${scheduleName}": ${response.status} ${body}`)
  }
}

export function startScheduleRunner(db: Database): NodeJS.Timeout {
  const check = async (): Promise<void> => {
    try {
      const now = new Date()
      const schedules = scheduleDb.listEnabledSchedules(db)

      for (const schedule of schedules) {
        if (schedule.activeFrom && now.getTime() < schedule.activeFrom) continue
        if (schedule.activeUntil && now.getTime() > schedule.activeUntil) continue
        if (!matchesCron(schedule.cron, now)) continue
        if (!scheduleDb.tryClaimScheduleRun(db, schedule.id, 60_000)) continue

        logger.info(`Running scheduled task "${schedule.name}" (id=${schedule.id}, action=${schedule.action})`)
        const result = await runSchedule(db, schedule)
        if (result.success) {
          logger.info(`Scheduled task "${schedule.name}" completed (session ${result.sessionID})`)
        } else {
          logger.error(`Scheduled task "${schedule.name}" failed: ${result.error}`)
        }
      }
    } catch (error) {
      logger.error('Schedule runner check failed:', error)
    }
  }

  const interval = setInterval(check, CHECK_INTERVAL_MS)
  check()
  return interval
}
