import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { createExposeRoutes, createPublicExposeRoutes } from '../../src/routes/expose'

// Mock shared and opencode manager
vi.mock('@opencode-webui/shared', async () => {
  const actual = await vi.importActual<typeof import('@opencode-webui/shared')>('@opencode-webui/shared')
  return { ...actual, getReposPath: () => '/tmp/repos', getConfigPath: () => '/tmp/config', getWorkspacePath: () => '/tmp/workspace' }
})

vi.mock('../../src/services/opencode-single-server', () => ({
  opencodeServerManager: {
    getUrl: () => 'http://localhost:9999',
    getPort: () => 9999,
    ensureRunning: vi.fn(async () => {}),
    checkHealth: vi.fn(async () => true),
  },
}))

vi.mock('../../src/services/opencode-auth', () => ({
  ensureServerAuth: (h: Record<string,string>) => h,
}))

function createMockDb() {
  let rows: any[] = []
  let autoId = 1
  const db: any = {
    prepare: (sql: string) => {
      const s = sql.trim()
      if (s.startsWith('SELECT * FROM exposed_commands WHERE expose_name = ? AND enabled = 1')) {
        return { get: (name: string) => rows.find(r => r.expose_name === name && r.enabled === 1) }
      }
      if (s.startsWith('SELECT * FROM exposed_commands WHERE expose_name = ?')) {
        return { get: (name: string) => rows.find(r => r.expose_name === name) }
      }
      if (s.startsWith('SELECT * FROM exposed_commands WHERE id = ?')) {
        return { get: (id: number) => rows.find(r => r.id === id) }
      }
      if (s.startsWith('SELECT * FROM exposed_commands WHERE enabled = 1')) {
        return { all: () => rows.filter(r => r.enabled === 1) }
      }
      if (s.startsWith('SELECT * FROM exposed_commands')) {
        return { all: () => [...rows], get: (id: number) => rows.find(r => r.id === id) }
      }
      if (s.startsWith('SELECT 1 FROM exposed_commands WHERE expose_name = ? AND id != ?')) {
        return { get: (name: string, id: number) => rows.find(r => r.expose_name === name && r.id !== id) ? {1:1} : undefined }
      }
      if (s.startsWith('SELECT 1 FROM exposed_commands WHERE expose_name = ?')) {
        return { get: (name: string) => rows.find(r => r.expose_name === name) ? {1:1} : undefined }
      }
      if (s.startsWith('INSERT INTO exposed_commands')) {
        return {
          run: (...args: any[]) => {
            const [command_name, expose_name, description, enabled, session_mode, title_template, pinned_session_id, args_template, example_args] = args
            // handle both old 6-col and new 9-col inserts
            let row: any
            if (args.length === 6) {
              const [cn, en, desc, enb, created_at, updated_at] = args
              row = { id: autoId++, command_name: cn, expose_name: en, description: desc, enabled: enb, session_mode: 'new', title_template: '', pinned_session_id: null, args_template: '', example_args: '', created_at, updated_at }
            } else {
              const created_at = args[args.length-2], updated_at = args[args.length-1]
              row = { id: autoId++, command_name, expose_name, description, enabled, session_mode: session_mode ?? 'new', title_template: title_template ?? '', pinned_session_id: pinned_session_id ?? null, args_template: args_template ?? '', example_args: example_args ?? '', created_at, updated_at }
            }
            rows.push(row)
            return { lastInsertRowid: row.id }
          }
        }
      }
      if (s.startsWith('UPDATE exposed_commands SET')) {
        return {
          run: (...args: any[]) => {
            const id = args[args.length-1]
            const row = rows.find(r => r.id === id)
            if (!row) return { changes: 0 }
            // generic update: map args to columns based on sql
            // we handle the 8-col update for simplicity
            if (s.includes('args_template')) {
              const [expose_name, description, enabled, session_mode, title_template, pinned_session_id, args_template, example_args, updated_at] = args
              row.expose_name = expose_name; row.description = description; row.enabled = enabled; row.session_mode = session_mode; row.title_template = title_template; row.pinned_session_id = pinned_session_id; row.args_template = args_template; row.example_args = example_args; row.updated_at = updated_at
            } else if (s.includes('session_mode')) {
              const [expose_name, description, enabled, session_mode, title_template, pinned_session_id, updated_at] = args
              row.expose_name = expose_name; row.description = description; row.enabled = enabled; row.session_mode = session_mode; row.title_template = title_template; row.pinned_session_id = pinned_session_id; row.updated_at = updated_at
            } else {
              const [expose_name, description, enabled, updated_at] = args
              row.expose_name = expose_name; row.description = description; row.enabled = enabled; row.updated_at = updated_at
            }
            return { changes: 1 }
          }
        }
      }
      if (s.startsWith('DELETE FROM exposed_commands')) {
        return { run: (id: number) => { const idx = rows.findIndex(r => r.id === id); if (idx>=0) rows.splice(idx,1); return { changes: 1 } } }
      }
      if (s.startsWith('SELECT * FROM repos')) {
        return { all: () => [] }
      }
      if (s.startsWith('SELECT session_id, repo_id')) {
        return { all: () => [] }
      }
      // fallback
      return { get: () => undefined, all: () => [], run: () => ({ changes: 0, lastInsertRowid: 0 }) }
    },
    // expose rows for test inspection
    __rows: rows,
    __reset: () => { rows.length = 0; autoId = 1 }
  }
  return db
}

describe('Expose Routes', () => {
  let db: any
  let app: Hono
  let publicApp: Hono

  beforeEach(() => {
    db = createMockDb()
    app = new Hono()
    app.route('/api/expose', createExposeRoutes(db))
    publicApp = new Hono()
    publicApp.route('/api/public', createPublicExposeRoutes(db))
  })

  it('should create and list exposed command', async () => {
    const res = await app.request('/api/expose/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandName: 'my-cmd', exposeName: 'my-expose', description: 'desc' }),
    })
    expect(res.status).toBe(201)
    const body: any = await res.json()
    expect(body.commandName).toBe('my-cmd')
    expect(body.exposeName).toBe('my-expose')

    const list = await app.request('/api/expose/commands')
    expect(list.status).toBe(200)
    const items: any[] = await list.json()
    expect(items).toHaveLength(1)
  })

  it('should create with argsTemplate and sessionMode', async () => {
    const res = await app.request('/api/expose/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandName: 'cmd2', exposeName: 'exp2', description: 'd', sessionMode: 'reuse', titleTemplate: '[EXPOSE] {exposeName}', argsTemplate: '--flag {args}', exampleArgs: 'hello' }),
    })
    expect(res.status).toBe(201)
    const body: any = await res.json()
    expect(body.sessionMode).toBe('reuse')
    expect(body.titleTemplate).toBe('[EXPOSE] {exposeName}')
    expect(body.argsTemplate).toBe('--flag {args}')
    expect(body.exampleArgs).toBe('hello')
  })

  it('should update exposed command and keep draft when enabled false', async () => {
    const created = await app.request('/api/expose/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandName: 'c', exposeName: 'e', description: 'orig' }),
    })
    const { id } = await created.json() as any
    const upd = await app.request(`/api/expose/commands/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'updated', enabled: false, sessionMode: 'reuse', titleTemplate: 'T', argsTemplate: '{args}!', exampleArgs: 'ex' }),
    })
    expect(upd.status).toBe(200)
    const body: any = await upd.json()
    expect(body.description).toBe('updated')
    expect(body.enabled).toBe(false)
    expect(body.sessionMode).toBe('reuse')
    expect(body.argsTemplate).toBe('{args}!')
  })

  it('should expose via public discovery only when enabled', async () => {
    await app.request('/api/expose/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandName: 'pub', exposeName: 'pub', description: 'd', enabled: true }),
    })
    await app.request('/api/expose/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandName: 'draft', exposeName: 'draft', description: 'd', enabled: false }),
    })
    const pub = await publicApp.request('/api/public/commands')
    expect(pub.status).toBe(200)
    const data: any = await pub.json()
    expect(data.commands.some((c: any) => c.name === 'pub')).toBe(true)
    expect(data.commands.some((c: any) => c.name === 'draft')).toBe(false)
    expect(data.count).toBe(1)
  })

  it('should list available-commands with repo ownership', async () => {
    const res = await app.request('/api/expose/available-commands')
    expect(res.status).toBe(200)
    const data: any = await res.json()
    expect(Array.isArray(data.items)).toBe(true)
  })
})
