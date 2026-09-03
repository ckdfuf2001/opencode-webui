import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, readFile, stat } from 'fs/promises'
import os from 'os'
import path from 'path'
import { Hono } from 'hono'
import { createRegistryRoutes } from '../../src/routes/registry'

let tempDir = ''

vi.mock('@opencode-webui/shared', async () => {
  const actual = await vi.importActual<typeof import('@opencode-webui/shared')>('@opencode-webui/shared')
  return { ...actual, getConfigPath: () => tempDir }
})

function createApp(): Hono {
  const app = new Hono()
  app.route('/api/registry', createRegistryRoutes())
  return app
}

async function register(app: Hono, payload: Record<string, unknown>, directory?: string) {
  const url = directory ? `/api/registry?directory=${encodeURIComponent(directory)}` : '/api/registry'
  return app.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>
}

type Item = { items?: Array<Record<string, unknown>> }

async function jsonItems(res: Response): Promise<Record<string, unknown>[]> {
  const body = await json(res)
  return (body as Item).items ?? []
}

describe('Registry Routes', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'registry-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('should register and list a global command file', async () => {
    const app = createApp()
    const res = await register(app, { type: 'command', scope: 'global', name: 'mycmd', description: 'A command', content: 'Do the thing.' })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.success).toBe(true)
    expect(body.path).toContain('mycmd.md')

    const listRes = await app.request('/api/registry')
    const items = await jsonItems(listRes)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'command', scope: 'global', name: 'mycmd', content: 'Do the thing.' })
  })

  it('should register a skill with frontmatter and parse description on list', async () => {
    const app = createApp()
    const res = await register(app, { type: 'skill', scope: 'global', name: 'myskill', description: 'A skill', content: 'Instructions here' })
    expect(res.status).toBe(200)

    const target = path.join(tempDir, 'skills', 'myskill', 'SKILL.md')
    const raw = await readFile(target, 'utf-8')
    expect(raw).toContain('name: myskill')
    expect(raw).toContain('description: A skill')

    const listRes = await app.request('/api/registry')
    const items = await jsonItems(listRes)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'skill', scope: 'global', name: 'myskill', description: 'A skill', content: 'Instructions here' })
  })

  it('should register and list project scope items with directory', async () => {
    const projectDir = path.join(tempDir, '..', 'project')
    await mkdir(projectDir, { recursive: true })
    const app = createApp()

    const res = await register(app, { type: 'agent', scope: 'project', name: 'coder', description: 'Coding agent', content: 'You are a coder', mode: 'subagent' }, projectDir)
    expect(res.status).toBe(200)
    const resBody = await json(res)
    expect(resBody.path).toBeDefined()

    const listRes = await app.request(`/api/registry?directory=${encodeURIComponent(projectDir)}`)
    const items = await jsonItems(listRes)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'agent', scope: 'project', name: 'coder', mode: 'subagent' })
  })

  it('should update a registered file and support rename', async () => {
    const app = createApp()
    await register(app, { type: 'agent', scope: 'global', name: 'old-agent', description: 'Old', content: 'prompt', mode: 'subagent' })

    const updateRes = await app.request('/api/registry/agent/global/old-agent', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed-agent', description: 'New desc', content: 'new prompt', mode: 'primary' }),
    })
    expect(updateRes.status).toBe(200)
    const updateBody = await json(updateRes)
    expect(updateBody.name).toBe('renamed-agent')

    const listRes = await app.request('/api/registry')
    const items = await jsonItems(listRes)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ name: 'renamed-agent', description: 'New desc', content: 'new prompt', mode: 'primary' })
  })

  it('should delete a registered file and remove skill directory', async () => {
    const app = createApp()
    await register(app, { type: 'skill', scope: 'global', name: 'tmp-skill', description: '', content: 'body' })

    const skillDir = path.join(tempDir, 'skills', 'tmp-skill')
    await expect(stat(skillDir)).resolves.toBeDefined()

    const delRes = await app.request('/api/registry/skill/global/tmp-skill', { method: 'DELETE' })
    expect(delRes.status).toBe(200)

    await expect(stat(skillDir)).rejects.toThrow()
  })

  it('should reject invalid names', async () => {
    const app = createApp()
    const res = await register(app, { type: 'command', scope: 'global', name: 'has space', description: '', content: 'x' })
    expect(res.status).toBe(400)
  })
})


