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

function buildAgentBrowserMcp(
  namespace: string = AGENT_BROWSER_NAMESPACE,
  session: string = namespace,
): Record<string, unknown> {
  const info = resolveAgentBrowser()
  if (!info) return {}
  const env: Record<string, string> = {}
  if (info.executablePath && existsSync(info.executablePath)) {
    env.AGENT_BROWSER_EXECUTABLE_PATH = info.executablePath
  }
  env.AGENT_BROWSER_NAMESPACE = namespace
  env.AGENT_BROWSER_SESSION = session
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

export function repoAgentBrowserSession(localPath: string): string {
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
  const session = repoAgentBrowserSession(localPath)
  const mcpEntry = buildAgentBrowserMcp(AGENT_BROWSER_NAMESPACE, session)
  const existingMcp = (existing.mcp && typeof existing.mcp === 'object') ? (existing.mcp as Record<string, unknown>) : {}
  const existingAgentBrowser = existingMcp['agent-browser'] as { enabled?: boolean } | undefined
  const agentBrowserEntry = mcpEntry['agent-browser'] as { enabled: boolean }
  if (existingAgentBrowser?.enabled === false) {
    agentBrowserEntry.enabled = false
  }
  const content = { ...existing, mcp: { ...existingMcp, ...mcpEntry } }
  writeFileSync(configPath, JSON.stringify(content, null, 2))
  logger.info(`Wrote per-repo OpenCode config '${configPath}' with agent-browser session '${session}'`)
  return true
}

let warmUpInFlight: Promise<boolean> | null = null

export function warmUpAgentBrowserDaemon(
  namespace: string = AGENT_BROWSER_NAMESPACE,
  session?: string,
): Promise<boolean> {
  if (warmUpInFlight) return warmUpInFlight
  warmUpInFlight = doWarmUp(namespace, session).finally(() => {
    warmUpInFlight = null
  })
  return warmUpInFlight
}

async function doWarmUp(
  namespace: string = AGENT_BROWSER_NAMESPACE,
  session?: string,
): Promise<boolean> {
  const info = resolveAgentBrowser()
  if (!info) return false
  const sessionName = session ?? namespace
  if (isAgentBrowserDaemonWarm(info.binPath, namespace, sessionName)) {
    if (agentBrowserWarmState !== 'warm') {
      agentBrowserWarmState = 'warm'
      logger.info(`Agent-browser daemon is warm (namespace: ${namespace}, session: ${sessionName})`)
    }
    return true
  }
  if (isAgentBrowserMcpChildRunning(namespace)) {
    if (agentBrowserWarmState !== 'warm') {
      agentBrowserWarmState = 'warm'
      logger.info(`Agent-browser MCP child already running (namespace: ${namespace}); skipping warm-up spawn`)
    }
    return true
  }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  delete env.AGENT_BROWSER_SESSION
  delete env.AGENT_BROWSER_NAMESPACE
  delete env.AGENT_BROWSER_EXECUTABLE_PATH
  delete env.AGENT_BROWSER_IDLE_TIMEOUT_MS
  const child = spawn(info.binPath, ['mcp', '--namespace', namespace], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let succeeded = false
  try {
    const deadline = Date.now() + 240_000
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const ok = await openViaMcp(child, remaining)
      if (ok && isAgentBrowserDaemonWarm(info.binPath, namespace, sessionName)) {
        if (agentBrowserWarmState !== 'warm') {
          agentBrowserWarmState = 'warm'
          logger.info(`Agent-browser daemon warmed up (namespace: ${namespace}, session: ${sessionName})`)
        }
        succeeded = true
        break
      }
      if (Date.now() < deadline) await sleep(5_000)
    }
  } catch (error) {
    logger.warn(`Agent-browser warm-up interrupted (namespace: ${namespace}, session: ${sessionName}):`, error)
  } finally {
    try {
      child.kill()
    } catch {
      // ignore
    }
  }
  if (succeeded) return true
  if (agentBrowserWarmState !== 'cold') {
    agentBrowserWarmState = 'cold'
    logger.warn(`Agent-browser warm-up timed out (namespace: ${namespace}, session: ${sessionName})`)
  }
  return false
}

async function openViaMcp(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  const stdout = child.stdout
  const stdin = child.stdin
  if (!stdout || !stdin) return false
  let buf = ''
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let nextId = 1
  let settled = false
  const waitResponse = new Promise<boolean>((resolve, reject) => {
    stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim()) continue
        let msg: { id?: number; result?: { isError?: boolean }; error?: { message?: string } } | null = null
        try {
          msg = JSON.parse(line) as { id?: number; result?: { isError?: boolean }; error?: { message?: string } }
        } catch {
          continue
        }
        if (!msg || msg.id === undefined) continue
        const entry = pending.get(msg.id)
        if (!entry) continue
        clearTimeout(entry.timer)
        pending.delete(msg.id)
        if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)))
        else entry.resolve(msg.result)
      }
    })
    child.on('error', (e) => reject(e))
    child.on('exit', () => {
      if (!settled) {
        settled = true
        resolve(false)
      }
    })
  })
  const send = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const id = nextId++
    const req = { jsonrpc: '2.0', id, method, params }
    stdin.write(JSON.stringify(req) + '\n')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('NO RESPONSE within timeout'))
      }, Math.max(timeoutMs, 5_000))
      pending.set(id, { resolve, reject, timer })
    })
  }
  try {
    await send('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'opencode-webui', version: '1.0.0' } })
    await send('tools/list', {})
    const res = (await send('tools/call', {
      name: 'agent_browser_open',
      arguments: { url: 'about:blank' },
    })) as { isError?: boolean } | undefined
    return res?.isError !== true
  } catch (error) {
    logger.warn(`Agent-browser MCP warm open failed:`, error)
    return false
  } finally {
    settled = true
    for (const entry of pending.values()) clearTimeout(entry.timer)
    pending.clear()
    waitResponse.catch(() => undefined)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAgentBrowserDaemonWarm(binPath: string, namespace: string, session?: string): boolean {
  try {
    const sessionName = session ?? namespace
    const output = execFileSync(binPath, ['session', 'info', '--json'], {
      env: { ...process.env, AGENT_BROWSER_NAMESPACE: namespace, AGENT_BROWSER_SESSION: sessionName },
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

function isAgentBrowserMcpChildRunning(namespace: string): boolean {
  try {
    const marker = `--namespace ${namespace}`
    if (process.platform === 'win32') {
      const script = [
        `$ps = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'agent-browser.exe' -and $_.CommandLine -like '*mcp*--namespace ${namespace}*' }`,
        'if ($ps) { Write-Output "1" } else { Write-Output "0" }',
      ].join('\n')
      const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      return output.trim().endsWith('1')
    }
    const output = execFileSync('ps', ['-eo', 'args'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return output.split('\n').some((line) => line.includes('agent-browser') && line.includes('mcp') && line.includes(marker))
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