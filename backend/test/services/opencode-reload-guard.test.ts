import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  fetchBusySessionIds,
  attemptInstanceReload,
  queuePendingInstanceReload,
  flushPendingInstanceReloads,
  pendingInstanceReloadDirs,
  clearPendingInstanceReloads,
} from '../../src/services/opencode-single-server'

/**
 * truncate-induced kill 재현 방지 테스트.
 * 같은 디렉터리 인스턴스를 공유하므로, busy 세션이 있으면 dispose를
 * 건너뛰고 지연 큐에 넣었다가 idle 때 소진해야 한다.
 */
describe('instance reload guard (stub opencode server)', () => {
  let server: Server
  let baseUrl = ''
  let disposeHits: string[] = []
  // directory -> busy session ids (stub /session/status 응답)
  let busyByDir = new Map<string, string[]>()

  const readBody = (_req: IncomingMessage): Promise<string> => Promise.resolve('')

  beforeEach(async () => {
    disposeHits = []
    busyByDir = new Map()
    clearPendingInstanceReloads()
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (req.method === 'GET' && url.pathname === '/session/status') {
        const dir = url.searchParams.get('directory') ?? ''
        const busy = busyByDir.get(dir) ?? []
        const map: Record<string, { type: string }> = {}
        for (const id of busy) map[id] = { type: 'busy' }
        map['ses-idle-1'] = { type: 'idle' }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(map))
        return
      }
      if (req.method === 'POST' && url.pathname === '/instance/dispose') {
        await readBody(req)
        disposeHits.push(url.searchParams.get('directory') ?? '')
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
    clearPendingInstanceReloads()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('fetchBusySessionIds: busy만 골라낸다', async () => {
    busyByDir.set('/repo/aaa', ['ses-busy-1', 'ses-busy-2'])
    expect(await fetchBusySessionIds(baseUrl, '/repo/aaa')).toEqual(['ses-busy-1', 'ses-busy-2'])
    expect(await fetchBusySessionIds(baseUrl, '/repo/empty')).toEqual([])
  })

  it('fetchBusySessionIds: 실패하면 빈 목록 (fail-open)', async () => {
    expect(await fetchBusySessionIds('http://127.0.0.1:1', '/repo/aaa', {}, 500)).toEqual([])
  })

  it('busy sibling이 있으면 dispose하지 않고 지연 큐에 넣는다 (kill 재현 방지)', async () => {
    busyByDir.set('/repo/aaa', ['ses-streaming'])
    const proceeded = await attemptInstanceReload(baseUrl, '/repo/aaa', {})
    expect(proceeded).toBe(false)
    expect(disposeHits).toEqual([])
    expect(pendingInstanceReloadDirs()).toEqual(['/repo/aaa'])
  })

  it('idle이면 dispose한다', async () => {
    busyByDir.set('/repo/aaa', [])
    const proceeded = await attemptInstanceReload(baseUrl, '/repo/aaa', {})
    expect(proceeded).toBe(true)
    expect(disposeHits).toEqual(['/repo/aaa'])
    expect(pendingInstanceReloadDirs()).toEqual([])
  })

  it('flush는 지연분을 소진하고, 아직 busy면 남긴다', async () => {
    queuePendingInstanceReload('/repo/aaa')
    queuePendingInstanceReload('/repo/bbb')
    // aaa는 busy 유지, bbb만 idle
    busyByDir.set('/repo/aaa', ['ses-streaming'])
    busyByDir.set('/repo/bbb', [])
    const done = await flushPendingInstanceReloads((dir) =>
      attemptInstanceReload(baseUrl, dir, {}),
    )
    expect(done).toEqual(['/repo/bbb'])
    expect(disposeHits).toEqual(['/repo/bbb'])
    expect(pendingInstanceReloadDirs()).toEqual(['/repo/aaa'])
    // aaa가 idle이 되면 다음 flush에서 소진
    busyByDir.set('/repo/aaa', [])
    const done2 = await flushPendingInstanceReloads((dir) =>
      attemptInstanceReload(baseUrl, dir, {}),
    )
    expect(done2).toEqual(['/repo/aaa'])
    expect(pendingInstanceReloadDirs()).toEqual([])
  })

  it('flush 실패(reloader throw)는 큐에 남긴다', async () => {
    queuePendingInstanceReload('/repo/zzz')
    const done = await flushPendingInstanceReloads(() => {
      throw new Error('boom')
    })
    expect(done).toEqual([])
    expect(pendingInstanceReloadDirs()).toEqual(['/repo/zzz'])
  })
})
