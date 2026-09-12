import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync, mkdirSync } from 'node:fs'
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
// 회사 PC의 HTTP_PROXY/HTTPS_PROXY가 loopback(CDP·데몬 포트)까지 물면
// 타임아웃 지옥이 된다. stateless MCP(sap 등)는 안 타지만 브라우저 스택은
// 매 호출이 loopback 타이밍이라 직격. bypass를 강제한다.
const LOOPBACK_BYPASS = ['127.0.0.1', 'localhost']

function withLoopbackBypass(value: string | undefined): string {
  const parts = (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const host of LOOPBACK_BYPASS) {
    if (!parts.some((p) => p.toLowerCase() === host || p === '*')) parts.push(host)
  }
  return parts.join(',')
}

export function ensureLoopbackBypass(): void {
  try {
    process.env.NO_PROXY = withLoopbackBypass(process.env.NO_PROXY)
  } catch {}
  try {
    process.env.no_proxy = withLoopbackBypass(process.env.no_proxy)
  } catch {}
}

export function agentBrowserEnv(): Record<string, string> {
  // Playwright MCP용: loopback bypass만 유지 (agent-browser 전용 env 제거)
  const env: Record<string, string> = {}
  env.NO_PROXY = withLoopbackBypass(process.env.NO_PROXY)
  env.no_proxy = withLoopbackBypass(process.env.no_proxy)
  return env
}

// 설치별 agent-browser 소켓 디렉터리. 기본 ~/.agent-browser 공유는 다른
// 설치본의 데몬과 사이드카를 두고 싸우는(10061/좀비) 구조라 격리한다.
// 명시 env가 있으면 존중, 없으면 설치 루트/.agent-browser-home.
export function getScopedSocketDir(): string | null {
  if (process.env.AGENT_BROWSER_SOCKET_DIR) return process.env.AGENT_BROWSER_SOCKET_DIR
  const root = resolveInstallRoot()
  return root ? path.join(root, '.agent-browser-home') : null
}

export function ensureScopedSocketDir(): string | null {
  const dir = getScopedSocketDir()
  if (!dir) return null
  try {
    mkdirSync(dir, { recursive: true })
  } catch {}
  if (process.env.AGENT_BROWSER_SOCKET_DIR !== dir) {
    process.env.AGENT_BROWSER_SOCKET_DIR = dir
  }
  return dir
}

function resolveInstallRoot(): string | null {
  const candidates: string[] = []
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    candidates.push(path.resolve(here, '..', '..', '..'))
  } catch {}
  try {
    candidates.push(process.cwd())
  } catch {}
  for (const c of candidates) {
    try {
      if (existsSync(path.join(c, 'bin', 'agent-browser', '.meta.json'))) return c
    } catch {}
  }
  for (const c of candidates) {
    try {
      if (existsSync(path.join(c, 'package.json'))) return c
    } catch {}
  }
  return null
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
  _namespace: string = AGENT_BROWSER_NAMESPACE,
): Record<string, unknown> {
  // 0.7.8+: agent-browser → Playwright MCP로 전면 교체. 가볍고 데몬 없는 browser_* 도구 제공.
  // webfetch로는 불가한 버튼 클릭/스냅샷 시퀀스 지원, --isolated 로 세션 격리 (concurrent 안전).
  // npx --yes 로 최초 1회 자동 설치, 이후 캐시 재사용.
  const env: Record<string, string> = {}
  // 회사 프록시가 loopback을 물지 않게 bypass 유지 (Playwright도 CDP가 127.0.0.1 사용)
  env.NO_PROXY = withLoopbackBypass(process.env.NO_PROXY)
  env.no_proxy = withLoopbackBypass(process.env.no_proxy)
  return {
    playwright: {
      type: 'local',
      enabled: true,
      command: ['npx', '--yes', '@playwright/mcp@latest', '--headless', '--isolated'],
      env,
    },
  }
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
// 데몬 없음 상태에서 웜업 재시도 백오프: 망가진 환경에서 매 틱마다
// Chrome 기동을 반복(프로세스 들락날락)하지 않게 5분 간격.
let lastWarmAttemptAt = 0
let lastWarmOk = true
const WARM_RETRY_COOLDOWN_MS = 5 * 60_000

export function warmUpAgentBrowserDaemon(
  _namespace: string = AGENT_BROWSER_NAMESPACE,
  _session?: string,
): Promise<boolean> {
  // Playwright MCP는 데몬 웜업 불필요 — 항상 warm으로 간주
  return Promise.resolve(true)
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
  let command: string[]
  env.AGENT_BROWSER_NAMESPACE = namespace
  env.AGENT_BROWSER_SESSION = sessionName
  env.AGENT_BROWSER_IDLE_TIMEOUT_MS = AGENT_BROWSER_IDLE_TIMEOUT_MS
  command = [info.binPath, 'mcp', '--namespace', namespace]
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
      const ok = await openViaMcp(child, remaining, namespace, sessionName)
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
    // native MCP: 세션을 인자로 직접 넘긴다 (session_ensure 없음).
    // warmup 자식의 레지스트리는 버려지고, 데몬/브라우저 기동만 남는다.
    const warmSession = `warmup-${session}`.slice(0, 64)
    const res = (await send('tools/call', {
      name: 'agent_browser_open',
      arguments: { namespace, session: warmSession, url: 'about:blank' },
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

export interface AgentBrowserCheck {
  name: string
  ok: boolean
  detail: string
}

// 원격 진단용: open 실패 시 추측이 아니라 단계별 기동 경로를 직접 실행해
// 어디서 막히는지 찍는다. 읽기 전용 + temp 스모크 프로필만 쓴다.
export async function diagnoseAgentBrowser(): Promise<{ checks: AgentBrowserCheck[]; verdict: string }> {
  const checks: AgentBrowserCheck[] = []
  const push = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail })
  }
  const errText = (e: unknown): string =>
    String((e as { message?: unknown })?.message ?? e).slice(0, 600)

  // 1. 바이너리/메타 (EACCES면 여기서 바로 걸린다)
  const info = resolveAgentBrowser()
  if (!info) {
    push('binary', false, 'meta 또는 실행파일 없음. npm run agent-browser:install 필요')
  } else {
    const binOk = existsSync(info.binPath)
    const exeOk = !!info.executablePath && existsSync(info.executablePath)
    let ver = ''
    try {
      ver = execFileSync(info.binPath, ['--version'], { encoding: 'utf8', timeout: 15000 }).trim()
    } catch (e) {
      ver = ''
      push('binary-run', false, `실행 불가: ${errText(e)} (ACL/백신 차단 가능)`)
    }
    if (ver) push('binary-run', true, `${info.binPath} -> ${ver}`)
    push('binary-files', binOk && exeOk, `bin=${binOk} chromium=${exeOk} (${info.executablePath || 'none'})`)
  }

  // 2. 소켓 디렉터리 쓰기 가능 여부 (사이드카/프로필 기록 경로)
  try {
    const dir = agentBrowserRunDir()
    mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.writetest-${process.pid}`)
    writeFileSync(probe, 'ok', 'utf8')
    rmSync(probe, { force: true })
    push('socketdir-writable', true, dir)
  } catch (e) {
    push('socketdir-writable', false, `쓰기 불가: ${errText(e)} (권한 불일치: 관리자/일반 혼용 확인)`)
  }

  // 3. 크로뮴 headless 스모크 (데몬과 무관하게 브라우저 자체 기동 확인)
  // 3b. --no-sandbox 재시도: 기본 실패 + 이거 성공이면 샌드박스/정책 문제 확정
  if (info?.executablePath && existsSync(info.executablePath)) {
    const profile = path.join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', `ab-smoke-${process.pid}`)
    const baseArgs = ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu']
    try {
      const out = execFileSync(
        info.executablePath,
        [...baseArgs, `--user-data-dir=${profile}`, '--dump-dom', 'about:blank'],
        { encoding: 'utf8', timeout: 25000 },
      )
      push('chrome-smoke', out.includes('<html'), `dump ${out.trim().length} chars`)
    } catch (e) {
      const msg = errText(e)
      let nosandbox = 'skipped'
      try {
        const out2 = execFileSync(
          info.executablePath,
          [...baseArgs, '--no-sandbox', `--user-data-dir=${profile}-ns`, '--dump-dom', 'about:blank'],
          { encoding: 'utf8', timeout: 25000 },
        )
        nosandbox = out2.includes('<html') ? 'OK' : `empty (${out2.trim().length} chars)`
      } catch (e2) {
        nosandbox = `실패: ${errText(e2)}`
      } finally {
        try { rmSync(`${profile}-ns`, { recursive: true, force: true }) } catch {}
      }
      const sandbox = /root|administrator|no-sandbox|sandbox/i.test(msg)
      push('chrome-smoke', false,
        `기동 실패: ${msg} / --no-sandbox 재시도: ${nosandbox}` +
        (sandbox ? ' (샌드박스/권한 문제 가능성: 관리자 실행 여부·백신 확인)' : ''))
    } finally {
      try { rmSync(profile, { recursive: true, force: true }) } catch {}
    }
  } else {
    push('chrome-smoke', false, 'chromium 실행파일 없음 (LFS 포인터 가능: git lfs pull 확인)')
  }

  // 4. 데몬 사이드카/프로세스/포트 (네임스페이스 고정 데몬만)
  try {
    const found = listAgentBrowserDaemons().filter((d) => d.namespaced)
    if (found.length === 0) {
      push('daemon', true, '실행 중인 데몬 없음 (다음 open 때 lazy 기동)')
    } else {
      for (const d of found) {
        const open = d.alive && d.port !== null ? await tcpProbe(d.port) : false
        d.portOpen = open
        push('daemon', d.alive && open, `pid=${d.pid} alive=${d.alive} port=${d.port} open=${open}`)
      }
    }
  } catch (e) {
    push('daemon', false, `조회 실패: ${errText(e)}`)
  }

  // 5. CLI 세션 인포 (데몬 버전/활성)
  try {
    if (!info) throw new Error('no binary')
    const out = execFileSync(info.binPath, ['session', 'info', '--json'], {
      env: { ...process.env, AGENT_BROWSER_NAMESPACE: AGENT_BROWSER_NAMESPACE },
      encoding: 'utf8',
      timeout: 15000,
    })
    const j = JSON.parse(out) as { data?: { active?: boolean; version?: string }; success?: boolean }
    push('daemon-info', true, `version=${j.data?.version ?? '?'} active=${j.data?.active ?? '?'}`)
  } catch (e) {
    push('daemon-info', false, `조회 실패: ${errText(e)}`)
  }

  // 6. 웜 상태 (데몬 주도 기동이 실제로 되는지 — 직접 스모크와 플래그가
  //   다를 수 있어 데몬 기준을 우선한다)
  let warm = false
  try {
    warm = getAgentBrowserDaemonStatus().warm
  } catch {}
  push('daemon-warm', warm, warm ? 'browser launched' : 'no launched browser')

  const byName = (n: string): AgentBrowserCheck | undefined => checks.find((c) => c.name === n)
  const hardBlock = ['binary-run', 'binary-files', 'socketdir-writable']
    .map(byName)
    .find((c) => c && !c.ok)
  const smoke = byName('chrome-smoke')
  let verdict: string
  if (hardBlock) {
    verdict = `BLOCKED at ${hardBlock.name}: ${hardBlock.detail}`
  } else if (warm) {
    verdict = smoke && !smoke.ok
      ? `OK (daemon-driven launch works; direct smoke failed — likely flag/env difference): ${smoke.detail.slice(0, 300)}`
      : 'launch path OK — 데몬·브라우저 기동 가능'
  } else if (smoke && !smoke.ok) {
    verdict = `BLOCKED: browser won't launch. ${smoke.detail.slice(0, 500)}`
  } else {
    verdict = 'cold but launchable — open 1회로 기동됨 (lazy). 실패 시 supervise 후 재시도'
  }
  return { checks, verdict }
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
 * 매 틱(60s) 호출된다. 원칙: 살아있는 데몬은 절대 죽이지 않는다.
 * kill 전쟁(죽였다 살리기)이 flicker와 10061의 주범이었으므로, 관리는
 * 죽은 pid의 사이드카 청소 + 다음 호출의 lazy respawn에만 맡긴다.
 * 1. 죽은 pid의 사이드카를 지운다 (좀비 포트 방지).
 * 2. pid는 살아있는데 포트가 닫힌 귀먹은 좀비는 사이드카만 지운다.
 *    프로세스는 건드리지 않는다 — 다음 호출이 깨끗하게 respawn하고,
 *    옛 프로세스는 idle 종료에 맡긴다.
 * 3. 살아있는 데몬이 하나도 없으면 warm-up 1회 (실패하면 5분 백오프).
 *    망가진 환경에서 매 틱 Chrome 기동을 반복하지 않는다.
 */
export async function superviseAgentBrowserDaemon(): Promise<SupervisionResult> {
  // Playwright MCP는 데몬 supervision 불필요 — no-op (agent-browser 전용 로직 bypass)
  return { daemons: [], cleanedStale: [], culled: [], warmed: false }
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
  // 판단 최소화: 없는 항목은 채우고, 우리 모양이면 루트만 고치고,
  // 사용자 커스텀은 손대지 않는다.
  const mcp = { ...((content.mcp as Record<string, unknown>) ?? {}) }
  const defaults = defaultMcpEntries()
  for (const [id, entry] of Object.entries(defaults)) {
    const existing = mcp[id] as Record<string, unknown> | undefined
    if (!existing) {
      mcp[id] = entry
      continue
    }
    if (id === 'agent-browser') {
      const fixed = normalizeAgentBrowserEntry(
        existing,
        entry as Record<string, unknown>,
      )
      if (fixed) {
        mcp[id] = fixed
        logger.info(`Repaired default MCP server entry: ${id}`)
      }
      continue
    }
    const defaultCommand = (entry as Record<string, unknown>).command
    const existingCommand = Array.isArray(existing.command) ? existing.command : []
    if (JSON.stringify(existingCommand) !== JSON.stringify(defaultCommand)) {
      const joined = existingCommand.map(String).join(' ')
      if (/doc_reader_mcp\.py/.test(joined)) {
        mcp[id] = { ...existing, command: defaultCommand }
        logger.info(`Repaired default MCP server entry: ${id}`)
      }
    }
  }
  return { ...content, mcp } as T
}

// agent-browser 항목 정규화. 우리 모양(프록시 잔재, 구 direct, 절대경로 어긋남)
// 일 때만 현재 바이너리 기준으로 고치고, enabled:false와 사용자 추가 키는 유지.
// 사용자 커스텀이면 null (손대지 않음).
function normalizeAgentBrowserEntry(
  existing: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> | null {
  const cmd = Array.isArray(existing.command) ? existing.command.map(String) : []
  const joined = cmd.join(' ')
  const isOurs =
    /mcp-server\.mjs|agent-browser-proxy/.test(joined) ||
    (/agent-browser(\.exe)?$/i.test(cmd[0] ?? '') && cmd.includes('mcp'))
  if (!isOurs) return null
  const next: Record<string, unknown> = { ...existing }
  let changed = false
  const defaultCommand = (defaults.command ?? []) as unknown[]
  if (JSON.stringify(cmd) !== JSON.stringify(defaultCommand)) {
    next.command = defaultCommand
    changed = true
  }
  const defaultEnv = (defaults.env ?? {}) as Record<string, string>
  const env = { ...((existing.env as Record<string, string>) ?? {}) } as Record<string, string>
  for (const [key, value] of Object.entries(defaultEnv)) {
    if (!(key in env)) {
      env[key] = value
      changed = true
    }
  }
  // 우리 항목인데 기록된 크롬 경로가 디스크에 없으면 현재 것으로 교체
  // (머신 옮기면 절대경로가 깨지므로). 존재하면 손대지 않는다.
  try {
    const info = resolveAgentBrowser()
    const recorded = env.AGENT_BROWSER_EXECUTABLE_PATH
    if (info?.executablePath && typeof recorded === 'string' && !existsSync(recorded)) {
      env.AGENT_BROWSER_EXECUTABLE_PATH = info.executablePath
      changed = true
    }
  } catch {}
  // 우리 구 키만 제거 (SESSION 고정·TTL·STORE 등). 사용자 키는 유지.
  for (const stale of ['AGENT_BROWSER_SESSION', 'AGENT_BROWSER_AUTO_SESSION', 'SESSION_TTL_MS', 'SESSION_MAX', 'SESSION_SWEEP_MS', 'SESSION_STORE']) {
    if (stale in env) {
      delete env[stale]
      changed = true
    }
  }
  if (!changed) return null
  next.env = env
  return next
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

// opencode는 `model`을 시작 때만 읽는다. default 변경이 다음 세션부터
// 적용되게 실행 중 서버 PATCH와 별개로 파일에도 기록한다.
export function setActiveOpenCodeConfigModel(model: string): void {
  try {
    const configPath = getOpenCodeConfigFilePath()
    let current: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>
      }
    } catch {
      current = {}
    }
    writeActiveOpenCodeConfigFile(JSON.stringify({ ...current, model }))
    logger.info(`Wrote default model '${model}' to ${configPath}`)
  } catch (error) {
    logger.warn('Failed to write default model to opencode config file:', error)
  }
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