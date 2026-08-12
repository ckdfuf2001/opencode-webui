import { spawn, execSync } from 'child_process'
import { existsSync, writeFileSync, rmSync } from 'fs'
import { createServer } from 'node:net'
import path from 'path'
import { logger } from '../utils/logger'
import { getWorkspacePath, getOpenCodeConfigFilePath, getConfigPath, ENV } from '@opencode-webui/shared'
import { getServerAuthHeader } from './opencode-auth'
import { killLingeringAgentBrowser } from './default-mcp'

let preferredOpenCodeBin: string | null = null
let cachedBinary: string | null | undefined

function scanForBinary(): string | null {
  const candidates: string[] = []

  const preferred = (preferredOpenCodeBin || '').trim()
  if (preferred) {
    if (path.isAbsolute(preferred) && existsSync(preferred)) {
      return preferred
    }
    candidates.push(preferred)
  }

  const configured = (ENV.OPENCODE.BIN || '').trim()
  if (configured) {
    if (path.isAbsolute(configured) && existsSync(configured)) {
      return configured
    }
    candidates.push(configured)
  }

  const home = process.env.USERPROFILE || process.env.HOME || ''
  const appData = process.env.APPDATA || ''
  const localAppData = process.env.LOCALAPPDATA || ''
  const cwdRoot = path.join(process.cwd(), 'bin')
  const workspaceRoot = path.join(getWorkspacePath(), 'bin')

  for (const root of [cwdRoot, workspaceRoot]) {
    candidates.push(path.join(root, 'opencode.exe'))
    candidates.push(path.join(root, 'opencode'))
  }

  const npmRoots: string[] = []
  try {
    const prefix = execSync('npm config get prefix', { encoding: 'utf8' }).trim()
    if (prefix) npmRoots.push(prefix)
  } catch {
    // npm unavailable; fall back to well-known locations
  }
  if (appData) npmRoots.push(path.join(appData, 'npm'))
  if (localAppData) npmRoots.push(path.join(localAppData, 'npm'))

  for (const root of npmRoots) {
    candidates.push(path.join(root, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'))
  }

  if (home) {
    candidates.push(path.join(home, '.bun', 'bin', 'opencode.exe'))
    candidates.push(path.join(home, '.bun', 'bin', 'opencode'))
    candidates.push(path.join(home, '.opencode', 'bin', 'opencode.exe'))
    candidates.push(path.join(home, '.opencode', 'bin', 'opencode'))
  }
  if (localAppData) {
    candidates.push(path.join(localAppData, 'opencode', 'bin', 'opencode.exe'))
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate
    }
  }

  try {
    const output = execSync(
      process.platform === 'win32' ? 'where opencode' : 'which opencode',
      { encoding: 'utf8' }
    ).toString()
    for (const line of output.split(/\r?\n/)) {
      const p = line.trim().split(/\s+/)[0]
      if (!p) continue
      let resolved = p
      if (p.toLowerCase().endsWith('.cmd')) {
        const real = p.slice(0, -4)
        if (existsSync(real)) resolved = real
      }
      if (!resolved || !existsSync(resolved)) continue
      if (process.platform !== 'win32' || /\.exe$/i.test(resolved)) {
        return resolved
      }
    }
  } catch {
    // command not on PATH
  }

  return null
}

function resolveOpenCodeBin(): string | null {
  if (cachedBinary === undefined) {
    cachedBinary = scanForBinary()
  }
  return cachedBinary
}

function invalidateBinaryCache(): void {
  cachedBinary = undefined
}

const OPENCODE_DEFAULT_PORT = ENV.OPENCODE.PORT
const OPENCODE_SERVER_DIRECTORY = getWorkspacePath()
const OPENCODE_CONFIG_PATH = getOpenCodeConfigFilePath()

export function killLingeringOpenCodeServers(): void {
  if (process.platform !== 'win32') {
    return
  }
  if (typeof process.env.TEMP !== 'string') {
    return
  }
  const script = [
    '$defaultPort = ' + OPENCODE_DEFAULT_PORT,
    '$processes = Get-CimInstance Win32_Process | Where-Object {',
    "  ($_.Name -ieq 'opencode.exe') -and",
    "  ($_.CommandLine -like '*serve*') -and",
    "  ($_.CommandLine -like '*--port*')",
    '}',
    'foreach ($process in $processes) {',
    "  $m = [regex]::Match($process.CommandLine, '--port[ =](\\d+)')",
    '  if (-not $m.Success) { continue }',
    '  $port = [int]$m.Groups[1].Value',
    '  if ($port -eq $defaultPort) { continue }',
    "  Write-Host \"Killing lingering OpenCode server on port $port (PID $($process.ProcessId))\"",
    '  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue',
    '}',
  ].join('\n')
  const scriptPath = path.join(process.env.TEMP, `opencode-webui-opencode-cleanup-${process.pid}.ps1`)
  try {
    writeFileSync(scriptPath, script, 'utf8')
    execSync(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`, {
      stdio: 'ignore',
      timeout: 15_000,
    })
    logger.info('Cleaned up lingering OpenCode servers on non-default ports')
  } catch {
    logger.warn('Failed to clean up lingering OpenCode server processes')
  } finally {
    try {
      rmSync(scriptPath, { force: true })
    } catch {
      // ignore cleanup of the temp script
    }
  }
}

class OpenCodeServerManager {
  private static instance: OpenCodeServerManager
  private serverProcess: any = null
  private serverPid: number | null = null
  private isHealthy: boolean = false
  private isManaged: boolean = false
  private isStarting: boolean = false
  private hasLoggedHealthy: boolean = false
  private port: number = OPENCODE_DEFAULT_PORT

  private constructor() {}

  static getInstance(): OpenCodeServerManager {
    if (!OpenCodeServerManager.instance) {
      OpenCodeServerManager.instance = new OpenCodeServerManager()
    }
    return OpenCodeServerManager.instance
  }

  setPreferredBinPath(binPath: string | null | undefined): void {
    const normalized = (binPath || '').trim() || null
    if (normalized === preferredOpenCodeBin) return
    preferredOpenCodeBin = normalized
    invalidateBinaryCache()
    logger.info(
      normalized
        ? `Configured OpenCode binary path: ${normalized}`
        : 'Cleared preferred OpenCode binary path'
    )
  }

  async ensureRunning(): Promise<void> {
    if (await this.checkHealth()) {
      this.isHealthy = true
      return
    }
    await this.start()
  }

  async start(): Promise<void> {
    if (this.isHealthy || this.isStarting) {
      if (!this.hasLoggedHealthy) {
        this.hasLoggedHealthy = true
        logger.info('OpenCode server already running and healthy')
      }
      return
    }
    const binPath = resolveOpenCodeBin()
    if (!binPath) {
      this.isHealthy = false
      this.hasLoggedHealthy = false
      this.serverPid = null
      logger.warn('OpenCode executable not found - running without an OpenCode connection. Configure the binary path in Settings -> OpenCode, then restart the server.')
      return
    }
    this.isStarting = true
    try {
      if (this.serverPid) {
        if (await this.waitForHealth(20000)) {
          this.isHealthy = true
          logger.info(`OpenCode server is healthy on port ${this.port}`)
          return
        }
        await this.teardownCurrent()
      }
      await this.startServer(binPath)
    } finally {
      this.isStarting = false
    }
  }

  spawnNow(): void {
    if (this.serverPid || this.isHealthy) return
    const binPath = resolveOpenCodeBin()
    if (!binPath) return
    const existing = this.findPidsByPortSync(this.port)
    if (existing.length > 0) {
      logger.info(`Port ${this.port} is occupied; deferring OpenCode launch to start()`)
      return
    }
    this.port = OPENCODE_DEFAULT_PORT
    this.launch(this.port, OPENCODE_SERVER_DIRECTORY, binPath, ENV.SERVER.NODE_ENV !== 'production')
  }

  private async startServer(binPath: string): Promise<void> {
    const isDevelopment = ENV.SERVER.NODE_ENV !== 'production'
    const serverDirectory = OPENCODE_SERVER_DIRECTORY
    const source = `resolved binary: ${binPath}`
    logger.info(`Spawning OpenCode server from directory: ${serverDirectory} (${source})`)

    const candidate = OPENCODE_DEFAULT_PORT
    this.port = candidate

    if (await this.checkHealth()) {
      const existingProcesses = await this.findProcessesByPort(candidate)
      this.serverPid = existingProcesses[0]?.pid ?? null
      this.isManaged = false
      this.isHealthy = true
      logger.info(`Attaching to existing healthy OpenCode server on port ${candidate}`)
      return
    }

    this.launch(candidate, serverDirectory, binPath, isDevelopment)

    if (!(await this.waitForHealth(20000))) {
      logger.warn(`OpenCode failed to become healthy on port ${candidate}`)
      if (this.serverPid) {
        await this.teardownCurrent()
      }
      throw new Error(`OpenCode server failed to become healthy on port ${candidate}`)
    }

    this.isHealthy = true
    logger.info(`OpenCode server is healthy on port ${candidate}`)
  }

  private launch(
    port: number,
    serverDirectory: string,
    binPath: string,
    isDevelopment: boolean,
  ): void {
    logger.info(`Launching OpenCode server on port ${port} (resolved binary: ${binPath})`)

    const isKnownPath = path.isAbsolute(binPath) && existsSync(binPath)
    this.serverProcess = spawn(
      binPath,
      ['serve', '--port', port.toString(), '--hostname', ENV.OPENCODE.HOST],
      {
        cwd: serverDirectory,
        shell: process.platform === 'win32' && !isKnownPath,
        detached: !isDevelopment,
        stdio: isDevelopment ? ['ignore', 'pipe', 'pipe'] : 'ignore',
        env: {
          ...process.env,
          OPENCODE_CONFIG: OPENCODE_CONFIG_PATH,
          OPENCODE_CONFIG_DIR: getConfigPath(),
        },
      }
    )

    if (isDevelopment) {
      this.serverProcess.stdout?.on('data', (data: Buffer) => {
        logger.info(`[opencode] ${data.toString().trimEnd()}`)
      })
      this.serverProcess.stderr?.on('data', (data: Buffer) => {
        logger.info(`[opencode] ${data.toString().trimEnd()}`)
      })
    }

    this.serverProcess.on('error', (error: Error) => {
      logger.error('OpenCode server spawn failed:', error)
      this.isHealthy = false
      this.hasLoggedHealthy = false
      this.serverPid = null
    })

    this.serverProcess.on('exit', (code: number | null, signal: string | null) => {
      this.isHealthy = false
      this.hasLoggedHealthy = false
      this.serverPid = null
      if (signal || (code !== null && code !== 0)) {
        logger.error(`OpenCode server exited unexpectedly (signal: ${signal}, code: ${code})`)
      }
    })

    this.serverPid = this.serverProcess.pid
    this.isManaged = true
    logger.info(`OpenCode server launch requested, PID ${this.serverPid}`)
  }

  private async waitForPortFree(port: number, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const procs = await this.findProcessesByPort(port)
      if (procs.length === 0) return true
      await new Promise((r) => setTimeout(r, 200))
    }
    return false
  }

  private async freePort(port: number): Promise<void> {
    const existingProcesses = await this.findProcessesByPort(port)
    if (existingProcesses.length === 0) return
    logger.warn(`Port ${port} is occupied, attempting to free it`)
    for (const proc of existingProcesses) {
      if (this.serverPid === proc.pid) continue
      try {
        process.kill(proc.pid, 'SIGKILL')
      } catch (error) {
        logger.warn(`Failed to kill process ${proc.pid} on port ${port}:`, error)
      }
    }
    if (!(await this.waitForPortFree(port))) {
      logger.warn(`Port ${port} is still occupied after termination attempt`)
    }
  }

  public async freePortPublic(port: number): Promise<void> {
    return this.freePort(port)
  }

  public async findProcessesByPortPublic(port: number): Promise<Array<{pid: number}>> {
    return this.findProcessesByPort(port)
  }

  private async httpResponds(port: number): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal })
      clearTimeout(timer)
      return res.ok
    } catch {
      return false
    }
  }

  private async isOurBackend(port: number): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal })
      clearTimeout(timer)
      if (!res.ok) return false
      const body = (await res.json()) as Record<string, unknown>
      return (
        typeof body.database === 'string' &&
        typeof body.opencode === 'string' &&
        typeof body.opencodePort === 'number'
      )
    } catch {
      return false
    }
  }

  public async isOurBackendPublic(port: number): Promise<boolean> {
    return this.isOurBackend(port)
  }

  public async httpRespondsPublic(port: number): Promise<boolean> {
    return this.httpResponds(port)
  }

  public async canBindPortPublic(port: number): Promise<boolean> {
    return this.canBindPort(port)
  }

  private async teardownCurrent(): Promise<void> {
    const port = this.port
    if (this.serverPid) {
      try {
        process.kill(this.serverPid, 'SIGKILL')
      } catch {
        // already terminated
      }
    }
    const procs = await this.findProcessesByPort(port)
    for (const proc of procs) {
      try {
        process.kill(proc.pid, 'SIGKILL')
      } catch {
        // already terminated
      }
    }
    this.serverPid = null
    this.isHealthy = false
    this.hasLoggedHealthy = false
  }

  async stop(): Promise<void> {
    if (!this.isManaged) {
      logger.info('Skipping stop: attached to an externally managed OpenCode server')
      this.serverPid = null
      this.isHealthy = false
      this.hasLoggedHealthy = false
      return
    }
    if (!this.serverPid) return

    logger.info('Stopping OpenCode server')
    try {
      process.kill(this.serverPid, 'SIGTERM')
    } catch (error) {
      logger.warn(`Failed to send SIGTERM to ${this.serverPid}:`, error)
    }

    await new Promise(r => setTimeout(r, 2000))

    try {
      process.kill(this.serverPid, 0)
      process.kill(this.serverPid, 'SIGKILL')
    } catch {
      // already terminated
    }

    try {
      const procs = await this.findProcessesByPort(this.port)
      for (const proc of procs) {
        try {
          process.kill(proc.pid, 'SIGKILL')
        } catch {
          // already terminated
        }
      }
    } catch (error) {
      logger.warn('Failed to clean up OpenCode processes on port:', error)
    }

    this.serverPid = null
    this.isHealthy = false
    this.isManaged = false
    this.hasLoggedHealthy = false
  }

  async restart(): Promise<void> {
    logger.info('Restarting OpenCode server')
    invalidateBinaryCache()
    await this.stop()
    await new Promise(r => setTimeout(r, 1000))
    await this.start()
  }

  getPort(): number {
    return this.port
  }

  getUrl(): string {
    return `http://${ENV.OPENCODE.HOST}:${this.port}`
  }

  async checkHealth(): Promise<boolean> {
    try {
      const headers: Record<string, string> = {}
      const auth = getServerAuthHeader()
      if (auth) headers.Authorization = auth
      const response = await fetch(`${this.getUrl()}/doc`, {
        headers,
        signal: AbortSignal.timeout(3000)
      })
      return response.ok
    } catch {
      return false
    }
  }

  private async waitForHealth(timeoutMs: number): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await this.checkHealth()) {
        return true
      }
      await new Promise(r => setTimeout(r, 500))
    }
    return false
  }

  private findPidsByPortSync(port: number): number[] {
    try {
      if (process.platform !== 'win32') {
        const pids = execSync(`lsof -ti:${port}`).toString().trim().split('\n')
        return pids.filter(Boolean).map(pid => parseInt(pid))
      }
      const output = execSync('netstat -ano -p tcp').toString()
      const results: number[] = []
      for (const line of output.split(/\r?\n/)) {
        const tokens = line.trim().split(/\s+/)
        if ((tokens[0] ?? '').toUpperCase() !== 'TCP') continue
        if ((tokens[3] ?? '').toUpperCase() !== 'LISTENING') continue
        const localPort = (tokens[1] ?? '').split(':').pop()
        if (localPort !== String(port)) continue
        const pid = parseInt(tokens[4] ?? '', 10)
        if (isNaN(pid)) continue
        if (!this.pidExists(pid)) continue
        results.push(pid)
      }
      return results
    } catch {
      return []
    }
  }

  private async findProcessesByPort(port: number): Promise<Array<{pid: number}>> {
    return this.findPidsByPortSync(port).map(pid => ({ pid }))
  }

  private pidExists(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private async canBindPort(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => {
        server.close(() => resolve(true))
      })
      server.listen(port, '127.0.0.1')
    })
  }
}

export const opencodeServerManager = OpenCodeServerManager.getInstance()

export async function freePort(port: number): Promise<void> {
  return opencodeServerManager.freePortPublic(port)
}

export async function prepareBackendPort(port: number): Promise<void> {
  killLingeringOpenCodeServers()
  if (await opencodeServerManager.canBindPortPublic(port)) return

  if (await opencodeServerManager.isOurBackendPublic(port)) {
    logger.info(`Port ${port} already serves this app; reusing existing instance`)
    process.exit(0)
  }

  if (await opencodeServerManager.httpRespondsPublic(port)) {
    throw new Error(`Port ${port} is in use by another application. Stop it or change PORT in .env.`)
  }

  logger.warn(`Port ${port} is occupied by a stale process; freeing it`)
  await opencodeServerManager.freePortPublic(port)
  killLingeringAgentBrowser()

  const waitMs = 20000
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (await opencodeServerManager.canBindPortPublic(port)) return
    await new Promise((r) => setTimeout(r, 500))
  }

  throw new Error(
    `Port ${port} is held by a process that could not be freed. Stop it manually or change PORT in .env.`
  )
}
