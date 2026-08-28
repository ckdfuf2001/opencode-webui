import { readFile } from 'fs/promises'
import { createHash } from 'node:crypto'
import path from 'path'
import { executeCommand } from '../utils/process'
import { getConfigPath } from '@opencode-webui/shared'

export async function getRegistrySha(directory?: string | null): Promise<string | null> {
  const target = directory?.trim()
  if (!target) return null
  try {
    const sha = await executeCommand(['git', '-C', target, 'rev-parse', 'HEAD'], { silent: true })
    const trimmed = sha.trim()
    return /^[0-9a-f]{7,40}$/.test(trimmed) ? trimmed : null
  } catch {
    return null
  }
}

function sanitize(name: string): string {
  return name.trim().replace(/[\\:*?"<>|]/g, '-')
}

function candidatePaths(directory: string | undefined, commandName: string): string[] {
  const clean = sanitize(commandName)
  const paths: string[] = []
  if (directory) {
    const root = path.join(directory, '.opencode')
    paths.push(path.join(root, 'commands', `${clean}.md`))
    paths.push(path.join(root, 'command', `${clean}.md`))
    paths.push(path.join(root, 'skills', clean, 'SKILL.md'))
    paths.push(path.join(root, 'skill', clean, 'SKILL.md'))
    paths.push(path.join(root, 'agents', `${clean}.md`))
    paths.push(path.join(root, 'agent', `${clean}.md`))
    paths.push(path.join(root, 'plugins', `${clean}.ts`))
    paths.push(path.join(root, 'plugin', `${clean}.ts`))
  }
  const globalRoot = getConfigPath()
  paths.push(path.join(globalRoot, 'commands', `${clean}.md`))
  paths.push(path.join(globalRoot, 'command', `${clean}.md`))
  paths.push(path.join(globalRoot, 'skills', clean, 'SKILL.md'))
  paths.push(path.join(globalRoot, 'skill', clean, 'SKILL.md'))
  paths.push(path.join(globalRoot, 'agents', `${clean}.md`))
  paths.push(path.join(globalRoot, 'agent', `${clean}.md`))
  paths.push(path.join(globalRoot, 'plugins', `${clean}.ts`))
  paths.push(path.join(globalRoot, 'plugin', `${clean}.ts`))
  return paths
}

export async function getTargetHash(directory: string | undefined, commandName: string): Promise<string | null> {
  if (!commandName) return null
  for (const p of candidatePaths(directory, commandName)) {
    try {
      const raw = await readFile(p, 'utf-8')
      const hash = createHash('sha256').update(raw).digest('hex').slice(0, 12)
      return hash
    } catch {
      continue
    }
  }
  return null
}

export async function captureRunVersions(directory: string | undefined | null, commandName: string): Promise<{ registrySha: string | null; targetHash: string | null }> {
  const [registrySha, targetHash] = await Promise.all([
    getRegistrySha(directory ?? null),
    getTargetHash(directory ?? undefined, commandName),
  ])
  return { registrySha, targetHash }
}
