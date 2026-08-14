import fs from 'fs'
import path from 'path'
import { getConfigPath, getReposPath } from '@opencode-webui/shared'
import { opencodeServerManager } from './opencode-single-server'
import { logger } from '../utils/logger'

const AUTOMATION_DIRS = ['agents', 'commands', 'skills', 'plugins', 'agent', 'command', 'skill', 'plugin']
const RESTART_DEBOUNCE_MS = 1500
const MIN_RESTART_INTERVAL_MS = 10_000

let debounceTimer: NodeJS.Timeout | null = null
let watchers: Array<fs.FSWatcher> = []
let lastRestartAt = 0

function isAutomationPath(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]+/)
  return parts.some(part => AUTOMATION_DIRS.includes(part))
}

function scheduleRestart(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    const now = Date.now()
    if (now - lastRestartAt < MIN_RESTART_INTERVAL_MS) {
      return
    }
    lastRestartAt = now
    logger.info('Automation files changed; restarting OpenCode server to reload commands/skills/agents')
    opencodeServerManager.restart().catch((error) => {
      logger.error('Failed to restart OpenCode server after automation change:', error)
    })
  }, RESTART_DEBOUNCE_MS)
}

function watchRoot(root: string): void {
  try {
    fs.mkdirSync(root, { recursive: true })
    const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const relative = filename.toString()
      if (!isAutomationPath(relative)) return
      const full = path.join(root, relative)
      if (path.basename(full).startsWith('.')) return
      scheduleRestart()
    })
    watcher.on('error', (error) => {
      logger.warn(`Automation watcher error on ${root}:`, error)
    })
    watchers.push(watcher)
    logger.info(`Automation watcher started on ${root}`)
  } catch (error) {
    logger.warn(`Failed to start automation watcher on ${root}:`, error)
  }
}

export function startAutomationWatcher(): void {
  if (watchers.length > 0) return
  watchRoot(getReposPath())
  watchRoot(path.join(getConfigPath()))
}

export function stopAutomationWatcher(): void {
  for (const watcher of watchers) {
    try {
      watcher.close()
    } catch {
      // already closed
    }
  }
  watchers = []
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}
