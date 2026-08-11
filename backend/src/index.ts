import { EventEmitter } from 'events'
EventEmitter.defaultMaxListeners = 20

import path from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from '@hono/node-server/serve-static'
import { initializeDatabase } from './db/schema'
import { createRepoRoutes } from './routes/repos'
import { createSettingsRoutes } from './routes/settings'
import { createScheduleRoutes } from './routes/schedules'
import { createPermissionRuleRoutes } from './routes/permission-rules'
import { createHealthRoutes } from './routes/health'
import { createTTSRoutes, cleanupExpiredCache } from './routes/tts'
import { createFileRoutes } from './routes/files'
import { createRegistryRoutes } from './routes/registry'
import { createProvidersRoutes } from './routes/providers'
import { createPreviewRoutes } from './routes/preview'
import { stopConverter } from './services/doc-converter'
import { startScheduleRunner } from './services/scheduler'
import { ensureDirectoryExists, writeFileContent, readFileContent, fileExists } from './services/file-operations'
import { SettingsService } from './services/settings'
import { mergeDefaultMcpEntries, warmUpAgentBrowserDaemon, writeRepoOpenCodeConfig, repoAgentBrowserNamespace } from './services/default-mcp'
import { opencodeServerManager, prepareBackendPort } from './services/opencode-single-server'
import { cleanupOrphanedDirectories } from './services/repo'
import { listRepos } from './db/queries'
import { openApiSpec } from './services/api-docs'
import { proxyRequest } from './services/proxy'
import { logger } from './utils/logger'
import { 
  getWorkspacePath, 
  getReposPath, 
  getConfigPath,
  getOpenCodeConfigFilePath,
  getDatabasePath,
  ENV
} from '@opencode-webui/shared'

const { PORT, HOST } = ENV.SERVER
const DB_PATH = getDatabasePath()

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection (preventing crash):', reason)
})
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception (preventing crash):', error)
})

const app = new Hono()

app.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

const db = initializeDatabase(DB_PATH)

const DEFAULT_OPENCODE_CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  theme: 'opencode',
  autoupdate: true,
  share: 'disabled',
  keybinds: {
    leader: 'ctrl+x',
    app_exit: 'ctrl+c,ctrl+d,<leader>q',
    editor_open: '<leader>e',
    theme_list: '<leader>t',
    sidebar_toggle: '<leader>b',
    status_view: '<leader>s',
    session_export: '<leader>x',
    session_new: '<leader>n',
    session_list: '<leader>l',
    session_timeline: '<leader>g',
    session_share: 'none',
    session_unshare: 'none',
    session_interrupt: 'escape',
    session_compact: '<leader>c',
    messages_page_up: 'pageup',
    messages_page_down: 'pagedown',
    messages_half_page_up: 'ctrl+alt+u',
    messages_half_page_down: 'ctrl+alt+d',
    messages_first: 'ctrl+g,home',
    messages_last: 'ctrl+alt+g,end',
    messages_copy: '<leader>y',
    messages_undo: '<leader>u',
    messages_redo: '<leader>r',
    messages_toggle_conceal: '<leader>h',
    model_list: '<leader>m',
    model_cycle_recent: 'f2',
    model_cycle_recent_reverse: 'shift+f2',
    command_list: 'ctrl+p',
    agent_list: '<leader>a',
    agent_cycle: 'tab',
    agent_cycle_reverse: 'shift+tab',
    input_clear: 'ctrl+c',
    input_forward_delete: 'ctrl+d',
    input_paste: 'ctrl+v',
    input_submit: 'return',
    input_newline: 'shift+return,ctrl+j',
    history_previous: 'up',
    history_next: 'down',
    session_child_cycle: '<leader>right',
    session_child_cycle_reverse: '<leader>left',
    terminal_suspend: 'ctrl+z',
  },
  permission: {
    bash: {
      '*': 'allow',
    },
  },
}

async function ensureDefaultConfigExists(): Promise<void> {
  const settingsService = new SettingsService(db)
  const configs = settingsService.getOpenCodeConfigs()
  
  if (configs.configs.length === 0) {
    logger.info('No OpenCode configs found, creating default config')
    settingsService.createOpenCodeConfig({
      name: 'default',
      content: mergeDefaultMcpEntries(DEFAULT_OPENCODE_CONFIG),
      isDefault: true,
    })
    logger.info('Created default OpenCode config')
  }
}

async function ensureGlobalRulesFile(): Promise<void> {
  const source = path.join(process.cwd(), 'docs', 'agent-domain-guide.md')
  const target = path.join(getConfigPath(), 'AGENTS.md')
  if (!(await fileExists(source))) return
  if (await fileExists(target)) return
  const content = await readFileContent(source)
  await writeFileContent(target, content)
  logger.info(`Installed global rules file: ${target}`)
}

async function syncDefaultConfigToDisk(): Promise<void> {
  const settingsService = new SettingsService(db)
  const defaultConfig = settingsService.getDefaultOpenCodeConfig()
  
  if (defaultConfig) {
    const merged = mergeDefaultMcpEntries(defaultConfig.content)
    if (JSON.stringify(merged.mcp) !== JSON.stringify(defaultConfig.content.mcp)) {
      settingsService.updateOpenCodeConfig(defaultConfig.name, { content: merged }, 'default')
      logger.info('Merged default MCP servers into default config')
    }
    const configPath = getOpenCodeConfigFilePath()
    const configContent = JSON.stringify(merged, null, 2)
    await writeFileContent(configPath, configContent)
    logger.info(`Synced default config '${defaultConfig.name}' to: ${configPath}`)
  } else {
    logger.info('No default OpenCode config found in database')
  }
}

try {
  await ensureDirectoryExists(getWorkspacePath())
  await ensureDirectoryExists(getReposPath())
  await ensureDirectoryExists(getConfigPath())
  logger.info('Workspace directories initialized')
  
  await cleanupOrphanedDirectories(db)
  logger.info('Orphaned directory cleanup completed')
  
  await cleanupExpiredCache()
  
  await prepareBackendPort(PORT)
  
  await ensureDefaultConfigExists()
  await syncDefaultConfigToDisk()
  await ensureGlobalRulesFile()
} catch (error) {
  logger.error('Failed to initialize workspace:', error)
}

app.route('/api/repos', createRepoRoutes(db))
app.route('/api/settings', createSettingsRoutes(db))
app.route('/api/schedules', createScheduleRoutes(db))
app.route('/api/permission-rules', createPermissionRuleRoutes(db))
app.route('/api/health', createHealthRoutes(db))
app.route('/api/files', createFileRoutes(db))
app.route('/api/providers', createProvidersRoutes())
app.route('/api/tts', createTTSRoutes(db))
app.route('/api/registry', createRegistryRoutes())
app.route('/api/preview', createPreviewRoutes())

app.get('/api/openapi.json', (c) => c.json(openApiSpec))

app.get('/api/docs', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenCode WebUI - Backend API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body { margin: 0; }
    .swagger-ui .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      SwaggerUIBundle({
        url: '/api/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        persistAuthorization: true,
      })
    }
  </script>
</body>
</html>`)
})

app.all('/api/opencode/*', async (c) => {
  return proxyRequest(c.req.raw, c.req.method, c.req.path, c.req.query())
})

const isProduction = ENV.SERVER.NODE_ENV === 'production'

if (isProduction) {
  app.use('/*', serveStatic({ root: './frontend/dist' }))
  
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.notFound()
    }
    const fs = await import('fs/promises')
    const path = await import('path')
    const indexPath = path.join(process.cwd(), 'frontend/dist/index.html')
    const html = await fs.readFile(indexPath, 'utf-8')
    return c.html(html)
  })
} else {
  app.get('/', (c) => {
    return c.json({
      name: 'OpenCode WebUI',
      version: '2.0.0',
      status: 'running',
      endpoints: {
        health: '/api/health',
        repos: '/api/repos',
        settings: '/api/settings',
        schedules: '/api/schedules',
        sessions: '/api/sessions',
        files: '/api/files',
        providers: '/api/providers',
        opencode_proxy: '/api/opencode/*'
      }
    })
  })

  app.get('/api/network-info', async (c) => {
    const os = await import('os')
    const interfaces = os.networkInterfaces()
    const ips = Object.values(interfaces)
      .flat()
      .filter(info => info && !info.internal && info.family === 'IPv4')
      .map(info => info!.address)
    
    const requestHost = c.req.header('host') || `localhost:${PORT}`
    const protocol = c.req.header('x-forwarded-proto') || 'http'
    
    return c.json({
      host: HOST,
      port: PORT,
      requestHost,
      protocol,
      availableIps: ips,
      apiUrls: [
        `${protocol}://localhost:${PORT}`,
        ...ips.map(ip => `${protocol}://${ip}:${PORT}`)
      ]
    })
  })
}

let isShuttingDown = false
let healthCheckInterval: NodeJS.Timeout | null = null
let scheduleRunner: NodeJS.Timeout | null = null

const shutdown = async (signal: string) => {
  if (isShuttingDown) return
  isShuttingDown = true
  
  logger.info(`${signal} received, shutting down gracefully...`)
  if (healthCheckInterval) clearInterval(healthCheckInterval)
  if (agentBrowserWarmupInterval) clearInterval(agentBrowserWarmupInterval)
  if (scheduleRunner) clearInterval(scheduleRunner)
  try {
    await opencodeServerManager.stop()
    logger.info('OpenCode server stopped')
  } catch (error) {
    logger.error('Error stopping OpenCode server:', error)
  }
  httpServer?.close()
  stopConverter()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

let httpServer: ReturnType<typeof serve> | null = null

const startServer = async () => {
  try {
    await new Promise<void>((resolve, reject) => {
      const server = serve({
        fetch: app.fetch,
        port: PORT,
        hostname: HOST,
      })
      httpServer = server
      server.on('listening', () => resolve())
      server.on('error', (err: NodeJS.ErrnoException) => reject(err))
    })
  } catch (error: any) {
    if (error.code === 'EADDRINUSE') {
      logger.error(`Port ${PORT} is already in use. Free it or change PORT in .env and restart.`)
      process.exit(1)
    }
    throw error
  }
  logger.info(`🚀 OpenCode WebUI API running on http://${HOST}:${PORT}`)
}

await startServer()

const startupSettings = new SettingsService(db)
opencodeServerManager.setPreferredBinPath(startupSettings.getSettings().preferences.opencodeBin ?? null)

for (const repo of listRepos(db)) {
  try {
    if (writeRepoOpenCodeConfig(repo.localPath)) {
      logger.info(`Ensured per-repo OpenCode config for repo ${repo.localPath}`)
    }
  } catch (error) {
    logger.warn(`Failed to write per-repo OpenCode config for ${repo.localPath}:`, error)
  }
}

async function warmUpAllAgentBrowserDaemons(): Promise<void> {
  const namespaces = new Set<string>(['opencode'])
  for (const repo of listRepos(db)) {
    namespaces.add(repoAgentBrowserNamespace(repo.localPath))
  }
  for (const namespace of namespaces) {
    await warmUpAgentBrowserDaemon(namespace)
  }
}

opencodeServerManager.start()
  .then(() => {
    logger.info(`OpenCode server running on port ${opencodeServerManager.getPort()}`)
    warmUpAllAgentBrowserDaemons().catch((error) => {
      logger.error('Agent-browser daemon warm-up error:', error)
    })
  })
  .catch((error) => {
    logger.error('Failed to start OpenCode server:', error)
  })

healthCheckInterval = setInterval(() => {
  opencodeServerManager.ensureRunning().catch((error) => {
    logger.error('Failed to ensure OpenCode server is running:', error)
  })
}, ENV.TIMEOUTS.HEALTH_CHECK_INTERVAL_MS)

let agentBrowserWarmupInterval: NodeJS.Timeout | null = null
agentBrowserWarmupInterval = setInterval(() => {
  warmUpAllAgentBrowserDaemons().catch((error) => {
    logger.error('Agent-browser daemon re-warm-up error:', error)
  })
}, 60_000)

scheduleRunner = startScheduleRunner(db)
logger.info('Schedule runner started')