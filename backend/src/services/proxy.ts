import { logger } from '../utils/logger'
import { getConfigPath, getOpenCodeConfigFilePath } from '@opencode-webui/shared'
import { ensureServerAuth } from './opencode-auth'
import { opencodeServerManager } from './opencode-single-server'
import { truncateSessionMessages, deleteSessionMessage } from './opencode-db'
import { acquireBusy, type BusyToken } from './busy-tracker'
import { open, readFile, stat, appendFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import type { Database } from 'bun:sqlite'

let proxyDb: Database | null = null
export function setProxyDb(db: Database): void {
  proxyDb = db
}

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

async function handleDelete(request: Request, sessionId: string): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as { messageID?: string } | null
    const messageID = body?.messageID
    if (!messageID) {
      return new Response(JSON.stringify({ error: 'messageID is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const result = await deleteSessionMessage(sessionId, messageID)
    if (!result) {
      return new Response(JSON.stringify({ error: 'Failed to delete message' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ success: true, ...result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    logger.error('Failed to delete message:', error)
    return new Response(JSON.stringify({ error: 'Failed to delete message' }), {
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

  const deleteMatch = pathname.match(/^\/api\/opencode\/session\/([^/]+)\/delete$/)
  const deleteSessionId = deleteMatch?.[1]
  if (method === 'POST' && deleteSessionId) {
    return handleDelete(request, deleteSessionId)
  }

  const search = query ? '?' + new URLSearchParams(query).toString() : ''
  const cleanPath = pathname.replace(/^\/api\/opencode/, '') + search
  const targetUrl = `${opencodeServerManager.getUrl()}${cleanPath}`

  const cleanEventPath = pathname.replace(/^\/api\/opencode/, '')
  const isLongRunning = /\/session\/[^/]+\/message$/.test(cleanEventPath)
    || /\/session\/[^/]+\/command$/.test(cleanEventPath)
    || /\/session\/[^/]+\/summarize$/.test(cleanEventPath)
    || /\/session\/[^/]+\/shell$/.test(cleanEventPath)
    || /\/question\/[^/]+\/reply$/.test(cleanEventPath)
    || /\/permission\/[^/]+\/reply$/.test(cleanEventPath)

  // Busy 는 응답 본문 스트리밍이 끝날 때만 해제된다. 그래야 automation watcher 가
  // 처리 중인 요청 위로 instance reload(dispose) 를 실행하지 않는다.
  const busy: BusyToken | null = isLongRunning ? acquireBusy() : null
  const releaseBusy = () => { busy?.release() }

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

    let body = method !== 'GET' && method !== 'HEAD' ? await request.text() : undefined

    if (method === 'POST' && body && proxyDb && /\/session\/[^/]+\/message$/.test(cleanEventPath)) {
      try {
        const directory = query['directory'] ? decodeURIComponent(query['directory']) : undefined
        const parsed = JSON.parse(body) as { parts?: { type?: string; text?: string }[] }
        const firstText = parsed?.parts?.find((p) => p.type === 'text' && typeof p.text === 'string') as { type: string; text: string } | undefined
        if (firstText) {
          const text = firstText.text ?? ''
          const cmdMatch = text.trim().match(/^\/([a-zA-Z0-9_-]+)/)
          const commandName = cmdMatch?.[1]
          if (commandName && !text.includes('[run-context]')) {
            const scope = await resolveCommandScope(commandName, undefined, directory)
            if (scope !== 'builtin') {
              const { buildRunContext, CIRCUIT_BREAKER_THRESHOLD } = await import('./run-context')
              const { block, facts } = await buildRunContext(proxyDb, directory, commandName, 10)
              if (facts.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
                logger.warn(`[run-context] circuit breaker warn: ${commandName} consecutive failures ${facts.consecutiveFailures}`)
              }
              firstText.text = `${block}\n\n${text}`
              body = JSON.stringify(parsed)
            }
            // recall은 스킬/커맨드 실행 시에만 주입 (일반 채팅에는 주입 안 함)
            try {
              const argsText = text.replace(/^\/[a-zA-Z0-9_-]+\s*/, '').trim()
              const q = (argsText.length >= 2 ? argsText : text).slice(0, 500)
              if (q.length >= 2) {
                const prefRow = proxyDb.query('SELECT preferences FROM user_preferences WHERE user_id = ?').get('default') as { preferences: string } | undefined
                let enabled = true
                let topK = 4
                if (prefRow) {
                  try {
                    const p = JSON.parse(prefRow.preferences) as { autoRecallEnabled?: boolean; recallTopK?: number }
                    if (p.autoRecallEnabled === false) enabled = false
                    if (typeof p.recallTopK === 'number' && p.recallTopK >= 1 && p.recallTopK <= 10) topK = p.recallTopK
                  } catch {}
                }
                if (enabled) {
                  const { buildRecall } = await import('./recall')
                  const { resolveRepoId } = await import('./command-runs')
                  const repoId = directory ? resolveRepoId(proxyDb, directory) : null
                  const { block } = buildRecall(proxyDb, q, { k: topK, repoId: repoId ?? undefined })
                  if (block) {
                    const cur = JSON.parse(body) as { parts?: { type?: string; text?: string }[] }
                    const curFirst = cur?.parts?.find((p) => p.type === 'text' && typeof p.text === 'string') as { text: string } | undefined
                    if (curFirst) {
                      curFirst.text = `${block}\n\n${curFirst.text}`
                      body = JSON.stringify(cur)
                      firstText.text = curFirst.text
                    }
                  }
                }
              }
            } catch (e) {
              logger.debug('memory recall injection (command) skipped:', e)
            }
          } else if (!text.includes('<memory-recall>') && !text.includes('<skill-memory-check>') && !text.includes('[run-context]')) {
            const sessionIdFromPath = cleanEventPath.match(/\/session\/([^/]+)\/message/)?.[1]
            let skillBlock = ''
            if (sessionIdFromPath) {
              try {
                const { getAndClearPendingSkillCheck } = await import('./command-hooks')
                const pending = getAndClearPendingSkillCheck(sessionIdFromPath)
                if (pending) {
                  let auto = false
                  try {
                    const repoIdForCheck = directory ? (await import('./command-runs')).resolveRepoId(proxyDb, directory) : null
                    if (repoIdForCheck != null) {
                      const row = proxyDb.query('SELECT skill_auto_update FROM repos WHERE id = ?').get(repoIdForCheck) as { skill_auto_update?: number } | undefined
                      auto = Boolean(row?.skill_auto_update)
                    }
                  } catch {}
                  if (auto) {
                    skillBlock = `<skill-memory-check>\nLast ${pending.kind} "${pending.commandName}" completed with status "${pending.status}". Skill auto update is ENABLED for this repo. Please evaluate if skill or memory needs update and if there are improvements, update directly without asking user.\n</skill-memory-check>\n\n`
                  } else {
                    skillBlock = `<skill-memory-check>\nLast ${pending.kind} "${pending.commandName}" completed with status "${pending.status}".\nPlease evaluate if skill or memory needs update and if there are improvements. If yes, ask the user in chat for approval before updating (in Korean, concise).\n</skill-memory-check>\n\n`
                  }
                }
              } catch {}
            }
            let recallBlock = ''
            if (commandName && text.trim().length >= 4) {
              try {
                const prefRow = proxyDb.query('SELECT preferences FROM user_preferences WHERE user_id = ?').get('default') as { preferences: string } | undefined
                let enabled = true
                let topK = 4
                if (prefRow) {
                  try {
                    const p = JSON.parse(prefRow.preferences) as { autoRecallEnabled?: boolean; recallTopK?: number }
                    if (p.autoRecallEnabled === false) enabled = false
                    if (typeof p.recallTopK === 'number' && p.recallTopK >= 1 && p.recallTopK <= 10) topK = p.recallTopK
                  } catch {}
                }
                if (enabled) {
                  const { buildRecall } = await import('./recall')
                  const { resolveRepoId } = await import('./command-runs')
                  const repoId = directory ? resolveRepoId(proxyDb, directory) : null
                  const { block } = buildRecall(proxyDb, text.slice(0, 500), { k: topK, repoId: repoId ?? undefined })
                  if (block) recallBlock = `${block}\n\n`
                }
              } catch (e) {
                logger.debug('memory recall injection skipped:', e)
              }
            }
            const combined = `${skillBlock}${recallBlock}`
            if (combined) {
              firstText.text = `${combined}${text}`
              body = JSON.stringify(parsed)
            }
          }
        }
      } catch (e) {
        logger.warn('run-context injection failed:', e)
      }
    }

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
      // Only treat as timeout if status is 504/408, or 5xx with timeout wording.
      // Previously any 4xx containing the word "timeout" in body was misclassified as 504 (false positives during normal operation).
      const isTimeoutResponse =
        response.status === 504 ||
        response.status === 408 ||
        (response.status >= 500 &&
          (lower.includes('timeout') ||
            lower.includes('timed out') ||
            lower.includes('deadline exceeded') ||
            lower.includes('deadline')))
      if (isTimeoutResponse) {
        // opencode 내부 타임아웃은 300s (5분), proxy 타임아웃(600s)과 구분한다.
        const opencodeHint = ' - OpenCode internal timeout (300s / 5분). The session turn is too long or the model is still generating. Please retry or reduce context.'
        let parsed: Record<string, unknown> | undefined
        try { parsed = JSON.parse(bodyText) as Record<string, unknown> } catch { parsed = undefined }
        if (parsed) {
          const msg = typeof parsed.message === 'string' ? parsed.message : typeof parsed.error === 'string' ? parsed.error : bodyText
          const alreadyHasHint = msg.toLowerCase().includes('300s') || msg.includes('5분') || msg.toLowerCase().includes('600s')
          const enrichedMsg = alreadyHasHint ? msg : msg + opencodeHint
          const enriched = { ...parsed, error: enrichedMsg, message: enrichedMsg, timeoutMs: 300_000, timeoutSource: 'opencode' }
          responseHeaders['Content-Type'] = 'application/json'
          return new Response(JSON.stringify(enriched), {
            status: 504,
            statusText: 'Gateway Timeout',
            headers: responseHeaders,
          })
        }
        responseHeaders['Content-Type'] = 'application/json'
        const enrichedBody = bodyText.trim()
          ? (bodyText.toLowerCase().includes('300s') || bodyText.includes('5분') ? bodyText : bodyText + opencodeHint)
          : `Gateway Timeout (504): OpenCode internal timeout (300s / 5분).${opencodeHint}`
        return new Response(JSON.stringify({ error: enrichedBody, timeoutMs: 300_000, timeoutSource: 'opencode' }), {
          status: 504,
          headers: { 'Content-Type': 'application/json' },
        })
      }
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

      // 40x: preserve provider body, append English billing hint and billing URL.
      // Frontend formatServerError will show it as toast for 402/429.
      if (response.status >= 400 && response.status < 500 && isBillingQuota) {
        let parsed: Record<string, unknown> | undefined
        try { parsed = JSON.parse(bodyText) as Record<string, unknown> } catch { parsed = undefined }
        const hint = ' - free quota/balance exhausted. Payment required. (https://opencode.ai/zen)'
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
      const alive = await opencodeServerManager.checkHealth().catch(() => false)
      const source = alive ? 'Backend proxy' : 'Backend'
      // proxy 타임아웃은 600s, opencode 내부 타임아웃(300s/5분)과 구분한다.
      const hint = alive
        ? 'OpenCode server is alive but the request timed out (600s). Proxy timeout — the session turn is too long or the model is still generating. Please retry or reduce context.'
        : 'OpenCode server is not reachable (health check failed). It may have crashed or the port is blocked.'
      logger.debug(`[${source}] Proxy request timed out:`, err)
      return new Response(JSON.stringify({ error: `[${source}] Gateway Timeout (504): ${rawMsg} - ${hint}`, code: 'TIMEOUT', alive, source, timeoutMs: 600_000, timeoutSource: 'proxy' }), {
        status: 504,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    logger.error(`[Backend] Proxy request failed:`, error)
    const isConnRefused = causeCode && /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|CONNECTIONREFUSED/i.test(String(causeCode))
    const alive = await opencodeServerManager.checkHealth().catch(() => false)
    const hint = isConnRefused
      ? (alive ? 'OpenCode server recovered but the connection was reset. Retrying may succeed.' : 'Cannot connect to OpenCode server (:5552). Backend may be starting the server or the port is blocked. Check backend logs and `opencode --version`.')
      : (alive ? 'Backend->OpenCode proxy failed but server is alive. Check network/firewall.' : 'Backend->OpenCode proxy failed and server is not reachable.')
    return new Response(JSON.stringify({ error: `[Backend] Bad Gateway (502): ${rawMsg} - ${hint}`, code: causeCode || 'PROXY_502', opencodeUrl: opencodeServerManager.getUrl(), alive, source: 'Backend' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
