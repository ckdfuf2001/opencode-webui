import { Hono } from 'hono'
import { z } from 'zod'
import { mkdir, writeFile, unlink, readdir, readFile, stat } from 'fs/promises'
import path from 'path'
import { logger } from '../utils/logger'
import { getConfigPath } from '@opencode-webui/shared'

type RegistryType = 'command' | 'skill' | 'tool' | 'agent'
type RegistryScope = 'global' | 'project'

const sanitize = (name: string): string => name.trim().replace(/[\\/:*?"<>|]/g, '-')

const TYPE_DIR: Record<RegistryType, string> = {
  command: 'command',
  skill: 'skill',
  tool: 'plugin',
  agent: 'agents',
}

async function listEntries(
  type: RegistryType,
  directory?: string
): Promise<{ name: string; scope: RegistryScope; path: string; content: string }[]> {
  const results: { name: string; scope: RegistryScope; path: string; content: string }[] = []
  const roots: { root: string; scope: RegistryScope }[] = [{ root: getConfigPath(), scope: 'global' }]
  if (directory) roots.push({ root: path.join(directory, '.opencode'), scope: 'project' })

  for (const { root, scope } of roots) {
    const dir = path.join(root, TYPE_DIR[type])
    let items: string[]
    try {
      items = await readdir(dir)
    } catch {
      continue
    }
    for (const item of items) {
      const full = path.join(dir, item)
      if (type === 'skill') {
        const skillFile = path.join(full, 'SKILL.md')
        try {
          await stat(skillFile)
          results.push({ name: item, scope, path: skillFile, content: await readFile(skillFile, 'utf-8') })
        } catch {
          continue
        }
      } else {
        try {
          const info = await stat(full)
          if (!info.isFile()) continue
          results.push({
            name: item.replace(/\.[^.]+$/, ''),
            scope,
            path: full,
            content: await readFile(full, 'utf-8'),
          })
        } catch {
          continue
        }
      }
    }
  }
  return results
}

function scopeRoot(scope: RegistryScope, directory?: string): string {
  if (scope === 'global') return getConfigPath()
  if (!directory) throw new Error('Project scope requires a directory')
  return path.join(directory, '.opencode')
}

function resolveTarget(type: RegistryType, scope: RegistryScope, name: string, directory?: string): string {
  const root = scopeRoot(scope, directory)
  const clean = sanitize(name)
  switch (type) {
    case 'command':
      return path.join(root, 'command', `${clean}.md`)
    case 'skill':
      return path.join(root, 'skill', clean, 'SKILL.md')
    case 'tool':
      return path.join(root, 'plugin', `${clean}.ts`)
    case 'agent':
      return path.join(root, 'agents', `${clean}.md`)
  }
}

function buildContent(type: RegistryType, data: { name: string; description: string; content: string; mode?: string }): string {
  switch (type) {
    case 'command':
      return data.content.trim()
    case 'skill':
      return [
        '---',
        `name: ${data.name}`,
        data.description ? `description: ${data.description}` : null,
        '---',
        '',
        data.content.trim(),
      ]
        .filter((line) => line !== null)
        .join('\n')
    case 'tool':
      return data.content.trim()
    case 'agent':
      return [
        '---',
        `description: ${data.description || data.name}`,
        `mode: ${data.mode || 'all'}`,
        '---',
        '',
        data.content.trim(),
      ].join('\n')
  }
}

function validateName(name: string) {
  if (!name.trim()) {
    return 'Name is required.'
  }
  if (name.trim().includes(' ')) {
    return 'Name must not contain spaces.'
  }
  return null
}

const CreateRegistrySchema = z.object({
  type: z.enum(['command', 'skill', 'tool', 'agent']),
  scope: z.enum(['global', 'project']),
  name: z.string().min(1).max(255),
  description: z.string().default(''),
  content: z.string().min(1).max(100000),
  mode: z.enum(['all', 'subagent', 'primary']).default('all'),
})

export function createRegistryRoutes() {
  const app = new Hono()

  app.post('/', async (c) => {
    try {
      const directory = c.req.query('directory') || undefined
      const body = await c.req.json()
      const validated = CreateRegistrySchema.parse(body)

      const nameError = validateName(validated.name)
      if (nameError) return c.json({ error: nameError }, 400)

      const target = resolveTarget(validated.type, validated.scope, validated.name, directory)
      const content = buildContent(validated.type, validated)

      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content, 'utf-8')

      logger.info(`Registered ${validated.type} ${validated.name} (${validated.scope}) -> ${target}`)
      return c.json({ success: true, type: validated.type, scope: validated.scope, name: validated.name, path: target })
    } catch (error) {
      logger.error('Failed to register opencode file:', error)
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid data', details: error.issues }, 400)
      }
      return c.json({ error: 'Failed to register file', message: (error as Error).message }, 400)
    }
  })

  app.get('/:type', async (c) => {
    const directory = c.req.query('directory') || undefined
    const type = c.req.param('type') as RegistryType

    if (!['command', 'skill', 'tool', 'agent'].includes(type)) {
      return c.json({ error: 'Invalid type' }, 400)
    }

    try {
      const entries = await listEntries(type, directory)
      return c.json(entries)
    } catch (error) {
      logger.error('Failed to list opencode files:', error)
      return c.json({ error: 'Failed to list files' }, 400)
    }
  })

  app.delete('/:type/:scope/:name', async (c) => {
    try {
      const directory = c.req.query('directory') || undefined
      const type = c.req.param('type') as RegistryType
      const scope = c.req.param('scope') as RegistryScope
      const name = c.req.param('name')

      if (!['command', 'skill', 'tool', 'agent'].includes(type)) return c.json({ error: 'Invalid type' }, 400)
      if (!['global', 'project'].includes(scope)) return c.json({ error: 'Invalid scope' }, 400)

      const target = resolveTarget(type, scope, name, directory)
      await unlink(target)
      return c.json({ success: true })
    } catch (error) {
      logger.error('Failed to delete opencode file:', error)
      return c.json({ error: 'Failed to delete file' }, 400)
    }
  })

  return app
}