import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

try {
  const { config } = await import('dotenv')
  config()
} catch {
  // dotenv not available
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const resolveWorkspacePath = () => {
  const envPath = process.env.WORKSPACE_PATH
  if (envPath) {
    if (envPath.startsWith('~')) {
      return join(process.env.HOME ?? process.env.USERPROFILE ?? '.', envPath.slice(1))
    }
    return resolve(envPath)
  }
  return join(root, 'workspace')
}

const workspacePath = resolveWorkspacePath()
const configDir = join(workspacePath, '.config', 'opencode')
const configFile = join(configDir, 'opencode.json')

const docReaderScript = join(root, 'backend', 'scripts', 'doc_reader_mcp.py')
const workspaceBackend = `http://127.0.0.1:${process.env.PORT || '5002'}`

const defaultMcp = {
  'doc-reader': {
    type: 'local',
    enabled: true,
    command: ['python', docReaderScript],
    env: {
      OPCODE_WEBUI_BACKEND: workspaceBackend,
      OPCODE_WEBUI_WORKSPACE: workspacePath,
    },
  },
}

const agentBrowserMeta = join(root, 'bin', 'agent-browser', '.meta.json')
if (existsSync(agentBrowserMeta)) {
  const meta = JSON.parse(readFileSync(agentBrowserMeta, 'utf8'))
  const binPath = join(root, meta.bin)
  if (existsSync(binPath)) {
    const env = {}
    const executablePath = join(root, meta.executable)
    if (existsSync(executablePath)) {
      env.AGENT_BROWSER_EXECUTABLE_PATH = executablePath
    }
    env.AGENT_BROWSER_NAMESPACE = 'opencode'
    env.AGENT_BROWSER_IDLE_TIMEOUT_MS = '86400000'
    defaultMcp['agent-browser'] = {
      type: 'local',
      enabled: true,
      command: [binPath, 'mcp', '--namespace', 'opencode'],
      env,
    }
    console.log(`  [+] Found agent-browser binary (${meta.agentBrowserVersion === 'vendor' ? 'vendor' : 'v' + (meta.agentBrowserVersion ?? '?')})`)
  }
} else {
  console.log('  [.] agent-browser not installed - run: npm run agent-browser:install')
}

if (!existsSync(configFile)) {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(configFile, JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: {} }, null, 2))
}

const config = JSON.parse(readFileSync(configFile, 'utf8'))
config.mcp = config.mcp ?? {}

let changed = false
for (const [id, entry] of Object.entries(defaultMcp)) {
  const existing = config.mcp[id]
  const shouldUpdate = !existing || 
    JSON.stringify(existing.command) !== JSON.stringify(entry.command) ||
    JSON.stringify(existing.env) !== JSON.stringify(entry.env)
  
  if (shouldUpdate) {
    config.mcp[id] = entry
    changed = true
    console.log(`  [+] ${existing ? 'Updated' : 'Registered'} MCP server: ${id}`)
  } else {
    console.log(`  [.] MCP server already registered: ${id}`)
  }
}

if (changed) {
  writeFileSync(configFile, JSON.stringify(config, null, 2))
}
