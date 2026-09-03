import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { createRegistryRoutes } from '../../src/routes/registry'

let tempDir = ''

vi.mock('@opencode-webui/shared', async () => {
  const actual = await vi.importActual<typeof import('@opencode-webui/shared')>('@opencode-webui/shared')
  return { ...actual, getConfigPath: () => tempDir }
})

describe('Command frontmatter round-trip', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'mig-check-'))
  })
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('writes command frontmatter and reads it back', async () => {
    const app = new Hono()
    app.route('/api/registry', createRegistryRoutes())
    const res = await app.request('/api/registry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'command', scope: 'global', name: 'daily', description: '오늘 경제', agent: 'build', model: 'deepseek/deepseek-v4', topP: 0.7, subtask: true, content: '요약해줘' }),
    })
    expect(res.status).toBe(200)

    const file = path.join(tempDir, 'commands', 'daily.md')
    expect(existsSync(file)).toBe(true)
    const raw = readFileSync(file, 'utf8')
    expect(raw).toContain('description: 오늘 경제')
    expect(raw).toContain('agent: build')
    expect(raw).toContain('model: deepseek/deepseek-v4')
    expect(raw).toContain('topP: 0.7')
    expect(raw).toContain('subtask: true')

    const listRes = await app.request('/api/registry')
    const body = await listRes.json() as { items: Array<Record<string, unknown>> }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({
      name: 'daily',
      description: '오늘 경제',
      agent: 'build',
      model: 'deepseek/deepseek-v4',
      topP: 0.7,
      subtask: true,
      content: '요약해줘',
    })
  })

  it('keeps command with only description as frontmatter', async () => {
    const app = new Hono()
    app.route('/api/registry', createRegistryRoutes())
    const res = await app.request('/api/registry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'command', scope: 'global', name: 'plain', description: '간단', content: '그냥 실행' }),
    })
    expect(res.status).toBe(200)
    const file = path.join(tempDir, 'commands', 'plain.md')
    const raw = readFileSync(file, 'utf8')
    expect(raw).toContain('description: 간단')

    const listRes = await app.request('/api/registry')
    const body = await listRes.json() as { items: Array<Record<string, unknown>> }
    expect(body.items[0]).toMatchObject({ description: '간단', content: '그냥 실행' })
    expect(body.items[0]).not.toHaveProperty('agent')
    expect(body.items[0]).not.toHaveProperty('model')
    expect(body.items[0]).not.toHaveProperty('topP')
    expect(body.items[0]).not.toHaveProperty('subtask')
  })
})