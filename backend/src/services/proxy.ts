import { logger } from '../utils/logger'
import { getConfigPath, getOpenCodeConfigFilePath } from '@opencode-webui/shared'
import { ensureServerAuth } from './opencode-auth'
import { opencodeServerManager } from './opencode-single-server'
import { truncateSessionMessages } from './opencode-db'
import { markRequestBusy, clearRequestBusy, isOpenCodeServerBusy } from './busy-tracker'
import { readFile, stat } from 'fs/promises'
import path from 'path'

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

/**
 * GET 응답의 마지막 성공 본문 캐시(stale-while-revalidate).
 * opencode 서버가 벤더 API(model/provider 목록 등) 지연으로 늦어질 때
 * 마지막 성공 데이터를 즉시 돌려주고, 실제 갱신은 비동기로 따라온다.
 */
const STALE_CACHE_LIMIT = 200
const staleCache = new Map<string, { status: number; contentType: string; body: string }>()

function cacheKeyFor(method: string, targetUrl: string): string | null {
  if (method !== 'GET') return null
  try {
    const u = new URL(targetUrl)
    return u.pathname + u.search
  } catch {
    return null
  }
}

function rememberStale(key: string | null, status: number, contentType: string, body: string): void {
  if (!key || status >= 500 || !body) return
  if (staleCache.size >= STALE_CACHE_LIMIT) {
    const oldest = staleCache.keys().next().value
    if (oldest) staleCache.delete(oldest)
  }
  staleCache.set(key, { status, contentType, body })
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
  const requestStartedAt = Date.now()

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
    // 생성 중(opencode 바쁨)엔 GET을 opencode에 물지 않고 캐시로 즉시 응답한다.
    const staleKeyPre = method === 'GET' && !isEventStream ? cacheKeyFor(method, targetUrl) : null
    if (staleKeyPre) {
      const pre = staleCache.get(staleKeyPre)
      if (pre && isOpenCodeServerBusy()) {
        return new Response(pre.body, {
          status: pre.status,
          headers: { 'Content-Type': pre.contentType, 'x-stale': '1', 'x-busy': '1' },
        })
      }
    }
    // GET(설정/목록류)은 외부 벤더 API 지연에 발이 묶이지 않도록 짧게 끊고,
    // 타임아웃 시 마지막 성공 캐시로 즉시 응답한다(프론트 타임아웃보다 짧아야 함).
    const signal = isEventStream
      ? undefined
      : AbortSignal.timeout(isLongRunning ? 600_000 : method === 'GET' ? 8_000 : 120_000)

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
        rememberStale(cacheKeyFor(method, targetUrl), response.status, 'application/json', bodyText)
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

    if (!isLongRunning || !response.body) {
      // GET 응답을 캐시에 저장해 벤더 API 장애 시에도 마지막 성공 데이터를 제공한다.
      if (method === 'GET' && !isEventStream) {
        const bodyText = await response.text()
        rememberStale(cacheKeyFor(method, targetUrl), response.status, responseHeaders['Content-Type'] ?? 'application/json', bodyText)
        releaseBusy()
        const tookMs = Date.now() - requestStartedAt
        if (tookMs > 2_000) {
          logger.warn(`Slow proxied GET ${cleanEventPath} -> ${tookMs}ms (status ${response.status})`)
        }
        return new Response(bodyText, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        })
      }
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
    const err = error as { name?: string }
    if (err?.name === 'TimeoutError') {
      logger.debug('Proxy request timed out:', err)
    } else {
      logger.error(`Proxy request failed:`, error)
    }
    // 업스트림(opencode→벤더 API) 지연/장애 시 마지막 성공 응답을 즉시 제공한다.
    const staleKey = cacheKeyFor(method, targetUrl)
    const stale = staleKey ? staleCache.get(staleKey) : undefined
    if (stale) {
      logger.warn(`Serving stale cached response for ${method} ${staleKey}`)
      return new Response(stale.body, {
        status: stale.status,
        headers: { 'Content-Type': stale.contentType, 'x-stale': '1' },
      })
    }
    return new Response(JSON.stringify({ error: 'Proxy request failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
