import { spawn, execSync } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { logger } from '../utils/logger'
import { getWorkspacePath, getOpenCodeConfigFilePath, getConfigPath, ENV } from '@opencode-webui/shared'
import { getServerAuthHeader } from './opencode-auth'

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

const OPENCODE_PORT_SCAN = 20
const OPENCODE_DEFAULT_PORT = ENV.OPENCODE.PORT
const OPENCODE_SERVER_DIRECTORY = getWorkspacePath()
const OPENCODE_CONFIG_PATH = getOpenCodeConfigFilePath()

class OpenCodeServerManager {
  private static instance: OpenCodeServerManager
  private serverProcess: any = null
  private serverPid: number | null = null
  private isHealthy: boolean = false
  private isManaged: boolean = false
  private isStarting: boolean = false
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
      logger.info('OpenCode server already running and healthy')
      return
    }
    const binPath = resolveOpenCodeBin()
    if (!binPath) {
      this.isHealthy = false
      this.serverPid = null
      logger.warn('OpenCode executable not found - running without an OpenCode connection. Configure the binary path in Settings -> OpenCode, then restart the server.')
      return
    }
    this.isStarting = true
    try {
      await this.startServer(binPath)
    } finally {
      this.isStarting = false
    }
  }

  private async startServer(binPath: string): Promise<void> {
    const isDevelopment = ENV.SERVER.NODE_ENV !== 'production'
    const serverDirectory = OPENCODE_SERVER_DIRECTORY
    const source = `resolved binary: ${binPath}`
    logger.info(`Spawning OpenCode server from directory: ${serverDirectory} (${source})`)

    const base = OPENCODE_DEFAULT_PORT
    for (let offset = 0; offset < OPENCODE_PORT_SCAN; offset++) {
      const candidate = base + offset
      this.port = candidate

      if (await this.checkHealth()) {
        const existingProcesses = await this.findProcessesByPort(candidate)
        this.serverPid = existingProcesses[0]?.pid ?? null
        this.isManaged = false
        this.isHealthy = true
        logger.info(`Attaching to existing healthy OpenCode server on port ${candidate}`)
        return
      }

      await this.freePort(candidate)
      this.launch(candidate, serverDirectory, binPath, isDevelopment)

      if (await this.waitForHealth(20000)) {
        this.isHealthy = true
        logger.info(`OpenCode server is healthy on port ${candidate}`)
        return
      }

      logger.warn(`OpenCode failed to become healthy on port ${candidate}, trying next port`)
      await this.teardownCurrent()
      await new Promise((r) => setTimeout(r, 500))
    }

    throw new Error(`OpenCode server failed to become healthy on any candidate port (base ${base})`)
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
        stdio: isDevelopment ? 'inherit' : 'ignore',
        env: {
          ...process.env,
          OPENCODE_CONFIG: OPENCODE_CONFIG_PATH,
          OPENCODE_CONFIG_DIR: getConfigPath(),
        },
      }
    )

    this.serverProcess.on('error', (error: Error) => {
      logger.error('OpenCode server spawn failed:', error)
      this.isHealthy = false
      this.serverPid = null
    })

    this.serverProcess.on('exit', (code: number | null, signal: string | null) => {
      this.isHealthy = false
      this.serverPid = null
      if (signal || (code !== null && code !== 0)) {
        logger.error(`OpenCode server exited unexpectedly (signal: ${signal}, code: ${code})`)
      }
    })

    this.serverPid = this.serverProcess.pid
    this.isManaged = true
    logger.info(`OpenCode server launch requested, PID ${this.serverPid}`)
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
    await new Promise((r) => setTimeout(r, 500))
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
  }

  async stop(): Promise<void> {
    if (!this.isManaged) {
      logger.info('Skipping stop: attached to an externally managed OpenCode server')
      this.serverPid = null
      this.isHealthy = false
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

  private async findProcessesByPort(port: number): Promise<Array<{pid: number}>> {
    try {
      if (process.platform === 'win32') {
        const output = execSync('netstat -ano -p tcp').toString()
        const results: Array<{pid: number}> = []
        for (const line of output.split(/\r?\n/)) {
          const tokens = line.trim().split(/\s+/)
          if ((tokens[0] ?? '').toUpperCase() !== 'TCP') continue
          if ((tokens[3] ?? '').toUpperCase() !== 'LISTENING') continue
          const localPort = (tokens[1] ?? '').split(':').pop()
          if (localPort !== String(port)) continue
          const pid = parseInt(tokens[4] ?? '', 10)
          if (!isNaN(pid)) results.push({ pid })
        }
        return results
      }
      const pids = execSync(`lsof -ti:${port}`).toString().trim().split('\n')
      return pids.filter(Boolean).map(pid => ({ pid: parseInt(pid) }))
    } catch {
      return []
    }
  }
}

export const opencodeServerManager = OpenCodeServerManager.getInstance()
