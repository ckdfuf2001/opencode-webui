import fs from 'fs'
import path from 'path'
import { getConfigPath, getReposPath, getWorkspacePath } from '@opencode-webui/shared'
import { opencodeServerManager } from './opencode-single-server'
import { isOpenCodeServerBusy } from './busy-tracker'
import { logger } from '../utils/logger'

const AUTOMATION_DIRS = ['agents', 'commands', 'skills', 'plugins']
const IGNORED_SEGMENTS = new Set(['node_modules', '.git', '.hg', '.svn', '.cache', 'dist', 'build', 'coverage', '.next', '.turbo', 'out'])
const RESTART_DEBOUNCE_MS = 1500
const MIN_RESTART_INTERVAL_MS = 10_000
const BUSY_RETRY_MS = 5_000
const MAX_DEFER_MS = 10 * 60_000
const RELOAD_GRACE_MS = 300

let debounceTimer: NodeJS.Timeout | null = null
let watchers: Array<fs.FSWatcher> = []
let lastRestartAt = 0
let pendingRestart = false
let deferStartedAt = 0
let pendingDirectories = new Set<string>()
let globalConfigChanged = false

function isAutomationPath(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]+/)
  if (parts.some(part => IGNORED_SEGMENTS.has(part))) return false
  const dotIndex = parts.indexOf('.opencode')
  if (dotIndex !== -1) {
    const next = parts[dotIndex + 1]
    return next !== undefined && AUTOMATION_DIRS.includes(next)
  }
  return AUTOMATION_DIRS.includes(parts[0] ?? '')
}

/**
 * Map a changed relative path (relative to a watched root) to the project
 * directory whose OpenCode instance should be reloaded.
 * - repos/<repo>/.opencode/...   → D:\...\workspace\repos\<repo>
 * - workspace/.config/opencode/... → global change; target is null meaning
 *   every project may be affected (see expandGlobalTargets).
 */
function resolveTargetDirectory(root: string, relativePath: string): string | null {
  const parts = relativePath.split(/[\\/]+/)
  const dotIndex = parts.indexOf('.opencode')
  if (dotIndex === -1) return null
  return path.join(root, ...parts.slice(0, dotIndex))
}

/**
 * A change under the global config dir affects every project's instance, so we
 * must dispose the workspace root plus all repo directories.
 */
function expandGlobalTargets(): string[] {
  const targets = new Set<string>([getWorkspacePath()])
  try {
    const reposRoot = getReposPath()
    for (const entry of fs.readdirSync(reposRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        targets.add(path.join(reposRoot, entry.name))
      }
    }
  } catch (error) {
    logger.warn('Failed to enumerate repos for global reload:', error)
  }
  return [...targets]
}

function executeReload(): void {
  pendingRestart = false
  deferStartedAt = 0
  lastRestartAt = Date.now()

  let directories = [...pendingDirectories]
  pendingDirectories.clear()
  if (globalConfigChanged) {
    directories = directories.concat(expandGlobalTargets())
    globalConfigChanged = false
  }
  directories = [...new Set(directories)]

  if (directories.length === 0) {
    return
  }

  logger.info(`Automation files changed; reloading OpenCode instances: ${directories.join(', ')}`)
  opencodeServerManager.reloadDirectories(directories).catch((error) => {
    logger.error('Failed to reload OpenCode instances after automation change:', error)
  })
}

/**
 * opencode loads commands/skills/agents/MCP prompts lazily per project
 * instance and caches them. `POST /instance/dispose?directory=X` evicts that
 * instance so the next read re-scans from disk — no process restart needed.
 * Global (config-dir) changes can affect every project, so when a change lands
 * there we dispose each known repo directory as well.
 */
function scheduleRestart(delayMs = RESTART_DEBOUNCE_MS): void {
  pendingRestart = true
  if (deferStartedAt === 0) {
    deferStartedAt = Date.now()
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    if (!pendingRestart) return

    if (isOpenCodeServerBusy()) {
      if (Date.now() - deferStartedAt > MAX_DEFER_MS) {
        logger.warn('OpenCode server stayed busy for too long; skipping automation reload')
        pendingRestart = false
        deferStartedAt = 0
        pendingDirectories.clear()
        return
      }
      logger.info('OpenCode server is busy; deferring automation reload')
      scheduleRestart(BUSY_RETRY_MS)
      return
    }

    const now = Date.now()
    if (now - lastRestartAt < MIN_RESTART_INTERVAL_MS) {
      scheduleRestart(RESTART_DEBOUNCE_MS)
      return
    }

    // Wait once more and re-check busy so a long-running request that
    // starts between the check above and the actual dispose gets a chance
    // to register itself before the instance is evicted.
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      if (!pendingRestart) return
      if (isOpenCodeServerBusy()) {
        logger.info('OpenCode server became busy during reload grace; deferring automation reload')
        scheduleRestart(BUSY_RETRY_MS)
        return
      }
      executeReload()
    }, RELOAD_GRACE_MS)
  }, delayMs)
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
      const target = resolveTargetDirectory(root, relative)
      if (target) {
        pendingDirectories.add(target)
      }
      const isGlobalRoot = path.resolve(root) === path.resolve(getConfigPath())
      if (isGlobalRoot) {
        globalConfigChanged = true
        logger.info(`Global automation change under ${relative}; will reload affected instances`)
      }
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
  pendingRestart = false
  deferStartedAt = 0
  pendingDirectories.clear()
  globalConfigChanged = false
}