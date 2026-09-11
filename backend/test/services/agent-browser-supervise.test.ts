import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { listAgentBrowserDaemons, superviseAgentBrowserDaemon } from '../../src/services/default-mcp'

const NS = 'opencode'

function runDir(base: string): string {
  return path.join(base, 'namespaces', NS, 'run')
}

function writeSidecars(dir: string, key: string, pid: number, port: number | null): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${key}.pid`), String(pid))
  if (port !== null) writeFileSync(path.join(dir, `${key}.port`), String(port))
}

function listen(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.end())
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port })
    })
  })
}

describe('agent-browser supervision', () => {
  let base: string
  let prevSocketDir: string | undefined
  let prevCwd: string
  const servers: net.Server[] = []
  const children: ChildProcess[] = []

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'absup-'))
    prevSocketDir = process.env.AGENT_BROWSER_SOCKET_DIR
    process.env.AGENT_BROWSER_SOCKET_DIR = base
    // resolveAgentBrowser() reads <cwd>/bin/agent-browser/.meta.json
    prevCwd = process.cwd()
    process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'))
  })

  afterEach(async () => {
    process.chdir(prevCwd)
    if (prevSocketDir === undefined) delete process.env.AGENT_BROWSER_SOCKET_DIR
    else process.env.AGENT_BROWSER_SOCKET_DIR = prevSocketDir
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()))
    servers.length = 0
    for (const c of children) {
      try {
        c.kill('SIGKILL')
      } catch {}
    }
    children.length = 0
    rmSync(base, { recursive: true, force: true })
  })

  it('cleans stale sidecars and keeps the healthy namespace daemon', async () => {
    const dir = runDir(base)
    const live = await listen()
    servers.push(live.server)
    writeSidecars(dir, NS, process.pid, live.port)
    writeSidecars(dir, 'repo-stale', 999999999, 59999)

    const result = await superviseAgentBrowserDaemon()
    expect(result.cleanedStale).toContain('repo-stale')
    expect(result.culled).toHaveLength(0)
    expect(result.warmed).toBe(false)
    const keys = listAgentBrowserDaemons().map((d) => d.key)
    expect(keys).toContain(NS)
    expect(keys).not.toContain('repo-stale')
  })

  it('leaves live daemons alone (no kill wars)', async () => {
    const dir = runDir(base)
    const main = await listen()
    servers.push(main.server)
    writeSidecars(dir, NS, process.pid, main.port)
    const extra = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000)'])
    children.push(extra)
    await new Promise((r) => setTimeout(r, 300))
    const extraPort = await listen()
    servers.push(extraPort.server)
    writeSidecars(dir, 'repo-legacy', extra.pid!, extraPort.port)

    const result = await superviseAgentBrowserDaemon()
    expect(result.culled).toHaveLength(0)
    expect(result.warmed).toBe(false)
    expect(extra.exitCode).toBeNull()
    const kept = listAgentBrowserDaemons().map((d) => d.key)
    expect(kept).toContain(NS)
    expect(kept).toContain('repo-legacy')
  }, 30000)

  it('cleans sidecars of deaf daemons without killing them', async () => {
    const dir = runDir(base)
    // survivors>0 유지용 정상 데몬 (웜업 부트 방지)
    const main = await listen()
    servers.push(main.server)
    writeSidecars(dir, NS, process.pid, main.port)
    const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000)'])
    children.push(proc)
    await new Promise((r) => setTimeout(r, 300))
    // 살아있지만 포트가 닫힘: 사이드카만 지우고 프로세스는 살린다
    writeSidecars(dir, 'repo-deaf', proc.pid!, 59999)

    const result = await superviseAgentBrowserDaemon()
    expect(result.cleanedStale).toContain('repo-deaf:unreachable')
    expect(result.culled).toHaveLength(0)
    expect(result.warmed).toBe(false)
    expect(proc.exitCode).toBeNull()
    const keys = listAgentBrowserDaemons().map((d) => d.key)
    expect(keys).toContain(NS)
    expect(keys).not.toContain('repo-deaf')
  }, 30000)
})
