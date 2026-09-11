import path from 'node:path'
import net from 'node:net'
import { spawn, execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { ENV, getWorkspacePath, getReposPath, getOpenCodeConfigFilePath } from '@opencode-webui/shared'
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

/**
 * agent-browser 데몬 정체성을 고정하는 env. opencode 서버 spawn env에 넣어
 * 트리 전체(서버 → MCP 프록시 → 단발 CLI → 데몬)가 같은 네임스페이스·실행파일·
 * 지문을 공유하게 한다. opencode는 MCP entry의 env를 자식에게 전달하지 않으므로
 * (2026-08 확인) 서버 env 상속이 유일한 통로다. 없으면 세션마다 데몬+Chrome이
 * 따로 뜨고 지문 불일치로 재시작 전쟁 → 10060/OOM.
 */
export function agentBrowserEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  const info = resolveAgentBrowser()
  if (info?.executablePath && existsSync(info.executablePath)) {
    env.AGENT_BROWSER_EXECUTABLE_PATH = info.executablePath
  }
  env.AGENT_BROWSER_NAMESPACE = AGENT_BROWSER_NAMESPACE
  env.AGENT_BROWSER_IDLE_TIMEOUT_MS = PROXY_IDLE_TIMEOUT_MS
  env.AGENT_BROWSER_IDLE_TIMEOUT = PROXY_IDLE_TIMEOUT
  return env
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

// 레포별 opencode.json의 agent-browser 항목 제거.
// 전역 설정(syncDefaultConfigToDisk)이 이미 동일한 프록시 항목을 가지고 있어
// 레포별 중복은 override만 할 뿐 MCP를 하나 더 띄우지 않는다 — 그래도 혼란과
// 구버전 direct 잔재를 없애기 위해 단일 전역으로 정리한다.
// - 우리 항목(명령에 agent-browser/mcp-server.mjs 포함)만 제거하고,
//   사용자가 직접 넣은同名 항목은 건드리지 않는다.
// - 제거 후 빈 객체만 남으면 파일 자체를 지운다(원래 없던 상태로 복원).
// - enabled:false 로 꺼둔 레포는 꺼둠을 유지하기 위해 항목을 남긴다.
// 변경이 있으면 true.
export function removeRepoAgentBrowserEntry(localPath: string): boolean {
  const repoDir = path.join(getReposPath(), localPath)
  if (!existsSync(repoDir)) return false
  const configPath = path.join(repoDir, 'opencode.json')
  let existing: Record<string, unknown>
  try {
    existing = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  } catch {
    return false
  }
  if (!existing || typeof existing !== 'object') return false
  const existingMcp = (existing.mcp && typeof existing.mcp === 'object')
    ? (existing.mcp as Record<string, unknown>)
    : null
  if (!existingMcp || !('agent-browser' in existingMcp)) return false
  const entry = existingMcp['agent-browser'] as { enabled?: boolean; command?: unknown } | undefined
  if (entry?.enabled === false) return false
  const cmd = Array.isArray(entry?.command) ? entry.command.map(String).join(' ') : ''
  if (!/agent-browser|mcp-server\.mjs/.test(cmd)) {
    logger.info(`Kept custom agent-browser entry in '${configPath}' (not ours)`)
    return false
  }
  const { ['agent-browser']: _removed, ...restMcp } = existingMcp
  void _removed
  const { mcp: _mcp, ...rest } = existing
  void _mcp
  if (Object.keys(restMcp).length > 0) {
    writeFileSync(configPath, JSON.stringify({ ...rest, mcp: restMcp }, null, 2))
  } else if (Object.keys(rest).length > 0) {
    writeFileSync(configPath, JSON.stringify(rest, null, 2))
  } else {
    try {
      rmSync(configPath, { force: true })
    } catch {
      return false
    }
  }
  logger.info(`Removed per-repo agent-browser entry from '${configPath}' (single global MCP now)`)
  return true
}

const warmUpInFlight = new Map<string, Promise<boolean>>()
// 데몬 웜업 전역 뮤텍스: 세션이 달라도 데몬·Chrome은 공유되므로,
// 병렬 웜업은 Chrome 동시 기동(10060/OOM)만 부른다. 진행 중인 웜업이
// 있으면 새 세션도 거기에 붙는다.
let globalWarmUpInFlight: Promise<boolean> | null = null

export function warmUpAgentBrowserDaemon(
  namespace: string = AGENT_BROWSER_NAMESPACE,
  session?: string,
): Promise<boolean> {
  const key = `${namespace}::${session ?? namespace}`
  const existing = warmUpInFlight.get(key)
  if (existing) return existing
  if (globalWarmUpInFlight) {
    warmUpInFlight.set(key, globalWarmUpInFlight)
    globalWarmUpInFlight.finally(() => {
      if (warmUpInFlight.get(key) === globalWarmUpInFlight) warmUpInFlight.delete(key)
    })
    return globalWarmUpInFlight
  }
  const flight = doWarmUp(namespace, session).finally(() => {
    warmUpInFlight.delete(key)
    if (globalWarmUpInFlight === flight) globalWarmUpInFlight = null
  })
  warmUpInFlight.set(key, flight)
  globalWarmUpInFlight = flight
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

export interface AgentBrowserDaemonInfo {
  key: string
  dir: string
  pid: number | null
  port: number | null
  alive: boolean
  portOpen: boolean
  namespaced: boolean
}

export interface SupervisionResult {
  daemons: AgentBrowserDaemonInfo[]
  cleanedStale: string[]
  culled: number[]
  warmed: boolean
}

const DAEMON_SIDECAR_SUFFIXES = ['pid', 'port', 'config', 'version', 'stream'] as const

function agentBrowserSocketBase(): string {
  const override = process.env.AGENT_BROWSER_SOCKET_DIR
  if (override) return override
  const runtimeDir = process.env.XDG_RUNTIME_DIR
  if (runtimeDir) return path.join(runtimeDir, 'agent-browser')
  const home = process.env.USERPROFILE || process.env.HOME
  if (home) return path.join(home, '.agent-browser')
  return path.join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'agent-browser')
}

function agentBrowserRunDir(): string {
  return path.join(agentBrowserSocketBase(), 'namespaces', AGENT_BROWSER_NAMESPACE, 'run')
}

function readSidecarInt(dir: string, key: string, suffix: string): number | null {
  try {
    const raw = readFileSync(path.join(dir, `${key}.${suffix}`), 'utf8').trim()
    const parsed = parseInt(raw, 10)
    return isNaN(parsed) ? null : parsed
  } catch {
    return null
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string })?.code === 'EPERM'
  }
}

function tcpProbe(port: number, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => {
      try {
        socket.destroy()
      } catch {
        // ignore
      }
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.on('connect', () => {
      clearTimeout(timer)
      done(true)
    })
    socket.on('error', () => {
      clearTimeout(timer)
      done(false)
    })
  })
}

function deleteDaemonSidecars(dir: string, key: string): void {
  for (const suffix of DAEMON_SIDECAR_SUFFIXES) {
    try {
      rmSync(path.join(dir, `${key}.${suffix}`), { force: true })
    } catch {
      // ignore
    }
  }
}

function sidecarMtimeMs(dir: string, key: string): number {
  try {
    return statSync(path.join(dir, `${key}.pid`)).mtimeMs
  } catch {
    return 0
  }
}

function killProcessTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', timeout: 15_000 })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    // already gone
  }
}

export function listAgentBrowserDaemons(): AgentBrowserDaemonInfo[] {
  const out: AgentBrowserDaemonInfo[] = []
  for (const dir of [agentBrowserRunDir(), agentBrowserSocketBase()]) {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.endsWith('.pid')) continue
      const key = name.slice(0, -4)
      const pid = readSidecarInt(dir, key, 'pid')
      out.push({
        key,
        dir,
        pid,
        port: readSidecarInt(dir, key, 'port'),
        alive: pid !== null && pidAlive(pid),
        portOpen: false,
        namespaced: key === AGENT_BROWSER_NAMESPACE,
      })
    }
  }
  return out
}

/**
 * agent-browser 데몬 관리자. MCP 등록 상태와 무관하게 백엔드가 살아있는 동안
 * 매 틱(60s) 호출된다:
 * 1. 죽은 pid의 stale 사이드카를 지운다 (좀비 포트 10060 방지: 다음 ensure가
 *    새로 띄우도록)
 * 2. 살아있는 데몬이 2개 이상이면 네임스페이스 데몬 1개만 남기고 정리한다.
 *    네임스페이스 데몬이 없으면 가장 최근 1개만 살리고 나머지를 정리한다
 *    (수정 전 바이너리 시절의 세션별 데몬 잔해 수습).
 *    정리는 taskkill /T 로 크롬 트리까지 함께 죽인다.
 * 3. 살아있는 데몬이 하나도 없으면 기존 warm-up으로 1개를 깨운다.
 * Chrome을 선제 기동하지는 않는다: recover는 다음 ensure 호출에 맡긴다 (lazy).
 */
export async function superviseAgentBrowserDaemon(): Promise<SupervisionResult> {
  const empty: SupervisionResult = { daemons: [], cleanedStale: [], culled: [], warmed: false }
  if (!resolveAgentBrowser()) return empty
  const daemons = listAgentBrowserDaemons()
  for (const daemon of daemons) {
    daemon.portOpen = daemon.alive && daemon.port !== null ? await tcpProbe(daemon.port) : false
  }
  const cleanedStale: string[] = []
  const culled: number[] = []
  for (const daemon of daemons) {
    if (!daemon.alive) {
      deleteDaemonSidecars(daemon.dir, daemon.key)
      cleanedStale.push(daemon.key)
    }
  }
  const healthy = daemons.filter((d) => d.alive && d.portOpen)
  const namespaced = healthy.filter((d) => d.namespaced)
  if (namespaced.length >= 1) {
    const keep = newestFirst(namespaced)[0]!
    for (const daemon of healthy) {
      if (daemon === keep) continue
      if (daemon.pid !== null) {
        killProcessTree(daemon.pid)
        culled.push(daemon.pid)
      }
      deleteDaemonSidecars(daemon.dir, daemon.key)
    }
  } else if (healthy.length >= 1) {
    const keep = newestFirst(healthy)[0]!
    for (const daemon of healthy) {
      if (daemon === keep) continue
      if (daemon.pid !== null) {
        killProcessTree(daemon.pid)
        culled.push(daemon.pid)
      }
      deleteDaemonSidecars(daemon.dir, daemon.key)
    }
  }
  let warmed = false
  const survivors = healthy.length - culled.length
  if (survivors <= 0) {
    const stillHealthy = (await refreshLiveness(daemons, culled)).filter((d) => d.alive && d.portOpen)
    if (stillHealthy.length === 0) {
      warmed = await warmUpAgentBrowserDaemon().catch(() => false)
    }
  } else {
    // pid+포트는 살아있는데 브라우저가 한 번도 안 뜬 좀비 데몬(구버전 잔해,
    // 콜드킬 반쪽 Chrome 등)은 기존 검사에 "정상"으로 보인다. 죽이지는 않고
    // 웜업만 걸어본다 — 전역 뮤텍스라 이미 도는 웜업에 그냥 붙는다.
    try {
      if (!getAgentBrowserDaemonStatus().warm) {
        warmed = await warmUpAgentBrowserDaemon().catch(() => false)
      }
    } catch {
      // 상태 조회 실패는 다음 틱으로
    }
  }
  if (cleanedStale.length > 0 || culled.length > 0 || warmed) {
    logger.info(
      `Agent-browser supervised (daemons: ${daemons.length}, stale cleaned: [${cleanedStale.join(', ')}], ` +
        `culled pids: [${culled.join(', ')}], warmed: ${warmed})`,
    )
  }
  return { daemons, cleanedStale, culled, warmed }
}

function newestFirst(daemons: AgentBrowserDaemonInfo[]): AgentBrowserDaemonInfo[] {
  return [...daemons].sort((a, b) => sidecarMtimeMs(b.dir, b.key) - sidecarMtimeMs(a.dir, a.key))
}

async function refreshLiveness(
  daemons: AgentBrowserDaemonInfo[],
  culled: number[],
): Promise<AgentBrowserDaemonInfo[]> {
  const culledSet = new Set(culled)
  for (const daemon of daemons) {
    if (daemon.pid !== null && culledSet.has(daemon.pid)) {
      daemon.alive = false
      daemon.portOpen = false
      continue
    }
    daemon.alive = daemon.pid !== null && pidAlive(daemon.pid)
    daemon.portOpen = daemon.alive && daemon.port !== null ? await tcpProbe(daemon.port) : false
  }
  return daemons
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

// 활성화되는 전역 opencode.json을 디스크에 쓸 때 기본 MCP가 빠지지 않게
// 병합해서 쓴다 (DB 내용은 손대지 않는다). 어떤 이름의 커스텀 config를
// 선택해도 opencode 세션에는 agent-browser/doc-reader가 노출된다.
// 사용자가 명시적으로 enabled:false로 끈 항목은 다시 켜지 않는다.
export function writeActiveOpenCodeConfigFile(configContent: string): void {
  const configPath = getOpenCodeConfigFilePath()
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(configContent) as Record<string, unknown>
  } catch {
    parsed = null
  }
  if (!parsed || typeof parsed !== 'object') {
    mkdirSync(path.dirname(configPath), { recursive: true })
    writeFileSync(configPath, configContent, 'utf8')
    return
  }
  const prevDisabled = new Set<string>()
  try {
    const mcp = (parsed.mcp ?? {}) as Record<string, { enabled?: boolean }>
    for (const [id, e] of Object.entries(mcp)) {
      if (e && typeof e === 'object' && e.enabled === false) prevDisabled.add(id)
    }
  } catch {}
  const merged = mergeDefaultMcpEntries(parsed)
  try {
    const mcp = ((merged as Record<string, unknown>).mcp ?? {}) as Record<string, { enabled?: boolean }>
    for (const id of prevDisabled) {
      if (mcp[id]) mcp[id].enabled = false
    }
  } catch {}
  mkdirSync(path.dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf8')
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