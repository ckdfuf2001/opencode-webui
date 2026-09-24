import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { subscribeOpencodeEvents, kickPermissionSweep } from '../../src/services/permission-auto-approver'

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
      if (req.method === 'GET' && url.pathname === '/permission') {
        // opencode v1.18+ 스코프: 전역 조회는 비고, ?directory= 에만 해당 ask가 잡힌다.
        // 레거시 전역 sweep에는 빈 목록을 돌려줘 기존 테스트와 간섭하지 않는다.
        // 디렉터리별로 다른 ask ID를 돌려줘 테스트 간 dedupe 간섭을 막는다.
        const dir = url.searchParams.get('directory') ?? ''
        const items =
          dir === '/repo/test'
            ? [{ id: 'per-sweep-1', sessionID: 'ses-1', permission: 'bash', metadata: { command: 'echo hooktest sweep' } }]
            : dir === '/other/test'
              ? [{ id: 'per-sweep-2', sessionID: 'ses-1', permission: 'bash', metadata: { command: 'echo hooktest sweep' } }]
              : []
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(items))
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

  it('replies once to a matching repo rule via v1 endpoint (no suggestions)', async () => {
    const sub = subscribe(mockDb())
    try {
      await new Promise((r) => setTimeout(r, 300))
      emitAsked({ id: 'per-1', sessionID: 'ses-1', permission: 'bash', metadata: { command: 'echo hooktest now' } })
      await waitForReplies(1)
      expect(replies).toHaveLength(1)
      expect(replies[0]!.url).toBe('/session/ses-1/permissions/per-1')
      expect(replies[0]!.body).toEqual({ response: 'once' })
    } finally {
      sub.stop()
    }
  })

  it('replies always when suggestions are within rule coverage', async () => {
    const sub = subscribe(mockDb())
    try {
      await new Promise((r) => setTimeout(r, 300))
      emitAsked({
        id: 'per-1a',
        sessionID: 'ses-1',
        permission: 'bash',
        metadata: { command: 'echo hooktest now' },
        always: ['echo hooktest *'],
      })
      await waitForReplies(1)
      expect(replies).toHaveLength(1)
      expect(replies[0]!.url).toBe('/session/ses-1/permissions/per-1a')
      expect(replies[0]!.body).toEqual({ response: 'always' })
    } finally {
      sub.stop()
    }
  })

  it('replies once when suggestions exceed rule coverage', async () => {
    const sub = subscribe(mockDb())
    try {
      await new Promise((r) => setTimeout(r, 300))
      emitAsked({
        id: 'per-1b',
        sessionID: 'ses-1',
        permission: 'bash',
        metadata: { command: 'echo hooktest now' },
        always: ['rm -rf /*'],
      })
      await waitForReplies(1)
      expect(replies).toHaveLength(1)
      expect(replies[0]!.url).toBe('/session/ses-1/permissions/per-1b')
      expect(replies[0]!.body).toEqual({ response: 'once' })
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

  const waitForReplyId = async (id: string, ms = 15000): Promise<CapturedReply> => {
    const start = Date.now()
    for (;;) {
      const found = replies.find((r) => r.url.endsWith(`/${id}`))
      if (found) return found
      if (Date.now() - start > ms) throw new Error(`no reply for ${id} within ${ms}ms (got ${replies.length})`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  it('per-directory feed approves directory-scoped asks via SSE', async () => {
    const sub = subscribeOpencodeEvents(mockDb(), {
      getBaseUrl: () => baseUrl,
      getDirectories: () => ['/repo/test'],
    })
    try {
      await new Promise((r) => setTimeout(r, 300))
      emitAsked({ id: 'per-dir-1', sessionID: 'ses-1', permission: 'bash', metadata: { command: 'echo hooktest now' } })
      // 피드 자체 sweep(3s)이 per-sweep-1을 먼저 승인할 수 있어 ID 지정 대기한다
      const found = await waitForReplyId('per-dir-1')
      expect(found.url).toBe('/session/ses-1/permissions/per-dir-1')
      expect(found.body).toEqual({ response: 'once' })
    } finally {
      sub.stop()
    }
  }, 20000)

  it('kick sweeps directory-scoped asks (global list is blind)', async () => {
    // sweepRunning이 이전 테스트의 진행 중 sweep으로 잡혀 있을 수 있어 재시도한다
    const t0 = Date.now()
    while (replies.length < 1 && Date.now() - t0 < 15000) {
      kickPermissionSweep(mockDb(), { getBaseUrl: () => baseUrl, getDirectories: () => ['/other/test'] })
      await new Promise((r) => setTimeout(r, 1000))
    }
    const found = await waitForReplyId('per-sweep-2')
    expect(found.url).toBe('/session/ses-1/permissions/per-sweep-2')
    expect(found.body).toEqual({ response: 'once' })
  }, 20000)

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
      expect(replies[0]!.body).toEqual({ reply: 'once' })
    } finally {
      sub.stop()
    }
  })

  it('uses v2 always-reply when v2 suggestions are within coverage', async () => {
    const sub = subscribe(mockDb())
    try {
      await new Promise((r) => setTimeout(r, 300))
      emitAsked(
        {
          id: 'per-3a',
          sessionID: 'ses-1',
          action: 'shell',
          resources: ['echo hooktest v2covered'],
          always: ['echo hooktest *'],
        },
        'permission.v2.asked',
      )
      await waitForReplies(1)
      expect(replies).toHaveLength(1)
      expect(replies[0]!.url).toBe('/permission/per-3a/reply')
      expect(replies[0]!.body).toEqual({ reply: 'always' })
    } finally {
      sub.stop()
    }
  })

  it('uses v2 endpoint for v2-shaped payloads on the v1 event name (sweep path)', async () => {
    const sub = subscribe(mockDb())
    try {
      await new Promise((r) => setTimeout(r, 300))
      emitAsked(
        { id: 'per-4', sessionID: 'ses-1', action: 'shell', resources: ['echo hooktest v2shape'] },
        'permission.asked',
      )
      await waitForReplies(1)
      expect(replies).toHaveLength(1)
      expect(replies[0]!.url).toBe('/permission/per-4/reply')
      expect(replies[0]!.body).toEqual({ reply: 'once' })
    } finally {
      sub.stop()
    }
  })
})
