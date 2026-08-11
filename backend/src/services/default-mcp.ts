import path from 'node:path'
import { spawn, execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { ENV, getWorkspacePath, getReposPath } from '@opencode-webui/shared'
import { logger } from '../utils/logger'

let agentBrowserWarmState: 'warm' | 'cold' | 'unknown' = 'unknown'

const workspaceBackend = `http://127.0.0.1:${ENV.SERVER.PORT}`
const AGENT_BROWSER_NAMESPACE = 'opencode'
const AGENT_BROWSER_IDLE_TIMEOUT_MS = '86400000'

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

function buildAgentBrowserMcp(namespace: string = AGENT_BROWSER_NAMESPACE): Record<string, unknown> {
  const info = resolveAgentBrowser()
  if (!info) return {}
  const env: Record<string, string> = {}
  if (info.executablePath && existsSync(info.executablePath)) {
    env.AGENT_BROWSER_EXECUTABLE_PATH = info.executablePath
  }
  env.AGENT_BROWSER_NAMESPACE = namespace
  env.AGENT_BROWSER_SESSION = namespace
  env.AGENT_BROWSER_IDLE_TIMEOUT_MS = AGENT_BROWSER_IDLE_TIMEOUT_MS
  return {
    'agent-browser': {
      type: 'local',
      enabled: true,
      command: [info.binPath, 'mcp', '--namespace', namespace],
      env,
    },
  }
}

export function repoAgentBrowserNamespace(localPath: string): string {
  const slug = localPath.replace(/[\\/]/g, '-').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  const safeSlug = slug || `repo-${Date.now().toString(36)}`
  return `repo-${safeSlug}`
}

export function writeRepoOpenCodeConfig(localPath: string): boolean {
  const info = resolveAgentBrowser()
  if (!info) return false
  const repoDir = path.join(getReposPath(), localPath)
  if (!existsSync(repoDir)) return false
  const configPath = path.join(repoDir, 'opencode.json')
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  } catch {
    existing = {}
  }
  const namespace = repoAgentBrowserNamespace(localPath)
  const mcpEntry = buildAgentBrowserMcp(namespace)
  const existingMcp = (existing.mcp && typeof existing.mcp === 'object') ? (existing.mcp as Record<string, unknown>) : {}
  const content = { ...existing, mcp: { ...existingMcp, ...mcpEntry } }
  writeFileSync(configPath, JSON.stringify(content, null, 2))
  logger.info(`Wrote per-repo OpenCode config '${configPath}' with agent-browser namespace '${namespace}'`)
  return true
}

export async function warmUpAgentBrowserDaemon(namespace: string = AGENT_BROWSER_NAMESPACE): Promise<boolean> {
  const info = resolveAgentBrowser()
  if (!info) return false
  if (isAgentBrowserDaemonWarm(info.binPath, namespace)) {
    if (agentBrowserWarmState !== 'warm') {
      agentBrowserWarmState = 'warm'
      logger.info(`Agent-browser daemon is warm (namespace: ${namespace})`)
    }
    return true
  }
  const env: Record<string, string> = {
    ...process.env,
    AGENT_BROWSER_NAMESPACE: namespace,
    AGENT_BROWSER_SESSION: namespace,
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
      if (agentBrowserWarmState !== 'cold') {
        agentBrowserWarmState = 'cold'
        logger.warn(`Agent-browser daemon warm-up timed out (namespace: ${namespace})`)
      }
      resolve(false)
    }, 90_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      if (agentBrowserWarmState !== 'cold') {
        agentBrowserWarmState = 'cold'
        logger.warn(`Agent-browser daemon warm-up failed (namespace: ${namespace}):`, error)
      }
      resolve(false)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      const ok = code === 0
      if (ok) {
        if (agentBrowserWarmState !== 'warm') {
          agentBrowserWarmState = 'warm'
          logger.info(`Agent-browser daemon warmed up successfully (namespace: ${namespace})`)
        }
      } else if (agentBrowserWarmState !== 'cold') {
        agentBrowserWarmState = 'cold'
        logger.warn(`Agent-browser warm-up exited with code ${code} (namespace: ${namespace})`)
      }
      resolve(ok)
    })
  })
}

function isAgentBrowserDaemonWarm(binPath: string, namespace: string): boolean {
  try {
    const output = execFileSync(binPath, ['session', 'info', '--json'], {
      env: { ...process.env, AGENT_BROWSER_NAMESPACE: namespace, AGENT_BROWSER_SESSION: namespace },
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

export function killLingeringAgentBrowser(): void {
  if (process.platform !== 'win32') {
    return
  }
  if (typeof process.env.TEMP !== 'string') {
    return
  }
  const script = [
    '$processes = Get-CimInstance Win32_Process | Where-Object {',
    "  ($_.Name -eq 'agent-browser.exe') -or",
    "  ($_.ExecutablePath -like '*agent-browser*') -or",
    "  ($_.CommandLine -like '*doc_reader_mcp.py*')",
    '}',
    'foreach ($process in $processes) {',
    '  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue',
    '}',
  ].join('\n')
  const scriptPath = path.join(process.env.TEMP, `opencode-webui-cleanup-${process.pid}.ps1`)
  try {
    writeFileSync(scriptPath, script, 'utf8')
    execSync(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`, {
      stdio: 'ignore',
      timeout: 15_000,
    })
    logger.info('Cleaned up lingering agent-browser MCP processes')
  } catch {
    logger.warn('Failed to clean up lingering agent-browser processes')
  } finally {
    try {
      rmSync(scriptPath, { force: true })
    } catch {
      // ignore cleanup of the temp script
    }
  }
}