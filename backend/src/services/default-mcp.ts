import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { getWorkspacePath } from '@opencode-webui/shared'
import { logger } from '../utils/logger'

const workspaceBackend = 'http://127.0.0.1:5001'

function buildDocReaderMcp(): Record<string, unknown> {
  return {
    'doc-reader': {
      type: 'local',
      enabled: true,
      command: ['python', path.join(process.cwd(), 'backend', 'scripts', 'doc_reader_mcp.py')],
      env: {
        OPCODE_WEBUI_BACKEND: workspaceBackend,
        OPCODE_WEBUI_WORKSPACE: getWorkspacePath(),
      },
    },
  }
}

function buildAgentBrowserMcp(): Record<string, unknown> {
  const metaFile = path.join(process.cwd(), 'bin', 'agent-browser', '.meta.json')
  if (!existsSync(metaFile)) return {}
  try {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as { bin?: string; executable?: string }
    const binPath = meta.bin ? path.join(process.cwd(), meta.bin) : ''
    if (!binPath || !existsSync(binPath)) return {}
    const env: Record<string, string> = {}
    const executablePath = meta.executable ? path.join(process.cwd(), meta.executable) : ''
    if (executablePath && existsSync(executablePath)) {
      env.AGENT_BROWSER_EXECUTABLE_PATH = executablePath
    }
    return {
      'agent-browser': {
        type: 'local',
        enabled: true,
        command: [binPath, 'mcp'],
        env,
      },
    }
  } catch (error) {
    logger.warn('Failed to read agent-browser meta:', error)
    return {}
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
    const repaired: Record<string, unknown> = { ...existing }
    let changed = false
    if (JSON.stringify(existingCommand) !== JSON.stringify(defaultCommand)) {
      repaired.command = defaultCommand
      changed = true
    }
    if (existing.enabled !== true) {
      repaired.enabled = true
      changed = true
    }
    if (changed) {
      mcp[id] = repaired
      logger.info(`Repaired default MCP server entry: ${id}`)
    }
  }
  return { ...content, mcp } as T
}
