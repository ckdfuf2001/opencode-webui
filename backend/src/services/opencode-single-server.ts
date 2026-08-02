import { spawn, execSync } from 'child_process'
import { logger } from '../utils/logger'
import { getWorkspacePath, getOpenCodeConfigFilePath, ENV } from '@opencode-webui/shared'
import { getServerAuthHeader } from './opencode-auth'

const OPENCODE_SERVER_PORT = ENV.OPENCODE.PORT
const OPENCODE_BIN = ENV.OPENCODE.BIN
const OPENCODE_SERVER_DIRECTORY = getWorkspacePath()
const OPENCODE_CONFIG_PATH = getOpenCodeConfigFilePath()

class OpenCodeServerManager {
  private static instance: OpenCodeServerManager
  private serverProcess: any = null
  private serverPid: number | null = null
  private isHealthy: boolean = false
  private isManaged: boolean = false

  private constructor() {}

  static getInstance(): OpenCodeServerManager {
    if (!OpenCodeServerManager.instance) {
      OpenCodeServerManager.instance = new OpenCodeServerManager()
    }
    return OpenCodeServerManager.instance
  }

  async start(): Promise<void> {
    if (this.isHealthy) {
      logger.info('OpenCode server already running and healthy')
      return
    }

    if (await this.checkHealth()) {
      logger.info(`Attaching to existing OpenCode server on port ${OPENCODE_SERVER_PORT}`)
      const existingProcesses = await this.findProcessesByPort(OPENCODE_SERVER_PORT)
      this.serverPid = existingProcesses[0]?.pid ?? null
      this.isManaged = false
      this.isHealthy = true
      return
    }

    const isDevelopment = ENV.SERVER.NODE_ENV !== 'production'

    const existingProcesses = await this.findProcessesByPort(OPENCODE_SERVER_PORT)
    if (existingProcesses.length > 0) {
      logger.warn('Killing unhealthy OpenCode server occupying the port')
      for (const proc of existingProcesses) {
        try {
          process.kill(proc.pid, 'SIGKILL')
        } catch (error) {
          logger.warn(`Failed to kill process ${proc.pid}:`, error)
        }
      }
      await new Promise(r => setTimeout(r, 1000))
    }

    const serverDirectory = process.cwd()
    logger.info(`Starting OpenCode server from current directory: ${serverDirectory}`)

    this.serverProcess = spawn(
      OPENCODE_BIN,
      ['serve', '--port', OPENCODE_SERVER_PORT.toString(), '--hostname', ENV.OPENCODE.HOST],
      {
        cwd: serverDirectory,
        detached: !isDevelopment,
        stdio: isDevelopment ? 'inherit' : 'ignore',
        env: { ...process.env },
      }
    )

    this.serverPid = this.serverProcess.pid
    this.isManaged = true

    logger.info(`OpenCode server started with PID ${this.serverPid}`)

    const healthy = await this.waitForHealth(30000)
    if (!healthy) {
      throw new Error('OpenCode server failed to become healthy')
    }

    this.isHealthy = true
    logger.info('OpenCode server is healthy')
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

    this.serverPid = null
    this.isHealthy = false
    this.isManaged = false
  }

  async restart(): Promise<void> {
    if (!this.isManaged) {
      logger.warn('Skipping restart: attached to an externally managed OpenCode server')
      return
    }
    logger.info('Restarting OpenCode server')
    await this.stop()
    await new Promise(r => setTimeout(r, 1000))
    await this.start()
  }

  getPort(): number {
    return OPENCODE_SERVER_PORT
  }

  async checkHealth(): Promise<boolean> {
    try {
      const headers: Record<string, string> = {}
      const auth = getServerAuthHeader()
      if (auth) headers.Authorization = auth
      const response = await fetch(`http://${ENV.OPENCODE.HOST}:${OPENCODE_SERVER_PORT}/doc`, {
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
