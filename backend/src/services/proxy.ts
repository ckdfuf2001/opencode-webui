import { logger } from '../utils/logger'
import { ENV } from '@opencode-webui/shared'
import { ensureServerAuth } from './opencode-auth'
import { opencodeServerManager } from './opencode-single-server'
import { readdir, stat } from 'fs/promises'
import path from 'path'
import os from 'os'

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

  const kindDir = source === 'skill' ? 'skills' : 'commands'

  const projectCommands = directory ? await dirFiles(path.join(directory, '.opencode', kindDir)) : new Set<string>()
  if (projectCommands.has(name)) return 'project'

  const globalBase = path.join(os.homedir(), '.config', 'opencode')
  const globalCommands = await dirFiles(path.join(globalBase, kindDir))
  if (globalCommands.has(name)) return 'global'

  const workspaceConfig = path.join(ENV.WORKSPACE.BASE_PATH, ENV.WORKSPACE.CONFIG_DIR, kindDir)
  if (await fileExists(path.join(workspaceConfig, `${name}.md`))) return 'global'

  // Config-defined and registry commands have no .md file. These are user
  // commands (global), not built-in, so never fall back to 'builtin'.
  return 'global'
}

function parseDirectory(url: URL): string | undefined {
  const value = url.searchParams.get('directory')
  return value ? decodeURIComponent(value) : undefined
}

export async function proxyRequest(request: Request) {
  const url = new URL(request.url)
  const pathName = url.pathname + url.search

  // Remove /api/opencode prefix before forwarding to OpenCode server
  const cleanPath = pathName.replace(/^\/api\/opencode/, '')
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

    const cleanEventPath = url.pathname.replace(/^\/api\/opencode/, '')
    const isEventStream = cleanEventPath === '/event' || cleanEventPath === '/global/event' || cleanEventPath.startsWith('/event?')
    const signal = isEventStream ? undefined : AbortSignal.timeout(120_000)

    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? await request.text() : undefined,
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

    if (request.method === 'GET' && url.pathname.replace(/^\/api\/opencode/, '') === '/command') {
      try {
        const directory = parseDirectory(url)
        const body = await response.text()
        const commands = JSON.parse(body)
        if (Array.isArray(commands)) {
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
        return new Response(body, { status: response.status, headers: responseHeaders })
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
    logger.error(`Proxy request failed for ${pathName}:`, error)
    return new Response(JSON.stringify({ error: 'Proxy request failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
