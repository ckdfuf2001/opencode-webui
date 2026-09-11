import path from 'node:path'
import { spawn, execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { ENV, getWorkspacePath, getReposPath } from '@opencode-webui/shared'
import { logger } from '../utils/logger'
import { resolveDocReaderCommand } from './doc-tools'

let agentBrowserWarmState: 'warm' | 'cold' | 'unknown' = 'unknown'

const workspaceBackend = `http://127.0.0.1:${ENV.SERVER.PORT}`
const AGENT_BROWSER_NAMESPACE = 'opencode'
const AGENT_BROWSER_IDLE_TIMEOUT_MS = '86400000'
// 프록시 모드 타임아웃 (arch-to-be: 데몬 15분, 세션 TTL 10분)
const PROXY_IDLE_TIMEOUT_MS = '900000'
const PROXY_IDLE_TIMEOUT = '15m'
const PROXY_SESSION_TTL_MS = '600000'
const PROXY_SESSION_MAX = '16'
const PROXY_SESSION_SWEEP_MS = '60000'

function buildDocReaderMcp(): Record<string, unknown> {
  const reader = resolveDocReaderCommand()
  return {
    'doc-reader': {
      type: 'local',
      enabled: true,
      command: [reader.command, ...reader.args],
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
  const proxy = resolveAgentBrowserProxy(info)
  if (proxy) {
    const env: Record<string, string> = {}
    if (info.executablePath && existsSync(info.executablePath)) {
      env.AGENT_BROWSER_EXECUTABLE_PATH = info.executablePath
    }
    env.AGENT_BROWSER_NAMESPACE = namespace
    env.AGENT_BROWSER_IDLE_TIMEOUT_MS = PROXY_IDLE_TIMEOUT_MS
    env.AGENT_BROWSER_IDLE_TIMEOUT = PROXY_IDLE_TIMEOUT
    env.SESSION_TTL_MS = PROXY_SESSION_TTL_MS
    env.SESSION_MAX = PROXY_SESSION_MAX
    env.SESSION_SWEEP_MS = PROXY_SESSION_SWEEP_MS
    return {
      'agent-browser': {
        type: 'local',
        enabled: true,
        command: proxy.command,
        env,
      },
    }
  }
  const env: Record<string, string> = {}
  if (info.executablePath && existsSync(info.executablePath)) {
    env.AGENT_BROWSER_EXECUTABLE_PATH = info.executablePath
  }
  env.AGENT_BROWSER_NAMESPACE = namespace
  env.AGENT_BROWSER_SESSION = session
  env.AGENT_BROWSER_IDLE_TIMEOUT_MS = AGENT_BROWSER_IDLE_TIMEOUT_MS
  env.AGENT_BROWSER_AUTO_SESSION = '1'
  return {
    'agent-browser': {
      type: 'local',
      enabled: true,
      command: [info.binPath, 'mcp', '--namespace', namespace],
      env,
    },
  }
}

// Session Proxy (mcp-server.mjs, arch-to-be) 해결:
// 1. 패키징된 컴파일 exe: <cwd>/bin/agent-browser-proxy/agent-browser-proxy.exe
// 2. dev 폴백: node + backend/scripts/agent-browser-proxy/mcp-server.mjs
// 둘 다 없으면 null → 기존 바이너리 직결(direct)로 폴백한다.
function resolveAgentBrowserProxy(info: AgentBrowserInfo): { command: string[] } | null {
  const proxyExe = path.join(process.cwd(), 'bin', 'agent-browser-proxy', 'agent-browser-proxy.exe')
  if (existsSync(proxyExe)) {
    return { command: [proxyExe, '--cli', info.binPath, '--namespace', AGENT_BROWSER_NAMESPACE] }
  }
  const proxyMjs = path.join(process.cwd(), 'backend', 'scripts', 'agent-browser-proxy', 'mcp-server.mjs')
  if (existsSync(proxyMjs) && hasNodeRuntime()) {
    return { command: ['node', proxyMjs, '--cli', info.binPath, '--namespace', AGENT_BROWSER_NAMESPACE] }
  }
  return null
}

function hasNodeRuntime(): boolean {
  try {
    execFileSync('node', ['--version'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] })
    return true
  } catch {
    return false
  }
}

export function agentBrowserProxyMode(): boolean {
  const info = resolveAgentBrowser()
  return !!info && resolveAgentBrowserProxy(info) !== null
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

const warmUpInFlight = new Map<string, Promise<boolean>>()

export function warmUpAgentBrowserDaemon(
  namespace: string = AGENT_BROWSER_NAMESPACE,
  session?: string,
): Promise<boolean> {
  const key = `${namespace}::${session ?? namespace}`
  const existing = warmUpInFlight.get(key)
  if (existing) return existing
  const flight = doWarmUp(namespace, session).finally(() => {
    warmUpInFlight.delete(key)
  })
  warmUpInFlight.set(key, flight)
  return flight
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
  // MCP 자식 프로세스가 살아 있어도 데몬/브라우저가 cold 면 호출은 32001 로 실패한다.
  // 예전에는 여기서 warm 으로 오판하고 spawn 을 건너뛰었다. 이제는 건너뛰지 않고
  // 아래에서 실제 open 으로 데몬을 깨운다. (방금 확인: active:false 인데도
  // "MCP child already running; skipping" 으로 리턴하던 버그)
  if (isAgentBrowserMcpChildRunning(namespace)) {
    logger.info(`Agent-browser MCP child running but daemon cold (namespace: ${namespace}, session: ${sessionName}); re-warming`)
  }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  // warmup으로 띄우는 데몬이 실제 사용 데몬과 같은 설정이어야 한다.
  // env를 비우면(strip) session 데몬이 다른 설정으로 떠서
  // "started concurrently with different daemon configuration" 충돌이 난다.
  if (info.executablePath && existsSync(info.executablePath)) {
    env.AGENT_BROWSER_EXECUTABLE_PATH = info.executablePath
  }
  const proxy = resolveAgentBrowserProxy(info)
  let command: string[]
  if (proxy) {
    // 프록시 경유 warmup: 같은 데몬(핀 네임스페이스)을 깨운다.
    // SESSION 고정은 프록시 설계상 금지이므로 env에 넣지 않는다.
    command = proxy.command
  } else {
    env.AGENT_BROWSER_NAMESPACE = namespace
    env.AGENT_BROWSER_SESSION = sessionName
    env.AGENT_BROWSER_IDLE_TIMEOUT_MS = AGENT_BROWSER_IDLE_TIMEOUT_MS
    env.AGENT_BROWSER_AUTO_SESSION = '1'
    command = [info.binPath, 'mcp', '--namespace', namespace]
  }
  const child = spawn(command[0]!, command.slice(1), {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let succeeded = false
  try {
    // v0.35+ resolves the cold-start pipe-inheritance hang, so first launch
    // returns in seconds. Bound the retry loop: overlapping warmup cycles
    // pile up MCP children and Chrome launches (OOM).
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const ok = await openViaMcp(child, remaining, !!proxy, namespace, sessionName)
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

async function openViaMcp(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  useProxy = false,
  namespace: string = AGENT_BROWSER_NAMESPACE,
  session = AGENT_BROWSER_NAMESPACE,
): Promise<boolean> {
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
    if (useProxy) {
      // 프록시는 세션 필수: warmup용 세션을 ensure(reuse) 후 open.
      // warmup 자식의 레지스트리는 버려지고, 데몬/브라우저 기동만 남는다.
      const warmSession = `warmup-${session}`.slice(0, 64)
      await send('tools/call', {
        name: 'agent_browser_session_ensure',
        arguments: { namespace, session: warmSession, reuse: true },
      })
      const res = (await send('tools/call', {
        name: 'agent_browser_open',
        arguments: { namespace, session: warmSession, url: 'about:blank' },
      })) as { isError?: boolean } | undefined
      return res?.isError !== true
    }
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

export function getAgentBrowserDaemonStatus(
  namespace: string = AGENT_BROWSER_NAMESPACE,
  session?: string,
): { warm: boolean; mcpChildRunning: boolean; session: string } {
  const info = resolveAgentBrowser()
  const sessionName = session ?? namespace
  const warm = info ? isAgentBrowserDaemonWarm(info.binPath, namespace, sessionName) : false
  return { warm, mcpChildRunning: isAgentBrowserMcpChildRunning(namespace), session: sessionName }
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
        `$ps = Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'agent-browser.exe' -and $_.CommandLine -like '*mcp*--namespace ${namespace}*') -or ($_.Name -eq 'agent-browser-proxy.exe') -or ($_.CommandLine -like '*mcp-server.mjs*') }`,
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
    return output.split('\n').some((line) =>
      (line.includes('agent-browser') && line.includes('mcp') && line.includes(marker)) ||
      line.includes('agent-browser-proxy') ||
      line.includes('mcp-server.mjs'),
    )
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
    if (defaultEnv) {
      const repairedEnv = { ...((existing.env as Record<string, string>) ?? {}) }
      for (const [key, value] of Object.entries(defaultEnv)) {
        if (repairedEnv[key] !== value) {
          repairedEnv[key] = value
          changed = true
        }
      }
      // 프록시 모드에서는 직결 시절 키가 남으면 안 된다 (SESSION 고정 등).
      // opencode가 env를 전달하지 않아 무해하지만, 혼란 방지를 위해 제거한다.
      if (id === 'agent-browser' && agentBrowserProxyMode()) {
        for (const stale of ['AGENT_BROWSER_SESSION', 'AGENT_BROWSER_AUTO_SESSION']) {
          if (stale in repairedEnv) {
            delete repairedEnv[stale]
            changed = true
          }
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

// On Windows the agent-browser daemon/MCP children inherit the opencode
// project directory as their working directory. That working directory is a
// handle on the repo folder: recursive rm then fails with EBUSY/EPERM even
// after the opencode server is restarted, because the detached daemon and its
// Chrome tree outlive the MCP children. Kill the whole tree (daemon, MCP
// children, chrome, doc reader) before deleting a repo so the handles release.
export function releaseAgentBrowserForDirectory(_directory: string): void {
  if (process.platform !== 'win32') {
    return
  }
  if (typeof process.env.TEMP !== 'string') {
    return
  }
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$processes = Get-CimInstance Win32_Process | Where-Object {',
    "  ($_.Name -eq 'agent-browser.exe') -or",
    "  ($_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*agent-browser*') -or",
    "  ($_.CommandLine -like '*doc_reader_mcp.py*')",
    '}',
    'foreach ($process in $processes) {',
    '  taskkill /PID $process.ProcessId /T /F | Out-Null',
    '}',
  ].join('\n')
  const scriptPath = path.join(process.env.TEMP, `opencode-webui-repo-cleanup-${process.pid}.ps1`)
  try {
    writeFileSync(scriptPath, script, 'utf8')
    execSync(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`, {
      stdio: 'ignore',
      timeout: 20_000,
    })
    logger.info(`Released agent-browser handles for directory: ${_directory}`)
  } catch {
    logger.warn(`Failed to release agent-browser handles for directory: ${_directory}`)
  } finally {
    try {
      rmSync(scriptPath, { force: true })
    } catch {
      // ignore cleanup of the temp script
    }
  }
}