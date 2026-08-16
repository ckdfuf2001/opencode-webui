import { Hono } from 'hono'
import { z } from 'zod'
import { mkdir, writeFile, unlink, readdir, readFile, rm } from 'fs/promises'
import { statSync } from 'fs'
import path from 'path'
import { logger } from '../utils/logger'
import { getConfigPath, getWorkspacePath } from '@opencode-webui/shared'
import { opencodeServerManager } from '../services/opencode-single-server'

type RegistryType = 'command' | 'skill' | 'tool' | 'agent'
type RegistryScope = 'global' | 'project'

interface RegistryListItem {
  type: RegistryType
  scope: RegistryScope
  name: string
  description: string
  content: string
  mode?: string
  agent?: string
  model?: string
  subtask?: boolean
  topP?: number
  path: string
}

const sanitize = (name: string): string => name.trim().replace(/[\\/:*?"<>|]/g, '-')

function scopeRoot(scope: RegistryScope, directory?: string): string {
  if (scope === 'global') return getConfigPath()
  if (!directory) throw new Error('Project scope requires a directory')
  return path.join(directory, '.opencode')
}

// opencode scans plural directories (commands/skills/plugins/agents) as
// canonical; singular (command/skill/plugin/agent) is legacy. Resolve an
// existing file across both, preferring plural, so reads/writes work
// regardless of which naming convention was used.
function resolveExisting(type: RegistryType, root: string, name: string): string | null {
  const clean = sanitize(name)
  const plural = path.join(root, `${type === 'tool' ? 'plugins' : `${type}s`}`, clean)
  const singular = path.join(root, type, clean)
  switch (type) {
    case 'command':
    case 'tool':
    case 'agent': {
      const pluralFile = plural + (type === 'tool' ? '.ts' : '.md')
      const singularFile = singular + (type === 'tool' ? '.ts' : '.md')
      return [pluralFile, singularFile].find((p) => {
        try {
          statSync(p)
          return true
        } catch {
          return false
        }
      }) ?? null
    }
    case 'skill': {
      const pluralFile = path.join(plural, 'SKILL.md')
      const singularFile = path.join(singular, 'SKILL.md')
      return [pluralFile, singularFile].find((p) => {
        try {
          statSync(p)
          return true
        } catch {
          return false
        }
      }) ?? null
    }
  }
}

function resolveTarget(type: RegistryType, scope: RegistryScope, name: string, directory?: string): string {
  const root = scopeRoot(scope, directory)
  const clean = sanitize(name)
  const existing = resolveExisting(type, root, name)
  if (existing) return existing

  // Fall back to the canonical plural directory for new writes.
  switch (type) {
    case 'command':
      return path.join(root, 'commands', `${clean}.md`)
    case 'skill':
      return path.join(root, 'skills', clean, 'SKILL.md')
    case 'tool':
      return path.join(root, 'plugins', `${clean}.ts`)
    case 'agent':
      return path.join(root, 'agents', `${clean}.md`)
  }
}

function buildContent(type: RegistryType, data: { name: string; description: string; content: string; mode?: string; agent?: string; model?: string; subtask?: boolean; topP?: number }): string {
  switch (type) {
    case 'command': {
      const fields: string[] = []
      if (data.description) fields.push(`description: ${data.description}`)
      if (data.agent) fields.push(`agent: ${data.agent}`)
      if (data.model) fields.push(`model: ${data.model}`)
      if (data.topP != null) fields.push(`topP: ${data.topP}`)
      if (data.subtask != null) fields.push(`subtask: ${data.subtask}`)
      if (fields.length === 0) return data.content.trim()
      return [
        '---',
        ...fields,
        '---',
        '',
        data.content.trim(),
      ].join('\n')
    }
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
  agent: z.string().optional(),
  model: z.string().optional(),
  subtask: z.boolean().optional(),
  topP: z.number().optional(),
})

const UpdateRegistrySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().default(''),
  content: z.string().min(1).max(100000),
  mode: z.enum(['all', 'subagent', 'primary']).default('all'),
  agent: z.string().optional(),
  model: z.string().optional(),
  subtask: z.boolean().optional(),
  topP: z.number().optional(),
})

function parseFrontmatter(content: string): { description: string; mode?: string; agent?: string; model?: string; subtask?: boolean; topP?: number; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { description: '', body: content }
  const front = match[1] ?? ''
  const description = front.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? ''
  const mode = front.match(/^mode:\s*(.+)$/m)?.[1]?.trim()
  const agent = front.match(/^agent:\s*(.+)$/m)?.[1]?.trim()
  const model = front.match(/^model:\s*(.+)$/m)?.[1]?.trim()
  const topP = front.match(/^topP:\s*(.+)$/m)?.[1]?.trim()
  const subtask = front.match(/^subtask:\s*(.+)$/m)?.[1]?.trim()
  return {
    description,
    mode,
    agent,
    model,
    topP: topP != null && !Number.isNaN(Number(topP)) ? Number(topP) : undefined,
    subtask: subtask == null ? undefined : subtask === 'true',
    body: content.slice(match[0].length).trim(),
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function readIfFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

async function collectType(
  root: string,
  type: RegistryType,
  scope: RegistryScope,
  items: RegistryListItem[],
): Promise<void> {
  const pluralDir = type === 'tool' ? 'plugins' : `${type}s`
  const singularDir = type === 'agent' ? 'agent' : type

  switch (type) {
    case 'command':
    case 'tool': {
      const ext = type === 'tool' ? '.ts' : '.md'
      const seen = new Set<string>()
      for (const dir of [path.join(root, pluralDir), path.join(root, singularDir)]) {
        for (const file of await listDir(dir)) {
          if (!file.endsWith(ext)) continue
          const name = file.replace(ext, '')
          if (seen.has(name)) continue
          seen.add(name)
          const full = path.join(dir, file)
          const raw = await readIfFile(full)
          if (raw === null) continue
          const parsed = type === 'command' ? parseFrontmatter(raw) : { description: '', body: raw }
          items.push({
            type,
            scope,
            name,
            description: parsed.description,
            content: parsed.body,
            ...(type === 'command' ? {
              agent: parsed.agent,
              model: parsed.model,
              subtask: parsed.subtask,
              topP: parsed.topP,
            } : {}),
            path: full,
          })
        }
      }
      break
    }
    case 'skill': {
      const seen = new Set<string>()
      for (const dir of [path.join(root, pluralDir), path.join(root, singularDir)]) {
        for (const entry of await listDir(dir)) {
          if (seen.has(entry)) continue
          const skillFile = path.join(dir, entry, 'SKILL.md')
          const raw = await readIfFile(skillFile)
          if (raw === null) continue
          seen.add(entry)
          const parsed = parseFrontmatter(raw)
          items.push({ type, scope, name: entry, description: parsed.description, content: parsed.body, path: skillFile })
        }
      }
      break
    }
    case 'agent': {
      const seen = new Set<string>()
      for (const dir of [path.join(root, pluralDir), path.join(root, singularDir)]) {
        for (const file of await listDir(dir)) {
          if (!file.endsWith('.md')) continue
          const name = file.replace(/\.md$/, '')
          if (seen.has(name)) continue
          seen.add(name)
          const full = path.join(dir, file)
          const raw = await readIfFile(full)
          if (raw === null) continue
          const parsed = parseFrontmatter(raw)
          items.push({ type, scope, name, description: parsed.description, content: parsed.body, mode: parsed.mode, path: full })
        }
      }
      break
    }
  }
}

export function createRegistryRoutes() {
  const app = new Hono()

  app.get('/', async (c) => {
    try {
      const directory = c.req.query('directory') || undefined
      const items: RegistryListItem[] = []

      const globalRoot = getConfigPath()
      for (const type of ['command', 'skill', 'tool', 'agent'] as RegistryType[]) {
        await collectType(globalRoot, type, 'global', items)
      }

      if (directory) {
        const projectRoot = path.join(directory, '.opencode')
        for (const type of ['command', 'skill', 'tool', 'agent'] as RegistryType[]) {
          await collectType(projectRoot, type, 'project', items)
        }
      }

      return c.json({ items })
    } catch (error) {
      logger.error('Failed to list registry items:', error)
      return c.json({ error: 'Failed to list registry items' }, 500)
    }
  })

  app.get('/:type', async (c) => {
    try {
      const directory = c.req.query('directory') || undefined
      const type = c.req.param('type') as RegistryType

      if (!['command', 'skill', 'tool', 'agent'].includes(type)) {
        return c.json({ error: 'Invalid type' }, 400)
      }

      const items: RegistryListItem[] = []
      await collectType(getConfigPath(), type, 'global', items)
      if (directory) {
        await collectType(path.join(directory, '.opencode'), type, 'project', items)
      }
      return c.json(items)
    } catch (error) {
      logger.error('Failed to list opencode files:', error)
      return c.json({ error: 'Failed to list files' }, 500)
    }
  })

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

  app.put('/:type/:scope/:name', async (c) => {
    try {
      const directory = c.req.query('directory') || undefined
      const type = c.req.param('type') as RegistryType
      const scope = c.req.param('scope') as RegistryScope
      const currentName = c.req.param('name')

      if (!['command', 'skill', 'tool', 'agent'].includes(type)) return c.json({ error: 'Invalid type' }, 400)
      if (!['global', 'project'].includes(scope)) return c.json({ error: 'Invalid scope' }, 400)

      const body = await c.req.json()
      const validated = UpdateRegistrySchema.parse(body)

      const nameError = validateName(validated.name)
      if (nameError) return c.json({ error: nameError }, 400)

      const currentTarget = resolveTarget(type, scope, currentName, directory)
      const newName = sanitize(validated.name)
      const target = newName === sanitize(currentName)
        ? currentTarget
        : resolveTarget(type, scope, newName, directory)

      const content = buildContent(type, { ...validated, name: newName })

      if (newName !== sanitize(currentName)) {
        try {
          if (type === 'skill') {
            await rm(path.dirname(currentTarget), { recursive: true, force: true })
          } else {
            await unlink(currentTarget)
          }
        } catch (err) {
          logger.warn(`Old registry target missing, skipping removal: ${err}`)
        }
      }

      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content, 'utf-8')

      logger.info(`Updated ${type} ${currentName} -> ${newName} (${scope}) -> ${target}`)
      return c.json({ success: true, type, scope, name: newName, path: target })
    } catch (error) {
      logger.error('Failed to update opencode file:', error)
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid data', details: error.issues }, 400)
      }
      return c.json({ error: 'Failed to update file', message: (error as Error).message }, 400)
    }
  })

  app.post('/reload', async (c) => {
    try {
      const directory = c.req.query('directory') || undefined
      const targets = directory ? [directory] : [getWorkspacePath()]
      const reloaded = await opencodeServerManager.reloadDirectories(targets)
      return c.json({ success: true, reloaded })
    } catch (error) {
      logger.error('Failed to reload opencode instances:', error)
      return c.json({ error: 'Failed to reload opencode instances' }, 500)
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
      if (type === 'skill') {
        try {
          await rm(path.dirname(target), { recursive: true, force: true })
        } catch (error) {
          const code = (error as { code?: string })?.code
          if (code === 'ENOENT') {
            return c.json({ error: `Cannot delete "${name}": not a user file (built-in commands/skills can't be deleted)` }, 404)
          }
          throw error
        }
      } else {
        try {
          await unlink(target)
        } catch (error) {
          const code = (error as { code?: string })?.code
          if (code === 'ENOENT') {
            return c.json({ error: `Cannot delete "${name}": not a user file (built-in commands/skills can't be deleted)` }, 404)
          }
          throw error
        }
      }
      logger.info(`Deleted ${type} ${name} (${scope})`)
      return c.json({ success: true })
    } catch (error) {
      logger.error('Failed to delete opencode file:', error)
      return c.json({ error: 'Failed to delete file' }, 400)
    }
  })

  return app
}