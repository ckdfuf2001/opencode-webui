import { logger } from '../utils/logger'
import { getConfigPath } from '@opencode-webui/shared'
import { ensureServerAuth } from './opencode-auth'
import { opencodeServerManager } from './opencode-single-server'
import { readdir, stat } from 'fs/promises'
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

async function dirFiles(dir: string): Promise<Set<string>> {
  const names = new Set<string>()
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        names.add(entry.name.replace(/\.md$/, ''))
      }
    }
  } catch {
    // directory does not exist
  }
  return names
}

export type CommandScope = 'builtin' | 'global' | 'project'

export async function resolveCommandScope(
  name: string,
  source: string | undefined,
  directory?: string,
): Promise<CommandScope> {
  // Trust opencode's own scoping when the /command payload reports one.
  if (source === 'project' || source === 'global' || source === 'builtin') {
    return source
  }

  const kindDirs = source === 'skill' ? ['skills', 'skill'] : ['commands', 'command']

  if (directory) {
    for (const kindDir of kindDirs) {
      if ((await dirFiles(path.join(directory, '.opencode', kindDir))).has(name)) return 'project'
    }
  }

  const globalBase = getConfigPath()
  for (const kindDir of kindDirs) {
    if (await fileExists(path.join(globalBase, kindDir, `${name}.md`))) return 'global'
  }

  // Config-defined and registry commands have no .md file. These are user
  // commands (global), not built-in, so never fall back to 'builtin'.
  return 'global'
}

function parseDirectory(url: URL): string | undefined {
  const value = url.searchParams.get('directory')
  return value ? decodeURIComponent(value) : undefined
}

export async function proxyRequest(request: Request, method: string, pathname: string, query: Record<string, string>) {
  const search = query ? '?' + new URLSearchParams(query).toString() : ''
  const cleanPath = pathname.replace(/^\/api\/opencode/, '') + search
  const targetUrl = `${opencodeServerManager.getUrl()}${cleanPath}`
  
  try {
    const headers = ensureServerAuth({})
    request.headers.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (['host', 'connection', 'authorization', 'accept-encoding'].includes(lower)) {
        return
      }
      headers[key] = value
    })

    const cleanEventPath = pathname.replace(/^\/api\/opencode/, '')
    const isEventStream = cleanEventPath === '/event' || cleanEventPath === '/global/event' || cleanEventPath.startsWith('/event?')
    const signal = isEventStream ? undefined : AbortSignal.timeout(120_000)

    const body = method !== 'GET' && method !== 'HEAD' ? await request.text() : undefined

    const response = await fetch(targetUrl, {
      method,
      headers,
      body,
      signal,
    })

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

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  } catch (error) {
    const err = error as { name?: string }
    if (err?.name === 'TimeoutError') {
      logger.debug('Proxy request timed out:', err)
    } else {
      logger.error(`Proxy request failed:`, error)
    }
    return new Response(JSON.stringify({ error: 'Proxy request failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
