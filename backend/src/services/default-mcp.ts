import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { getWorkspacePath } from '@opencode-webui/shared'
import { logger } from '../utils/logger'

const workspaceBackend = 'http://127.0.0.1:5001'
const AGENT_BROWSER_IDLE_TIMEOUT_MS = '86400000'
const AGENT_BROWSER_NAMESPACE = 'opencode'

function buildDocReaderMcp(): Record<string, unknown> {
  return {
    'doc-reader': {
      type: 'local',
      enabled: true,
      command: ['python', path.join(process.cwd(), 'backend', 'scripts', 'doc_reader_mcp.py')],
      env: {
        OPCODE_WEBUI_BACKEND: workspaceBackend,
        OPCODE_WEBUI_WORKSPACE: getWorkspacePath(),
      },
    },
  }
}

interface AgentBrowserInfo {
  binPath: string
  executablePath: string
}

function resolveAgentBrowser(): AgentBrowserInfo | null {
  const metaFile = path.join(process.cwd(), 'bin', 'agent-browser', '.meta.json')
  if (!existsSync(metaFile)) return null
  try {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as { bin?: string; executable?: string }
    const binPath = meta.bin ? path.join(process.cwd(), meta.bin) : ''
    if (!binPath || !existsSync(binPath)) return null
    const executablePath = meta.executable ? path.join(process.cwd(), meta.executable) : ''
    return { binPath, executablePath }
  } catch (error) {
    logger.warn('Failed to read agent-browser meta:', error)
    return null
  }
}

function buildAgentBrowserMcp(): Record<string, unknown> {
  const info = resolveAgentBrowser()
  if (!info) return {}
  const env: Record<string, string> = {}
  if (info.executablePath && existsSync(info.executablePath)) {
    env.AGENT_BROWSER_EXECUTABLE_PATH = info.executablePath
  }
  env.AGENT_BROWSER_NAMESPACE = 'opencode'
  env.AGENT_BROWSER_IDLE_TIMEOUT_MS = AGENT_BROWSER_IDLE_TIMEOUT_MS
  return {
    'agent-browser': {
      type: 'local',
      enabled: true,
      command: [info.binPath, 'mcp', '--namespace', 'opencode'],
      env,
    },
  }
}

export async function warmUpAgentBrowserDaemon(): Promise<boolean> {
  const info = resolveAgentBrowser()
  if (!info) return false
  if (isAgentBrowserDaemonWarm(info.binPath)) {
    logger.debug('Agent-browser daemon already warm, skipping warm-up')
    return true
  }
  const env: Record<string, string> = {
    ...process.env,
    AGENT_BROWSER_NAMESPACE,
    AGENT_BROWSER_IDLE_TIMEOUT_MS,
  }
  if (info.executablePath && existsSync(info.executablePath)) {
    env.AGENT_BROWSER_EXECUTABLE_PATH = info.executablePath
  }
  return new Promise<boolean>((resolve) => {
    const child = spawn(
      info.binPath,
      ['--headed', 'false', 'open', 'about:blank', '--json'],
      { env, stdio: ['ignore', 'ignore', 'ignore'] },
    )
    const timer = setTimeout(() => {
      child.kill()
      logger.warn('Agent-browser daemon warm-up timed out')
      resolve(false)
    }, 90_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      logger.warn('Agent-browser daemon warm-up failed:', error)
      resolve(false)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      const ok = code === 0
      logger.info(ok ? 'Agent-browser daemon warmed up successfully' : `Agent-browser warm-up exited with code ${code}`)
      resolve(ok)
    })
  })
}

function isAgentBrowserDaemonWarm(binPath: string): boolean {
  try {
    const output = execFileSync(binPath, ['session', 'info', '--json'], {
      env: { ...process.env, AGENT_BROWSER_NAMESPACE },
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const parsed = JSON.parse(output) as { data?: { active?: boolean; runtime?: { browserLaunched?: boolean } | null } }
    return parsed.data?.active === true && parsed.data.runtime?.browserLaunched === true
  } catch {
    return false
  }
}

export function defaultMcpEntries(): Record<string, unknown> {
  return { ...buildDocReaderMcp(), ...buildAgentBrowserMcp() }
}

export function mergeDefaultMcpEntries<T extends Record<string, unknown>>(content: T): T {
  const mcp = { ...((content.mcp as Record<string, unknown>) ?? {}) }
  const defaults = defaultMcpEntries()
  for (const [id, entry] of Object.entries(defaults)) {
    const existing = mcp[id] as Record<string, unknown> | undefined
    if (!existing) {
      mcp[id] = entry
      continue
    }
    const existingCommand = Array.isArray(existing.command) ? existing.command : []
    const defaultCommand = (entry as Record<string, unknown>).command
    const defaultEnv = (entry as Record<string, unknown>).env as Record<string, string> | undefined
    const repaired: Record<string, unknown> = { ...existing }
    let changed = false
    if (JSON.stringify(existingCommand) !== JSON.stringify(defaultCommand)) {
      repaired.command = defaultCommand
      changed = true
    }
    if (existing.enabled !== true) {
      repaired.enabled = true
      changed = true
    }
    if (defaultEnv) {
      const repairedEnv = { ...((existing.env as Record<string, string>) ?? {}) }
      for (const [key, value] of Object.entries(defaultEnv)) {
        if (repairedEnv[key] !== value) {
          repairedEnv[key] = value
          changed = true
        }
      }
      repaired.env = repairedEnv
    }
    if (changed) {
      mcp[id] = repaired
      logger.info(`Repaired default MCP server entry: ${id}`)
    }
  }
  return { ...content, mcp } as T
}
