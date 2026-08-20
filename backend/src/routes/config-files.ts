import { Hono } from 'hono'
import { z } from 'zod'
import path from 'path'
import type { Database } from 'bun:sqlite'
import { logger } from '../utils/logger'
import { getConfigPath, getReposPath, getOpenCodeConfigFilePath } from '@opencode-webui/shared'
import { readFileContent, writeFileContent, fileExists, deletePath } from '../services/file-operations'
import { SettingsService } from '../services/settings'
import { patchOpenCodeConfig } from '../services/proxy'
import { mergeDefaultMcpEntries } from '../services/default-mcp'

const CONFIG_NAMES = ['AGENTS.md', 'opencode.json'] as const
type ConfigName = typeof CONFIG_NAMES[number]

interface ConfigFileInfo {
  name: ConfigName
  scope: 'global' | 'project'
  path: string
  exists: boolean
  content: string | null
}

const WriteConfigFileSchema = z.object({
  scope: z.enum(['global', 'project']),
  name: z.enum(CONFIG_NAMES),
  content: z.string().max(500000),
  directory: z.string().optional(),
})

function resolveConfigFile(scope: 'global' | 'project', name: ConfigName, directory?: string): string {
  if (scope === 'global') {
    return name === 'opencode.json' ? getOpenCodeConfigFilePath() : path.join(getConfigPath(), name)
  }
  if (!directory) {
    throw { message: 'Project scope requires a directory', statusCode: 400 }
  }
  const repoBase = path.resolve(getReposPath())
  const dir = path.resolve(directory)
  if (dir !== repoBase && !dir.startsWith(repoBase + path.sep)) {
    throw { message: 'Invalid project directory', statusCode: 403 }
  }
  return path.join(dir, name)
}

async function readConfigIfExists(filePath: string, maxBytes = 200_000): Promise<string | null> {
  try {
    if (!(await fileExists(filePath))) return null
    const stats = await (await import('../services/file-operations')).getFileStats(filePath)
    if (stats.size > maxBytes) return null
    return await readFileContent(filePath)
  } catch {
    return null
  }
}

export function createConfigFileRoutes(db: Database) {
  const app = new Hono()

  app.get('/', async (c) => {
    try {
      const directory = c.req.query('directory') || undefined
      const scopeList: ('global' | 'project')[] = ['global']
      if (directory) scopeList.push('project')

      const files: ConfigFileInfo[] = []
      for (const scope of scopeList) {
        for (const name of CONFIG_NAMES) {
          const target = resolveConfigFile(scope, name, directory)
          files.push({
            name,
            scope,
            path: target,
            exists: await fileExists(target),
            content: await readConfigIfExists(target),
          })
        }
      }

      return c.json({ files })
    } catch (error) {
      logger.error('Failed to list config files:', error)
      return c.json({ error: 'Failed to list config files' }, 500)
    }
  })

  app.put('/', async (c) => {
    try {
      const body = await c.req.json()
      const validated = WriteConfigFileSchema.parse(body)

      if (validated.scope === 'global' && validated.name === 'opencode.json') {
        let parsedContent: Record<string, unknown>
        try {
          parsedContent = JSON.parse(validated.content) as Record<string, unknown>
        } catch {
          return c.json({ error: 'Invalid JSON in opencode.json content' }, 400)
        }

        const settingsService = new SettingsService(db)
        const existing = settingsService.getDefaultOpenCodeConfig()
        const merged = mergeDefaultMcpEntries(parsedContent)
        if (existing) {
          settingsService.updateOpenCodeConfig(existing.name, { content: merged, isDefault: true })
        } else {
          settingsService.createOpenCodeConfig({ name: 'default', content: merged, isDefault: true })
        }

        const diskContent = JSON.stringify(merged, null, 2)
        await writeFileContent(getOpenCodeConfigFilePath(), diskContent)
        await patchOpenCodeConfig(merged)
        logger.info(`Saved global opencode.json config and synced default config`)
        return c.json({ success: true, path: getOpenCodeConfigFilePath() })
      }

      const target = resolveConfigFile(validated.scope, validated.name, validated.directory)
      await writeFileContent(target, validated.content)
      logger.info(`Wrote config file ${validated.scope}/${validated.name} -> ${target}`)
      return c.json({ success: true, path: target })
    } catch (error) {
      logger.error('Failed to write config file:', error)
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid data', details: error.issues }, 400)
      }
      const statusCode = (error as { statusCode?: number })?.statusCode ?? 500
      return c.json({ error: 'Failed to write config file', message: (error as Error).message }, statusCode as 400 | 500)
    }
  })

  app.delete('/', async (c) => {
    try {
      const scope = c.req.query('scope') as 'global' | 'project' | undefined
      const name = c.req.query('name') as ConfigName | undefined
      const directory = c.req.query('directory') || undefined

      if (!scope || !['global', 'project'].includes(scope)) return c.json({ error: 'Invalid scope' }, 400)
      if (!name || !CONFIG_NAMES.includes(name)) return c.json({ error: 'Invalid name' }, 400)

      if (scope === 'global' && name === 'opencode.json') {
        return c.json({ error: 'Global opencode.json is managed via Settings. Delete it there instead.' }, 400)
      }

      const target = resolveConfigFile(scope, name, directory)
      if (!(await fileExists(target))) {
        return c.json({ error: 'Config file not found' }, 404)
      }
      await deletePath(target)
      logger.info(`Deleted config file ${scope}/${name} -> ${target}`)
      return c.json({ success: true })
    } catch (error) {
      logger.error('Failed to delete config file:', error)
      return c.json({ error: 'Failed to delete config file' }, 400)
    }
  })

  return app
}