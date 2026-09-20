import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { getReposPath } from '@opencode-webui/shared'

import { subscribeOpencodeEvents } from '../../src/services/permission-auto-approver'

function mockDb() {
  // ?�제 listPermissionRules(db, repoId)??repo_id = ? �??�터?�다 ??목도 ?�일?�게 ?�작
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
  interface MockStatement {
    all: (...args: unknown[]) => unknown[]
    get: (...args: unknown[]) => unknown
    run: (...args: unknown[]) => Record<string, unknown>
  }
  const stmt = (all: (...args: unknown[]) => unknown[]): MockStatement => ({
    all,
    get: () => undefined,
    run: () => ({}),
  })
  return {
    prepare: vi.fn((sql: string): MockStatement => {
      if (sql.includes('permission_rules')) {
        return stmt((repoId?: unknown) =>
          repoId == null ? ruleRows : ruleRows.filter((r) => r.repo_id === repoId),
        )
      }
      return stmt(() => repoRows)
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
  let sessionFetchCount = 0

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let s = ''
      req.on('data', (d) => { s += d })
      req.on('end', () => resolve(s))
    })

  beforeEach(async () => {
    replies = []
    sseClients = []
    sessionFetchCount = 0
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (req.method === 'GET' && url.pathname === '/event') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: {"type":"server.connected","properties":{}}\n\n')
        sseClients.push(res)
        return
      }
      if (req.method === 'GET' && url.pathname.startsWith('/session/')) {
        sessionFetchCount += 1
        const sid = decodeURIComponent(url.pathname.slice('/session/'.length))
        if (sid === 'ses-unknown') {
          res.writeHead(404)
          res.end()
          return
        }
        if (sid === 'ses-norepo') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ id: sid, directory: '/elsewhere/none' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: sid, directory: '/repo/test' }))
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
  })

  afterEach(async () => {
    for (const c of sseClients) {
      try { c.end() } catch {}
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const subscribe = (db: ReturnType<typeof mockDb>, onEvent?: (t: string) => void) =>
    subscribeOpencodeEvents(db, { onEvent, getBaseUrl: () => baseUrl })

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
    const sub = subscribe(mockDb())
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
    const sub = subscribe(mockDb())
    try {
      await new Promise((r) => setTimeout(r, 300))
      emitAsked({ id: 'per-2', sessionID: 'ses-1', permission: 'bash', metadata: { command: 'rm -rf /tmp/x' } })
      await new Promise((r) => setTimeout(r, 800))
      expect(replies).toHaveLength(0)
    } finally {
      sub.stop()
    }
  })

  it('does not fall back to other repos rules when session has no repo', async () => {
    const sub = subscribe(mockDb())
    try {
      await new Promise((r) => setTimeout(r, 300))
      emitAsked({ id: 'per-norepo', sessionID: 'ses-norepo', permission: 'bash', metadata: { command: 'echo hooktest now' } })
      await new Promise((r) => setTimeout(r, 800))
      expect(replies).toHaveLength(0)
    } finally {
      sub.stop()
    }
  })

  it('skips when session directory cannot be resolved', async () => {
    const sub = subscribe(mockDb())
    try {
      await new Promise((r) => setTimeout(r, 300))
      emitAsked({ id: 'per-unknown', sessionID: 'ses-unknown', permission: 'bash', metadata: { command: 'echo hooktest now' } })
      await new Promise((r) => setTimeout(r, 800))
      expect(replies).toHaveLength(0)
    } finally {
      sub.stop()
    }
  })

  it('fetches session directory only once per session (cache)', async () => {
    const seen: string[] = []
    const sub = subscribe(mockDb(), (t) => { seen.push(t) })
    try {
      await new Promise((r) => setTimeout(r, 300))
      const before = sessionFetchCount
      emitAsked({ id: 'per-c1', sessionID: 'ses-cache', permission: 'bash', metadata: { command: 'echo hooktest one' } })
      emitAsked({ id: 'per-c2', sessionID: 'ses-cache', permission: 'bash', metadata: { command: 'echo hooktest two' } })
      await waitForReplies(2, 12000)
      expect(seen.filter((t) => t === 'permission.asked')).toHaveLength(2)
      expect(replies).toHaveLength(2)
      expect(sessionFetchCount - before).toBe(1)
    } finally {
      sub.stop()
    }
  }, 15000)

  it('uses v2 endpoint for v2.asked events', async () => {
    const sub = subscribe(mockDb())
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

  // S2 가드레일: 전역 `**` 룰이 매칭돼도 세션 레포 밖 쓰기는 거부한다.
  const mockDbVeto = () => {
    const repoRow = {
      id: 7, repo_url: null, local_path: 'test', branch: null, default_branch: 'main',
      clone_status: 'ready', cloned_at: 0, last_pulled: null, opencode_config_name: null,
      is_worktree: 0, is_local: 1, skill_auto_update: 0,
    }
    return {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('permission_rules')) {
          return {
            all: () => [{ id: 9, repo_id: 7, permission: 'edit', pattern: '**', created_at: 0 }],
            get: () => undefined,
            run: () => ({}),
          }
        }
        if (sql.includes('FROM repos WHERE id')) {
          return { all: () => [], get: () => repoRow, run: () => ({}) }
        }
        return { all: () => [repoRow], get: () => undefined, run: () => ({}) }
      }),
    } as any
  }

  it('vetoes writes outside the session repo even when a global rule matches', async () => {
    const sub = subscribe(mockDbVeto())
    try {
      await new Promise((r) => setTimeout(r, 300))
      emitAsked({ id: 'per-veto', sessionID: 'ses-1', permission: 'edit', patterns: ['/other/scope/file.txt'] })
      await new Promise((r) => setTimeout(r, 800))
      expect(replies).toHaveLength(0)
    } finally {
      sub.stop()
    }
  })

  it('approves writes inside the session repo (absolute + fail-open relative)', async () => {
    const sub = subscribe(mockDbVeto())
    try {
      await new Promise((r) => setTimeout(r, 300))
      const inside = `${path.join(getReposPath(), 'test')}/sub/a.txt`.replace(/\\/g, '/')
      emitAsked({ id: 'per-allow-abs', sessionID: 'ses-1', permission: 'edit', patterns: [inside] })
      await waitForReplies(1)
      expect(replies).toHaveLength(1)
      expect(replies[0]!.body).toEqual({ response: 'always' })
    } finally {
      sub.stop()
    }
  })
})
