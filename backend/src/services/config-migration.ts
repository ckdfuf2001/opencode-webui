import type { Database } from 'bun:sqlite'
import path from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { getConfigPath } from '@opencode-webui/shared'
import { SettingsService } from './settings'
import { logger } from '../utils/logger'

interface CommandEntry {
  description?: string
  agent?: string
  model?: string
  topP?: number
  subtask?: boolean
  template?: string
  [key: string]: unknown
}

interface AgentEntry {
  description?: string
  mode?: string
  prompt?: string
  [key: string]: unknown
}

function buildCommandContent(name: string, entry: CommandEntry): string {
  const fields: string[] = []
  if (entry.description) fields.push(`description: ${entry.description}`)
  if (entry.agent) fields.push(`agent: ${entry.agent}`)
  if (entry.model) fields.push(`model: ${entry.model}`)
  if (entry.topP != null) fields.push(`topP: ${entry.topP}`)
  if (entry.subtask != null) fields.push(`subtask: ${entry.subtask}`)
  const body = (entry.template ?? '').trim()
  if (fields.length === 0) return body
  return ['---', ...fields, '---', '', body].join('\n')
}

function buildAgentContent(entry: AgentEntry): string {
  return [
    '---',
    `description: ${entry.description || ''}`,
    `mode: ${entry.mode || 'all'}`,
    '---',
    '',
    (entry.prompt ?? '').trim(),
  ].join('\n')
}

const sanitize = (name: string): string => name.trim().replace(/[\\/:*?"<>|]/g, '-')

export interface MigrationFile {
  path: string
  content: string
}

export function planConfigMapMigration(
  content: Record<string, unknown>,
  configDir: string,
  fileExists: (filePath: string) => boolean,
): { files: MigrationFile[]; updatedContent: Record<string, unknown> } {
  const updated = { ...content }
  const files: MigrationFile[] = []

  const commandMap = updated.command as Record<string, unknown> | undefined
  if (commandMap && typeof commandMap === 'object') {
    for (const [name, rawEntry] of Object.entries(commandMap)) {
      const clean = sanitize(name)
      const target = path.join(configDir, 'commands', `${clean}.md`)
      if (fileExists(target)) continue
      files.push({ path: target, content: buildCommandContent(name, rawEntry as CommandEntry) })
      delete commandMap[name]
    }
    if (Object.keys(commandMap).length === 0) delete updated.command
  }

  const agentMap = updated.agent as Record<string, unknown> | undefined
  if (agentMap && typeof agentMap === 'object') {
    for (const [name, rawEntry] of Object.entries(agentMap)) {
      const clean = sanitize(name)
      const target = path.join(configDir, 'agents', `${clean}.md`)
      if (fileExists(target)) continue
      files.push({ path: target, content: buildAgentContent(rawEntry as AgentEntry) })
      delete agentMap[name]
    }
    if (Object.keys(agentMap).length === 0) delete updated.agent
  }

  return { files, updatedContent: updated }
}

export async function migrateConfigMapToFiles(db: Database): Promise<void> {
  const settings = new SettingsService(db)
  const config = settings.getDefaultOpenCodeConfig()
  if (!config) {
    logger.info('Config migration: no default config, skipping')
    return
  }

  const { files, updatedContent } = planConfigMapMigration(
    { ...config.content },
    getConfigPath(),
    existsSync,
  )

  if (files.length === 0) {
    logger.info('Config migration: nothing to migrate')
    return
  }

  for (const file of files) {
    mkdirSync(path.dirname(file.path), { recursive: true })
    writeFileSync(file.path, file.content, 'utf8')
    logger.info(`Config migration: file -> ${file.path}`)
  }

  const updated = settings.updateOpenCodeConfig(config.name, { content: updatedContent })
  if (updated) {
    logger.info('Config migration: config-map commands/agents moved to global files')
  }
}