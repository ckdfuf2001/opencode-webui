import { logger } from '../utils/logger'
import { getConfigPath, getOpenCodeConfigFilePath } from '@opencode-webui/shared'
import { ensureServerAuth } from './opencode-auth'
import { opencodeServerManager } from './opencode-single-server'
import { truncateSessionMessages } from './opencode-db'
import { markRequestBusy, clearRequestBusy } from './busy-tracker'
import { open, readFile, stat, appendFile } from 'fs/promises'
import os from 'os'
import path from 'path'

const OPENCODE_LOG_PATH = path.join(os.homedir(), '.local', 'share', 'opencode', 'log', 'opencode.log')

/**
 * opencode 는 5xx 에 빈 본문을 돌려주는 경우가 많아 클라이언트가 사유를 알 수 없다.
 * opencode 로그 꼬리에서 가장 최근 level=ERROR 라인의 error="..." 를 꺼내 돌려준다.
 */
async function readLatestOpenCodeError(): Promise<string | null> {
  try {
    const handle = await open(OPENCODE_LOG_PATH, 'r')
    try {
      const size = (await handle.stat()).size
      const start = Math.max(0, size - 65536)
      const length = size - start
      const buf = Buffer.alloc(length)
      await handle.read(buf, 0, length, start)
      const lines = buf.toString('utf8').split('\n').filter((l) => l.includes('level=ERROR'))
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i] ?? ''
        const m = line.match(/\serror="([^"]{5,500})"/) ?? line.match(/\scause="([^"]{5,500})"/)
        const reason = m?.[1]?.split('\\n')[0]?.trim()
        if (reason) return reason
      }
      return null
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

export async function patchOpenCodeConfig(config: Record<string, unknown>): Promise<boolean> {
  try {
    const response = await fetch(`${opencodeServerManager.getUrl()}/config`, {
      method: 'PATCH',
      headers: ensureServerAuth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(config),
    })
    
    if (response.ok) {
      logger.info('Patched OpenCode config via API')
      return true
    }
    
    logger.error(`Failed to patch OpenCode config: ${response.status} ${response.statusText}`)
    return false
  } catch (error) {
    logger.error('Failed to patch OpenCode config:', error)
    return false
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

export type CommandScope = 'builtin' | 'global' | 'project'

/**
 * Skills are stored as `<scope>/.opencode/skills/<name>/SKILL.md`, commands as
 * `<scope>/.opencode/commands/<name>.md` (plural is canonical, singular legacy).
 * `rootBase` is `{dir}` for project scope (entries live under
 * `{dir}/.opencode/...`) and `getConfigPath()` for global scope (`{config}` is
 * already the config root — entries live under `{config}/command[s]/...`).
 */
async function scopeHasEntry(
  rootBase: string,
  name: string,
  source: string | undefined,
  isProject: boolean,
): Promise<boolean> {
  const kindDirs = source === 'skill' ? ['skills', 'skill'] : ['commands', 'command']
  for (const kindDir of kindDirs) {
    const root = isProject ? path.join(rootBase, '.opencode', kindDir) : path.join(rootBase, kindDir)
    if (source === 'skill') {
      if (await fileExists(path.join(root, name, 'SKILL.md'))) return true
    } else {
      if (await fileExists(path.join(root, `${name}.md`))) return true
    }
  }
  return false
}

/**
 * Config-defined commands (declared inline in opencode.json `command`) have no
 * `.md` file, so the file scan alone cannot classify them. They are user-owned
 * (global), registered via the app's config editor.
 */
async function isConfigDefined(name: string, source: string | undefined): Promise<boolean> {
  try {
    if (source === 'skill') return false
    const raw = await readFile(getOpenCodeConfigFilePath(), 'utf-8')
    const cfg = JSON.parse(raw) as {
      command?: Record<string, unknown>
      agent?: Record<string, unknown>
    }
    return Boolean(cfg.command?.[name] || cfg.agent?.[name])
  } catch {
    return false
  }
}

export async function resolveCommandScope(
  name: string,
  source: string | undefined,
  directory?: string,
): Promise<CommandScope> {
  // Trust opencode's own scoping when the /command payload reports one.
  if (source === 'project' || source === 'global' || source === 'builtin') {
    return source
  }

  if (directory && (await scopeHasEntry(directory, name, source, true))) return 'project'

  if (await scopeHasEntry(getConfigPath(), name, source, false)) return 'global'

  if (await isConfigDefined(name, source)) return 'global'

  // No file and not defined in config: what's left is a built-in shipped by
  // opencode itself (e.g. customize-opencode).
  return 'builtin'
}

function parseDirectory(url: URL): string | undefined {
  const value = url.searchParams.get('directory')
  return value ? decodeURIComponent(value) : undefined
}

async function handleTruncate(request: Request, sessionId: string): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as { messageID?: string } | null
    const messageID = body?.messageID
    if (!messageID) {
      return new Response(JSON.stringify({ error: 'messageID is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const result = await truncateSessionMessages(sessionId, messageID)
    if (!result) {
      return new Response(JSON.stringify({ error: 'Failed to truncate session' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ success: true, ...result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    logger.error('Failed to truncate session:', error)
    return new Response(JSON.stringify({ error: 'Failed to truncate session' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

export async function proxyRequest(request: Request, method: string, pathname: string, query: Record<string, string>) {
  const truncateMatch = pathname.match(/^\/api\/opencode\/session\/([^/]+)\/truncate$/)
  const truncateSessionId = truncateMatch?.[1]
  if (method === 'POST' && truncateSessionId) {
    return handleTruncate(request, truncateSessionId)
  }

  const search = query ? '?' + new URLSearchParams(query).toString() : ''
  const cleanPath = pathname.replace(/^\/api\/opencode/, '') + search
  const targetUrl = `${opencodeServerManager.getUrl()}${cleanPath}`

  const cleanEventPath = pathname.replace(/^\/api\/opencode/, '')
  const isLongRunning = /\/session\/[^/]+\/message$/.test(cleanEventPath)
    || /\/session\/[^/]+\/command$/.test(cleanEventPath)
    || /\/question\/[^/]+\/reply$/.test(cleanEventPath)
    || /\/permission\/[^/]+\/reply$/.test(cleanEventPath)
  const releaseBusy = (() => {
    const released = () => {
      if (isLongRunning) clearRequestBusy()
    }
    let done = false
    return () => {
      if (done) return
      done = true
      released()
    }
  })()

  try {
    const headers = ensureServerAuth({})
    request.headers.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (['host', 'connection', 'authorization', 'accept-encoding'].includes(lower)) {
        return
      }
      headers[key] = value
    })

    const isEventStream = cleanEventPath === '/event' || cleanEventPath === '/global/event' || cleanEventPath.startsWith('/event?')
    const signal = isEventStream
      ? undefined
      : AbortSignal.timeout(isLongRunning ? 600_000 : 120_000)

    const body = method !== 'GET' && method !== 'HEAD' ? await request.text() : undefined

    const retryable = (error: unknown): boolean => {
      const code = (error as { cause?: { code?: unknown } })?.cause?.code
        ?? (error as { code?: unknown })?.code
      if (typeof code !== 'string' || !code) return false
      const normalized = code.toUpperCase()
      return normalized === 'ECONNREFUSED'
        || normalized === 'ECONNRESET'
        || normalized === 'ENOTFOUND'
        || normalized === 'EAI_AGAIN'
        || normalized === 'CONNECTIONREFUSED'
        || normalized === 'CONNECTIONRESET'
        || normalized === 'CONNECTIONCLOSED'
        || normalized === 'UND_ERR_CONNECT_TIMEOUT'
    }

    let response: Response | null = null
    let lastError: unknown = null

    // Busy is released only when the response body finishes streaming, so the
    // automation watcher never runs an instance reload (dispose) while an
    // in-flight message/command is still being produced.
    if (isLongRunning) {
      markRequestBusy()
    }
    const connectDeadline = Date.now() + 15_000
    for (let attempt = 1; attempt <= 30; attempt++) {
      try {
        response = await fetch(targetUrl, {
          method,
          headers,
          body,
          signal,
        })
        break
      } catch (error) {
        lastError = error
        if (!retryable(error)) throw error
        if (Date.now() >= connectDeadline) throw error
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    if (!response) throw lastError

    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (['connection', 'transfer-encoding', 'content-encoding', 'content-length'].includes(lower)) {
        return
      }
      responseHeaders[key] = value
    })

    if (method === 'GET' && cleanEventPath === '/command') {
      try {
        const bodyText = await response.text()
        const commands = JSON.parse(bodyText)
        if (Array.isArray(commands)) {
          const directory = new URLSearchParams(query).get('directory')?.replace(/%2F/g, '/')
          const enriched = await Promise.all(
            commands.map(async (cmd: Record<string, unknown>) => ({
              ...cmd,
              scope: await resolveCommandScope(
                String(cmd.name ?? ''),
                cmd.source as string | undefined,
                directory,
              ),
            })),
          )
          responseHeaders['Content-Type'] = 'application/json'
          return new Response(JSON.stringify(enriched), {
            status: response.status,
            headers: responseHeaders,
          })
        }
        return new Response(bodyText, { status: response.status, headers: responseHeaders })
      } catch (error) {
        logger.warn('Failed to augment command list with scope:', error)
      }
    }

    if (response.status >= 400) {
      releaseBusy()
      const bodyText = await response.text().catch(() => '')
      const lower = bodyText.toLowerCase()
      const isBillingQuota =
        lower.includes('freeusagelimit') ||
        lower.includes('insufficient_quota') ||
        lower.includes('insufficient balance') ||
        lower.includes('payment required') ||
        lower.includes('quota exceeded') ||
        lower.includes('billing') ||
        lower.includes('add credits') ||
        lower.includes('subscriptionusagelimit') ||
        lower.includes('exceeded your current quota')

      // opencode 가 5xx에 빈 본문을 돌려줄 때 로그로 보강한다.
      const generic = !bodyText.trim() || bodyText.includes('Check server logs for details')
      if (generic) {
        const reason = await readLatestOpenCodeError()
        if (reason) {
          let original: Record<string, unknown> | undefined
          try { original = JSON.parse(bodyText) as Record<string, unknown> } catch { original = undefined }
          responseHeaders['Content-Type'] = 'application/json'
          const payload = original
            ? { ...original, error: reason, opencodeLog: OPENCODE_LOG_PATH }
            : { error: reason, opencodeLog: OPENCODE_LOG_PATH }
          return new Response(JSON.stringify(payload), {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
          })
        }
      }

      // 40x: provider 원문을 보존하되, 빌링/쿼터 키워드가 있으면 한글 힌트와 빌링 URL을 덧붙인다.
      // 프론트 formatServerError 가 402/429 등을 토스트로 띄운다.
      if (response.status >= 400 && response.status < 500 && isBillingQuota) {
        let parsed: Record<string, unknown> | undefined
        try { parsed = JSON.parse(bodyText) as Record<string, unknown> } catch { parsed = undefined }
        const hint = ' — 무료 한도/잔액 소진. 결제가 필요합니다. (https://opencode.ai/zen)'
        if (parsed) {
          const msg = typeof parsed.message === 'string' ? parsed.message : typeof parsed.error === 'string' ? parsed.error : bodyText
          const enriched = { ...parsed, error: msg + hint, message: msg + hint, billingUrl: 'https://opencode.ai/zen' }
          responseHeaders['Content-Type'] = 'application/json'
          return new Response(JSON.stringify(enriched), {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
          })
        }
        responseHeaders['Content-Type'] = 'application/json'
        return new Response(JSON.stringify({ error: bodyText + hint, billingUrl: 'https://opencode.ai/zen' }), {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        })
      }

      return new Response(bodyText, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      })
    }

    if (!isLongRunning || !response.body) {
      releaseBusy()
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      })
    }

    const trackedStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = response.body!.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            controller.enqueue(value)
          }
          controller.close()
        } catch (error) {
          controller.error(error)
        } finally {
          releaseBusy()
          reader.releaseLock()
        }
      },
      cancel() {
        releaseBusy()
      },
    })

    return new Response(trackedStream, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  } catch (error) {
    releaseBusy()
    const err = error as { name?: string; message?: string; cause?: unknown }
    const rawMsg = err?.message || String(error)
    const causeCode = (err?.cause as { code?: string } | undefined)?.code || (error as { code?: string } | undefined)?.code
    if (err?.name === 'TimeoutError') {
      logger.debug('Proxy request timed out:', err)
      return new Response(JSON.stringify({ error: `OpenCode 서버 응답 시간 초과 (600s). 세션이 길거나 서버가 바쁩니다. — ${rawMsg}`, code: 'TIMEOUT' }), {
        status: 504,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    logger.error(`Proxy request failed:`, error)
    const isConnRefused = causeCode && /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|CONNECTIONREFUSED/i.test(String(causeCode))
    const hint = isConnRefused
      ? ' — OpenCode 서버(:5552)에 연결할 수 없습니다. 백엔드가 서버를 띄우는 중이거나 포트가 막혀 있습니다. `backend` 로그와 `opencode --version`을 확인하세요.'
      : ' — 백엔드→OpenCode 프록시 실패. 네트워크/방화벽을 확인하세요.'
    return new Response(JSON.stringify({ error: `Bad Gateway (502): ${rawMsg}${hint}`, code: causeCode || 'PROXY_502', opencodeUrl: opencodeServerManager.getUrl() }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
