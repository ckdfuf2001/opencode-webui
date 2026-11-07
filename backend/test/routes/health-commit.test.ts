import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { createHealthRoutes } from '../../src/routes/health'

vi.mock('../../src/services/opencode-single-server', () => ({
  opencodeServerManager: {
    getPort: () => 4096,
    checkHealth: vi.fn(async () => true),
  },
}))

describe('P1 /api/health build commit', () => {
  it('health 응답에 빌드 커밋 SHA가 있다', async () => {
    const fakeDb = { prepare: () => ({ get: () => 1 }) } as never
    const app = new Hono()
    app.route('/api/health', createHealthRoutes(fakeDb as never))
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { commit?: unknown }
    expect(typeof body.commit).toBe('string')
    expect((body.commit as string).length).toBeGreaterThan(0)
  })
})
