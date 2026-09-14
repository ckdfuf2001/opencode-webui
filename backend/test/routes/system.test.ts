import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { createSystemRoutes } from '../../src/routes/system'

vi.mock('@opencode-webui/shared', async () => {
  const actual = await vi.importActual<typeof import('@opencode-webui/shared')>('@opencode-webui/shared')
  return { ...actual, getWorkspacePath: () => '/tmp/ws', getReposPath: () => '/tmp/repos', getConfigPath: () => '/tmp/cfg', ENV: { SERVER: { PORT: 3001, HOST: '0.0.0.0', NODE_ENV: 'test' }, OPENCODE: { PORT: 4096, HOST: '127.0.0.1' }, TIMEOUTS: {} } as any }
})

vi.mock('../../src/services/opencode-single-server', () => ({
  opencodeServerManager: {
    getPort: () => 4096,
    checkHealth: vi.fn(async () => true),
  },
}))

describe('System Routes', () => {
  it('should return system info with version, ports, paths', async () => {
    const fakeDb: any = {}
    const app = new Hono()
    app.route('/api/system', createSystemRoutes(fakeDb))
    const res = await app.request('/api/system/info')
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body).toHaveProperty('version')
    expect(body).toHaveProperty('backend')
    expect(body.backend).toHaveProperty('port')
    expect(body.backend).toHaveProperty('workspacePath')
    expect(body).toHaveProperty('opencode')
    expect(body.opencode).toHaveProperty('port', 4096)
    expect(body.opencode).toHaveProperty('healthy', true)
    expect(body).toHaveProperty('timestamp')
  })

  it('should redirect /api/system to info', async () => {
    const fakeDb: any = {}
    const app = new Hono()
    app.route('/api/system', createSystemRoutes(fakeDb))
    const res = await app.request('/api/system')
    expect([302, 200].includes(res.status)).toBe(true)
  })
})
