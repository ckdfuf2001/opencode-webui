import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspacePath = process.env.WORKSPACE_PATH ? resolve(process.env.WORKSPACE_PATH) : join(root, 'workspace')
const configDir = join(workspacePath, '.config', 'opencode')
const configFile = join(configDir, 'opencode.json')

const docReaderScript = join(root, 'backend', 'scripts', 'doc_reader_mcp.py')
const workspaceBackend = 'http://127.0.0.1:5001'

const defaultMcp = {
  'doc-reader': {
    type: 'local',
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
    defaultMcp['agent-browser'] = {
      type: 'local',
      command: [binPath, 'mcp'],
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
  if (!config.mcp[id]) {
    config.mcp[id] = entry
    changed = true
    console.log(`  [+] Registered MCP server: ${id}`)
  } else {
    console.log(`  [.] MCP server already registered: ${id}`)
  }
}

if (changed) {
  writeFileSync(configFile, JSON.stringify(config, null, 2))
}
