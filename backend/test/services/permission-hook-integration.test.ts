import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'

vi.mock('../../src/services/opencode-single-server', () => ({
  opencodeServerManager: { getUrl: () => (globalThis as Record<string, string>).__hookStubUrl },
}))

import { subscribeOpencodeEvents } from '../../src/services/permission-auto-approver'

function mockDb() {
  const ruleRows = [
    { id: 1, repo_id: 7, permission: 'bash', pattern: 'echo hooktest*', created_at: 0 },
    { id: 2, repo_id: 8, permission: 'bash', pattern: 'echo hooktest*', created_at: 0 },
  ]
  const repoRows = [
    {
      id: 7, repo_url: null, local_path: 'test', branch: null, default_branch: 'main',
      clone_status: 'ready', cloned_at: 0, last_pulled: null, opencode_config_name: null,
      is_worktree: 0, is_local: 1, skill_auto_update: 0,
    },
  ]
  return {
    prepare: vi.fn((sql: string) => {
      if (sql.includes('permission_rules')) {
        return { all: () => ruleRows, get: () => undefined, run: () => ({}) }
      }
      return { all: () => repoRows, get: () => undefined, run: () => ({}) }
    }),
  } as any
}

interface CapturedReply {
  url: string
  body: unknown
}

describe('permission hook integration (stub opencode server)', () => {
  let server: Server
  let baseUrl = ''
  let replies: CapturedReply[] = []
  let sseClients: ServerResponse[] = []

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let s = ''
      req.on('data', (d) => { s += d })
      req.on('end', () => resolve(s))
    })

  beforeEach(async () => {
    replies = []
    sseClients = []
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (req.method === 'GET' && url.pathname === '/event') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: {"type":"server.connected","properties":{}}\n\n')
        sseClients.push(res)
        return
      }
      if (req.method === 'GET' && url.pathname.startsWith('/session/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: 'ses-1', directory: '/repo/test' }))
        return
      }
      if (req.method === 'POST' && url.pathname.endsWith('/reply')) {
        const body = await readBody(req)
        replies.push({ url: url.pathname, body: JSON.parse(body) })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
        return
      }
      if (req.method === 'POST' && url.pathname.includes('/permissions/')) {
        const body = await readBody(req)
        replies.push({ url: url.pathname, body: JSON.parse(body) })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    ;(globalThis as Record<string, string>).__hookStubUrl = baseUrl
  })

  afterEach(async () => {
    for (const c of sseClients) {
      try { c.end() } catch {}
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    delete (globalThis as Record<string, unknown>).__hookStubUrl
    vi.unstubAllGlobals()
  })

  const emitAsked = (props: Record<string, unknown>, type = 'permission.asked') => {
    const frame = `data: ${JSON.stringify({ type, properties: props })}\n\n`
    for (const c of sseClients) c.write(frame)
  }

  const waitForReplies = async (n: number, ms = 8000): Promise<void> => {
    const start = Date.now()
    while (replies.length < n && Date.now() - start < ms) {
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  it('replies always to a matching repo rule via v1 endpoint', async () => {
    const sub = subscribeOpencodeEvents(mockDb())
    try {
      await new Promise((r) => setTimeout(r, 300))
      emitAsked({ id: 'per-1', sessionID: 'ses-1', permission: 'bash', metadata: { command: 'echo hooktest now' } })
      await waitForReplies(1)
      expect(replies).toHaveLength(1)
      expect(replies[0]!.url).toBe('/session/ses-1/permissions/per-1')
      expect(replies[0]!.body).toEqual({ response: 'always' })
    } finally {
      sub.stop()
    }
  })

  it('ignores non-matching permissions (decoy repo rule does not leak)', async () => {
    const sub = subscribeOpencodeEvents(mockDb())
    try {
      await new Promise((r) => setTimeout(r, 300))
      emitAsked({ id: 'per-2', sessionID: 'ses-1', permission: 'bash', metadata: { command: 'rm -rf /tmp/x' } })
      await new Promise((r) => setTimeout(r, 800))
      expect(replies).toHaveLength(0)
    } finally {
      sub.stop()
    }
  })

  it('uses v2 endpoint for v2.asked events', async () => {
    const sub = subscribeOpencodeEvents(mockDb())
    try {
      await new Promise((r) => setTimeout(r, 300))
      emitAsked(
        { id: 'per-3', sessionID: 'ses-1', permission: 'bash', metadata: { command: 'echo hooktest v2' } },
        'permission.v2.asked',
      )
      await waitForReplies(1)
      expect(replies).toHaveLength(1)
      expect(replies[0]!.url).toBe('/permission/per-3/reply')
      expect(replies[0]!.body).toEqual({ reply: 'always' })
    } finally {
      sub.stop()
    }
  })
})
