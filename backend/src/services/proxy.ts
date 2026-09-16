import { logger } from '../utils/logger'
import { getConfigPath, getOpenCodeConfigFilePath } from '@opencode-webui/shared'
import { ensureServerAuth } from './opencode-auth'
import { opencodeServerManager } from './opencode-single-server'
import { truncateSessionMessages, deleteSessionMessage, stripAllReasoningParts } from './opencode-db'
import { acquireBusy, type BusyToken } from './busy-tracker'
import { flushQueueForSession, clearSendingOnAbort, dropDeliveredDuplicates } from './chat-queue'
import { healReasoningTail, sweepPollutedStubs, isReasoningMismatchText, asOutgoingModel, preSendStripIfMismatch } from './reasoning-heal'
import { open, readFile, stat, appendFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import type { Database } from 'bun:sqlite'

let proxyDb: Database | null = null
export function setProxyDb(db: Database): void {
  proxyDb = db
}

// MCP -32001 재웜 폭주 방지: 데몬이 아픈 동안 재시도마다 warmup을 걸면
// Chrome 병렬 기동 → 10060 악순환이 된다. 30초에 1회만.
let lastAgentBrowserRewarmAt = 0

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

/**
 * 직접전송 본문에서 user 텍스트를 꺼내 큐 고아를 제거한다.
 * 파싱 실패·텍스트 없음이면 손대지 않는다 (큐는 그대로 두고 폴러가 이어받는다).
 */
function dropDeliveredByBody(sessionID: string, rawBody: string): void {
  try {
    const parsed = JSON.parse(rawBody) as { parts?: Array<{ type?: string; text?: string }> }
    const text = (Array.isArray(parsed.parts) ? parsed.parts : [])
      .filter((p) => p?.type === 'text' && typeof p.text === 'string' && p.text.trim())
      .map((p) => p.text as string)
      .join('\n')
      .trim()
    if (text) dropDeliveredDuplicates(sessionID, text)
  } catch {
    // 본문 파싱 실패 — 큐에 손대지 않는다
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
    if (messageID.startsWith("optimistic_")) {
      return new Response(JSON.stringify({ success: true, messagesRemoved: 0, partsRemoved: 0, eventsRemoved: 0, todoRemoved: 0, remainingMessages: 0 }), {
        status: 200,
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

/**
 * long-running 응답(턴이 끝나야 헤더가 오는 /message 등)을 그대로 흘려보낸다.
 * busy는 스트리밍 종료 시에만 해제 + 종료 후 큐 flush. 정상 경로와
 * reasoning-heal 재시도 경로가 공유한다.
 */
function passThroughLongRunning(
  upstream: Response,
  responseHeaders: Record<string, string>,
  cleanEventPath: string,
  query: Record<string, string>,
  release: () => void,
): Response {
  if (!upstream.body) {
    release()
    return new Response(null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    })
  }
  const trackedStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader()
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
        release()
        reader.releaseLock()
        try {
          const m = cleanEventPath.match(/\/session\/([^/]+)\/message/)
          if (m?.[1]) {
            setTimeout(() => flushQueueForSession(m[1]!, query['directory'] ? decodeURIComponent(query['directory']) : undefined), 150)
          }
        } catch {}
      }
    },
    cancel() {
      release()
    },
  })

  return new Response(trackedStream, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
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

  // abort 시 큐의 sending 표시 즉시 제거 — 다음 채팅이 바로 가게
  const abortPath = pathname.replace(/^\/api\/opencode/, '')
  const abortMatch = abortPath.match(/^\/session\/([^/]+)\/abort$/)
  if (method === 'POST' && abortMatch?.[1]) {
    try { clearSendingOnAbort(abortMatch[1]!) } catch {}
  }

  const search = query ? '?' + new URLSearchParams(query).toString() : ''
  const cleanPath = pathname.replace(/^\/api\/opencode/, '') + search
  const targetUrl = `${opencodeServerManager.getUrl()}${cleanPath}`

  const cleanEventPath = pathname.replace(/^\/api\/opencode/, '')
  const isLongRunning = /\/session\/[^/]+\/message$/.test(cleanEventPath)
    || /\/session\/[^/]+\/command$/.test(cleanEventPath)
    || /\/session\/[^/]+\/summarize$/.test(cleanEventPath)
    || /\/session\/[^/]+\/shell$/.test(cleanEventPath)
    || /\/session\/[^/]+\/abort$/.test(cleanEventPath)
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
    if (method === 'POST' && cleanEventPath === '/session' && proxyDb) {
      try {
        const prefRow = proxyDb.query('SELECT preferences FROM user_preferences WHERE user_id = ?').get('default') as { preferences: string } | undefined
        if (prefRow) {
          const pref = JSON.parse(prefRow.preferences) as { defaultModel?: string }
          const dm = pref.defaultModel
          if (dm && typeof dm === 'string' && dm.includes('/')) {
            const [providerID, ...rest] = dm.split('/')
            const modelID = rest.join('/')
            if (providerID && modelID) {
              let parsed: Record<string, unknown> = {}
              if (body) { try { parsed = JSON.parse(body) as Record<string, unknown> } catch { parsed = {} } }
              if (!parsed.model) { parsed.model = { providerID, id: modelID }; body = JSON.stringify(parsed); logger.info(`Injected default model ${dm} into new session creation`) }
            }
          }
        }
      } catch {}
    }

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
            // 공용 헬퍼: pending이 있을 때만 1회 주입 (리뷰 자식 생성 시 consume되므로 중복 없음).
            // 자동 변경 ON=build(직접 수정) / OFF=plan(채팅 승인) 문구는 헬퍼가 결정한다.
            let skillBlock = ''
            if (sessionIdFromPath) {
              try {
                const { buildSkillCheckBlock } = await import('./command-hooks')
                const { resolveRepoId } = await import('./command-runs')
                skillBlock = buildSkillCheckBlock({
                  sessionId: sessionIdFromPath,
                  repoId: directory ? resolveRepoId(proxyDb, directory) : null,
                  db: proxyDb,
                })
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

    // 본문을 재작성한 경우(기본 모델 주입·run-context·recall) 원본
    // Content-Length와 길이가 어긋나 opencode가 다음 요청 경계를 못 찾아
    // 행업된다. 재작성 뒤에는 길이를 다시 맞춘다.
    if (body !== undefined) {
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === 'content-length' || k.toLowerCase() === 'transfer-encoding') {
          delete headers[k]
        }
      }
      headers['content-length'] = String(Buffer.byteLength(body))
    }

    // POST /session/:id/message 발송 직전: 꼬리가 mismatch 에러면 strip-only 클렌징.
    // opencode가 provider 400을 HTTP 200 + 메시지 error로 저장하는 경로가 있어
    // 응답-기준 heal만으로는 발동하지 않는다. truncate는 하지 않는다 (이번 본문과
    // 무관한 과거 user를 지우지 않기 위해) — strip+sweep+reload만으로 다음 전송을 살린다.
    if (method === 'POST' && body) {
      const preMatch = cleanEventPath.match(/^\/session\/([^/]+)\/message$/)
      if (preMatch?.[1]) {
        try {
          const preParsed = JSON.parse(body) as { parts?: Array<{ type?: string; text?: string }>; model?: unknown }
          const hasText = (Array.isArray(preParsed.parts) ? preParsed.parts : [])
            .some((p) => p?.type === 'text' && typeof p.text === 'string' && p.text.trim())
          if (hasText) {
            const preDir = query['directory'] ? decodeURIComponent(query['directory']) : undefined
            const pre = await preSendStripIfMismatch(opencodeServerManager.getUrl(), preMatch[1]!, preDir, asOutgoingModel(preParsed.model))
            if ((pre.strippedParts ?? 0) > 0 || (pre.strippedAllParts ?? 0) > 0 || (pre.stubsRemoved ?? 0) > 0) {
              if (preDir) {
                const reloaded = await opencodeServerManager.reloadAndVerify(preDir).catch(() => false)
                logger.warn(`Pre-send strip for session ${preMatch[1]}: stripped ${pre.strippedParts} reasoning part(s), strip-all ${pre.strippedAllParts} part(s), removed ${pre.stubsRemoved} stub(s), kept ${pre.keep ? `${pre.keep.providerID}/${pre.keep.modelID}` : 'unknown'} — instance reload ${reloaded ? 'verified' : 'NOT verified, forwarding anyway'}`)
              } else {
                logger.warn(`Pre-send strip for session ${preMatch[1]}: stripped ${pre.strippedParts} reasoning part(s), removed ${pre.stubsRemoved} stub(s) but no directory — reload skipped, forwarding anyway`)
              }
            }
          }
        } catch (e) {
          logger.warn(`Pre-send strip check failed for session ${preMatch[1]}:`, e)
        }
      }
    }

    const retryable = (error: unknown): boolean => {
      const code = (error as { cause?: { code?: unknown } })?.cause?.code
        ?? (error as { code?: unknown })?.code
      const msg = (error as { message?: string })?.message ?? ''
      if (typeof code === 'string' && code) {
        const normalized = code.toUpperCase()
        if (normalized === 'ECONNREFUSED'
          || normalized === 'ECONNRESET'
          || normalized === 'ENOTFOUND'
          || normalized === 'EAI_AGAIN'
          || normalized === 'CONNECTIONREFUSED'
          || normalized === 'CONNECTIONRESET'
          || normalized === 'CONNECTIONCLOSED'
          || normalized === 'UND_ERR_CONNECT_TIMEOUT'
          || normalized === 'WSAETIMEDOUT'
          || normalized.includes('10060')) return true
      }
      if (typeof msg === 'string' && (msg.includes('10060') || msg.toLowerCase().includes('wsaetimedout') || msg.toLowerCase().includes('timed out'))) return true
      return false
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

    // 세션 삭제 시 인덱스 함께 삭제 (withIndex=false면 스킵)
    if (response.ok && method === 'DELETE' && proxyDb) {
      const sessionDeleteMatch = cleanEventPath.match(/^\/session\/([^/?]+)$/)
      if (sessionDeleteMatch) {
        const withIndexParam = (query as Record<string, string>)?.withIndex
        const withIndex = withIndexParam == null ? true : withIndexParam !== 'false' && withIndexParam !== '0'
        if (withIndex) {
          const sid = sessionDeleteMatch[1]!
          try { proxyDb.query('DELETE FROM session_messages_fts WHERE session_id = ?').run(sid) } catch {}
          try { proxyDb.query('DELETE FROM session_messages_fts_idx WHERE session_id = ?').run(sid) } catch {}
          try { proxyDb.query('DELETE FROM session_status WHERE session_id = ?').run(sid) } catch {}
        }
      }
    }

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
      const isMcpTimeout =
        lower.includes('-32001') ||
        (lower.includes('mcp') && (lower.includes('timed out') || lower.includes('timeout'))) ||
        (lower.includes('agent-browser') && (lower.includes('timed out') || lower.includes('timeout')))
      if (isMcpTimeout) {
        const nowMs = Date.now()
        if (nowMs - lastAgentBrowserRewarmAt > 30_000) {
          lastAgentBrowserRewarmAt = nowMs
          void import('./default-mcp').then((m) => m.warmUpAgentBrowserDaemon().catch(() => undefined))
        }
        logger.warn('Agent-browser MCP call failed (likely cold daemon); triggered background re-warm:', bodyText.slice(0, 300))
        const hint = ' - agent-browser MCP timed out (MCP -32001). The browser daemon was likely cold or died (e.g. after cancel). Background re-warm triggered; please retry in a few seconds. Status: GET /api/mcp/agent-browser/status, warm: POST /api/mcp/agent-browser/warm.'
        let parsed: Record<string, unknown> | undefined
        try { parsed = JSON.parse(bodyText) as Record<string, unknown> } catch { parsed = undefined }
        responseHeaders['Content-Type'] = 'application/json'
        if (parsed) {
          const msg = typeof parsed.message === 'string' ? parsed.message : typeof parsed.error === 'string' ? parsed.error : bodyText
          const enriched = { ...parsed, error: `${msg}${hint}`, message: `${msg}${hint}`, retryable: true, mcp: 'agent-browser' }
          return new Response(JSON.stringify(enriched), {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
          })
        }
        return new Response(JSON.stringify({ error: `${bodyText}${hint}`, retryable: true, mcp: 'agent-browser' }), {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        })
      }
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

      // reasoning 암호문 불일치 (모델 전환·중단된 턴 뒤 이전 모델의 thinking 블록이
      // 히스토리에 남아 provider가 거부). POST /session/:id/message면 마지막 턴만
      // 잘라내고 동일 요청 1회 재전송한다 (투명 복구 — 중단 때문에 세션 전체가
      // 먹통이 되던 문제 대응). 오염이 더 앞 히스토리에 있으면 재시도도 실패하고
      // 아래 enriched error 안내(더 앞 가위질·원래 모델 복귀)로 넘어간다.
      if (isReasoningMismatchText(bodyText)) {
        let finalStatus = response.status
        let finalStatusText = response.statusText
        let finalBodyText = bodyText
        let healedAndRetried = false
        // heal 시도 내역 — exe는 콘솔 로그를 볼 수 없어 응답에 동봉한다 (다음 장애 진단용).
        const healInfo: { attempted: boolean; healed?: boolean; reason?: string; stubsRemoved?: number; strippedParts?: number; strippedAllParts?: number; stubsPending?: string[]; kind?: string; models?: Array<{ providerID: string; modelID: string; turns: number }> } = { attempted: false }
        const msgPost = method === 'POST' ? cleanEventPath.match(/^\/session\/([^/]+)\/message$/) : null
        if (msgPost?.[1] && body) {
          try {
            const parsedBody = JSON.parse(body) as { parts?: Array<{ type?: string; text?: string }>; model?: unknown }
            const sentText = (Array.isArray(parsedBody.parts) ? parsedBody.parts : [])
              .filter((p) => p?.type === 'text' && typeof p.text === 'string' && p.text.trim())
              .map((p) => p.text as string)
              .join('\n')
              .trim()
            if (sentText) {
              const directory = query['directory'] ? decodeURIComponent(query['directory']) : undefined
              healInfo.attempted = true
              // 본문 model이 없으면 세션 모델로 보낸 정상 경로 — heal이 세션 조회로 폴백한다.
              const heal = await healReasoningTail(opencodeServerManager.getUrl(), msgPost[1]!, directory, [sentText], { force: true, outgoingModel: asOutgoingModel(parsedBody.model) })
              healInfo.healed = heal.healed
              healInfo.reason = heal.reason
              healInfo.stubsRemoved = heal.stubsRemoved
              healInfo.strippedParts = heal.strippedParts
              healInfo.stubsPending = heal.stubsPending
              healInfo.kind = heal.kind
              healInfo.models = heal.models
              if (!heal.healed && heal.kind === 'cross-model') {
                // keep을 못 정해 strip 없이 끝난 경우 — 재시도 없이 안내만.
                const names = (heal.models ?? []).map((m) => `${m.providerID}/${m.modelID}`).join(', ')
                const back = heal.suggestedModel ? `${heal.suggestedModel.providerID}/${heal.suggestedModel.modelID}` : null
                finalBodyText = `${finalBodyText} (cross-model reasoning history [${names}]: switch back to ${back ?? 'the model that owns the latest good turn'}, truncate back before the switch, or start a new session. Manual deep-clean: POST /api/session-heal/${msgPost[1]})`
                healedAndRetried = false
              } else if (heal.healed) {
                // 단일 정리 추가분: 동일모델 stale 대응 strip-all + sweep (최신 턴 보존).
                // 정책상 정리+1회 재전송까지만 하고, 실패하면 failed로 남긴다.
                try {
                  const stripAll = await stripAllReasoningParts(msgPost[1]!)
                  healInfo.strippedAllParts = stripAll?.partsRemoved ?? 0
                } catch (e) {
                  logger.warn(`Reasoning heal strip-all threw for session ${msgPost[1]}:`, e)
                }
                try {
                  const sweepExtra = await sweepPollutedStubs(msgPost[1]!)
                  healInfo.stubsRemoved = (healInfo.stubsRemoved ?? 0) + sweepExtra.removed
                  healInfo.stubsPending = [...(healInfo.stubsPending ?? []), ...sweepExtra.pending]
                } catch (e) {
                  logger.warn(`Reasoning heal extra sweep threw for session ${msgPost[1]}:`, e)
                }
                // DB만 자르면 opencode 메모리 캐시가 오염 part를 그대로 보내므로
                // 재전송 전에 인스턴스를 dispose해 캐시를 비운다 (결과 명시 로깅).
                if (directory) {
                  try {
                    const reloaded = await opencodeServerManager.reloadAndVerify(directory)
                    logger.warn(`Reasoning heal: session ${msgPost[1]} truncated ${heal.truncatedMessageId} (stripped ${heal.strippedParts ?? 0} reasoning parts, stubs removed ${heal.stubsRemoved ?? 0}, pending ${(heal.stubsPending ?? []).length}) — instance reload ${reloaded ? 'verified' : 'NOT verified, retrying anyway'}`)
                  } catch (e) {
                    logger.warn(`Reasoning heal: instance reload threw for session ${msgPost[1]}, retrying anyway:`, e)
                  }
                } else {
                  logger.warn(`Reasoning heal: session ${msgPost[1]} truncated ${heal.truncatedMessageId} but no directory — instance reload skipped, retrying anyway`)
                }
                const busy2 = acquireBusy()
                const release2 = () => busy2.release()
                // 정책: 정리 후 정확히 1회만 재전송한다. 같은 400이면 failed로
                // 남기고 끝낸다 — 연속 재시도·deep-truncate 없음 (retry storm 방지).
                const resendOnce = async () => fetch(targetUrl, {
                  method,
                  headers,
                  body,
                  signal: AbortSignal.timeout(600_000),
                })
                try {
                  const retryRes = await resendOnce()
                  if (retryRes.ok) {
                    logger.info(`Reasoning heal: truncated tail and retry succeeded for session ${msgPost[1]}`)
                    return passThroughLongRunning(retryRes, responseHeaders, cleanEventPath, query, release2)
                  }
                  release2()
                  finalStatus = retryRes.status
                  finalStatusText = retryRes.statusText
                  finalBodyText = await retryRes.text().catch(() => '')
                  healedAndRetried = true
                  if (retryRes.status === 400 && isReasoningMismatchText(finalBodyText)) {
                    logger.warn(`Reasoning heal cleanup+retry hit the same mismatch for session ${msgPost[1]} — leaving failed (no further auto-retry)`)
                  }
                } catch (e) {
                  release2()
                  logger.warn(`Reasoning heal retry threw for session ${msgPost[1]}:`, e)
                  healedAndRetried = true
                  finalBodyText = `${finalBodyText} (auto-truncate done, retry failed: ${(e as Error)?.message ?? e})`
                }
              } else {
                logger.warn(`Reasoning heal skipped for session ${msgPost[1]}: ${heal.reason}`)
              }
            }
          } catch (e) {
            logger.warn('Reasoning heal attempt failed:', e)
          }
        }
        const hint = healedAndRetried
          ? ' - Automatic recovery (truncated the failed turn, stripped stale reasoning, retried once) did not help: start a new session, or truncate back further with the scissors icon on an earlier message and send again. (reasoning encrypted_content mismatch)'
          : ' - The conversation history contains reasoning blocks from a different model (or an interrupted turn). Truncate the last turn (scissors icon), switch back to the original model, or deep-clean via POST /api/session-heal/:sessionId, then send again. (reasoning encrypted_content mismatch)'
        let parsed: Record<string, unknown> | undefined
        try { parsed = JSON.parse(finalBodyText) as Record<string, unknown> } catch { parsed = undefined }
        responseHeaders['Content-Type'] = 'application/json'
        if (parsed) {
          const msg = typeof parsed.message === 'string' ? parsed.message : typeof parsed.error === 'string' ? parsed.error : finalBodyText
          const enriched = { ...parsed, error: `${msg}${hint}`, message: `${msg}${hint}`, retryable: false, code: 'REASONING_ENCRYPTED_MISMATCH', heal: healInfo }
          return new Response(JSON.stringify(enriched), {
            status: finalStatus,
            statusText: finalStatusText,
            headers: responseHeaders,
          })
        }
        return new Response(JSON.stringify({ error: `${finalBodyText}${hint}`, retryable: false, code: 'REASONING_ENCRYPTED_MISMATCH', heal: healInfo }), {
          status: finalStatus,
          statusText: finalStatusText,
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
      try {
        const m = cleanEventPath.match(/\/session\/([^/]+)\/message/)
        if (m?.[1]) {
          // 직접전송 성공 — 동일 텍스트의 큐 고아(failed 배지·중복 전송 원인)를 제거한다.
          if (method === 'POST' && body) dropDeliveredByBody(m[1]!, body)
          setTimeout(() => flushQueueForSession(m[1]!, query['directory'] ? decodeURIComponent(query['directory']) : undefined), 150)
        }
      } catch {}
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      })
    }

    let streamCompleted = false
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
          streamCompleted = true
        } catch (error) {
          controller.error(error)
        } finally {
          releaseBusy()
          reader.releaseLock()
          try {
            const m = cleanEventPath.match(/\/session\/([^/]+)\/message/)
            if (m?.[1]) {
              // 스트림 완주 = 턴 종료 — 직접전송 성공으로 보고 큐 고아를 제거한다.
              if (streamCompleted && method === 'POST' && body) dropDeliveredByBody(m[1]!, body)
              setTimeout(() => flushQueueForSession(m[1]!, query['directory'] ? decodeURIComponent(query['directory']) : undefined), 150)
            }
          } catch {}
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
