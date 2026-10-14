import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { YCollabSession } from '../../../frontend/src/lib/ycollab'

// 모듈 로드 전 워크스페이스 격리.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'collabrelay-'))
process.env.WORKSPACE_PATH = tmp
await fs.mkdir(path.join(tmp, 'repos', 'aaa'), { recursive: true })
await fs.writeFile(path.join(tmp, 'repos', 'aaa', 'shared.txt'), 'seed')

const { createCollabRoutes, registerCollabSockets } = await import('../../src/routes/collab')
const rooms = await import('../../src/services/collab-rooms')

async function waitFor(cond: () => boolean, label: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (cond()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function postSession(baseUrl: string, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const r = await testFetch(`${baseUrl}/api/collab/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, json: await r.json() }
}

// BrightVPN 실행 중 loopback connect가 간헐적으로 EACCES로 실패한다.
// 테스트 신뢰성을 위해 일시적 연결 오류는 재시도한다 (최대 약 5초).
async function testFetch(url: string, init?: RequestInit, attempts = 12): Promise<Response> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init)
    } catch (e) {
      lastErr = e
      const code = (e as { cause?: { code?: string } })?.cause?.code
      if (code !== 'EACCES' && code !== 'ECONNREFUSED' && code !== 'ECONNRESET') throw e
      await new Promise((r) => setTimeout(r, 150 + i * 100))
    }
  }
  throw lastErr
}

// BrightVPN 실행 중 127.0.0.1 listen 자체가 간헐적으로 EACCES로 실패한다.
// beforeAll 훅 타임아웃을 막기 위해 시작을 재시도한다.
async function startRelay(): Promise<{ port: number; stop: () => Promise<void> }> {
  const root = new Hono()
  root.route('/api/collab', createCollabRoutes())
  const { injectWebSocket } = registerCollabSockets(root)
  let lastErr: unknown
  for (let i = 0; i < 15; i++) {
    const server = serve({ fetch: root.fetch, port: 0, hostname: '127.0.0.1' })
    try {
      await new Promise<void>((resolve, reject) => {
        server.on('listening', () => resolve())
        server.on('error', (e) => reject(e))
      })
    } catch (e) {
      lastErr = e
      try {
        server.close()
      } catch { /* 무시 */ }
      if ((e as { code?: string })?.code !== 'EACCES') throw e
      await new Promise((r) => setTimeout(r, 200 + i * 150))
      continue
    }
    injectWebSocket(server)
    const port = (server.address() as AddressInfo).port
    // 이후 런타임 에러는 조용히 삼키지 않는다 (EACCES 제외).
    server.on('error', (e: Error & { code?: string }) => {
      if (e?.code !== 'EACCES') console.error('[relay-test] server error', e)
    })
    return {
      port,
      stop: async () => {
        await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
      },
    }
  }
  throw lastErr
}

describe('collab relay (live server, y-websocket compatible)', () => {
  let baseUrl = ''
  let wsBase = ''
  let stop: () => Promise<void>
  const sessions: YCollabSession[] = []
  const sockets: WebSocket[] = []

  const track = (s: YCollabSession): YCollabSession => {
    sessions.push(s)
    return s
  }

  beforeAll(async () => {
    const { port: p, stop: st } = await startRelay()
    baseUrl = `http://127.0.0.1:${p}`
    wsBase = `ws://127.0.0.1:${p}`
    stop = st
  }, 60000)

  afterAll(async () => {
    for (const s of sessions) {
      try {
        s.destroy()
      } catch { /* 무시 */ }
    }
    for (const w of sockets) {
      try { w.close() } catch { /* 무시 */ }
    }
    rooms.resetCollabForTests()
    await stop()
  })

  beforeEach(() => {
    rooms.resetCollabForTests()
  })

  it('T1a: step1-only server never marks synced (no premature sync)', async () => {
    // step1만 보내고 step2를 주지 않는 서버 (listen EACCES면 재시작).
    let wss: WebSocketServer | null = null
    for (let i = 0; i < 15; i++) {
      const cand = new WebSocketServer({ port: 0, host: '127.0.0.1' })
      try {
        await new Promise<void>((resolve, reject) => {
          cand.on('listening', () => resolve())
          cand.on('error', (e) => reject(e))
        })
        wss = cand
        break
      } catch (e) {
        try {
          cand.close()
        } catch { /* 무시 */ }
        if ((e as { code?: string })?.code !== 'EACCES') throw e
        await new Promise((r) => setTimeout(r, 200 + i * 150))
      }
    }
    if (!wss) throw new Error('canned server listen failed')
    const port = (wss.address() as AddressInfo).port
    let sawStep1 = false
    let sawConn = false
    wss.on('connection', (ws) => {
      sawConn = true
      const e = encoding.createEncoder()
      encoding.writeVarUint(e, 0)
      syncProtocol.writeSyncStep1(e, new Y.Doc())
      ws.send(encoding.toUint8Array(e))
      ws.on('message', (raw: Uint8Array) => {
        try {
          const d = decoding.createDecoder(raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer))
          if (decoding.readVarUint(d) === 0) sawStep1 = true
        } catch { /* 무시 */ }
      })
    })
    const c = track(new YCollabSession(`ws://127.0.0.1:${port}/room`, { name: 't', color: '#000' }))
    c.connect()
    // step1 송신까지는 조건 대기 (결정적), synced는 절대 true가 되면 안 된다
    // (이 서버는 step2를 주지 않으므로).
    await waitFor(() => sawConn && sawStep1, 'client sent step1')
    expect(c.synced).toBe(false)
    await new Promise((r) => setTimeout(r, 400))
    expect(c.synced).toBe(false)
    c.destroy()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  })

  it('T1b: late joiner receives existing content (real clients)', async () => {
    const s = await postSession(baseUrl, { path: 'repos/aaa/shared.txt' })
    expect(s.status).toBe(200)
    const a = track(new YCollabSession(`${wsBase}/api/collab/${s.json.roomId}`, { name: 'a', color: '#e11d48' }))
    a.connect()
    await waitFor(() => a.synced, 'A synced')
    a.doc.getText('t').insert(0, 'hello')
    const b = track(new YCollabSession(`${wsBase}/api/collab/${s.json.roomId}`, { name: 'b', color: '#2563eb' }))
    b.connect()
    await waitFor(() => b.synced, 'B synced')
    await waitFor(() => b.doc.getText('t').toString() === 'hello', 'B got hello')
    b.doc.getText('t').insert(5, ' world')
    await waitFor(() => a.doc.getText('t').toString() === 'hello world', 'A got world')
    // awareness app 필드가 서버 participants로 보인다 (전체 체인).
    let names: string[] = []
    for (let i = 0; i < 100; i++) {
      const lock = (await (
        await testFetch(`${baseUrl}/api/collab/lock?path=${encodeURIComponent('repos/aaa/shared.txt')}`)
      ).json()) as { participants?: { name: string; mode: string }[] }
      names = (lock.participants ?? []).map((p) => p.name)
      if (names.includes('a') && names.includes('b')) break
      await new Promise((r) => setTimeout(r, 150))
    }
    expect(names).toEqual(expect.arrayContaining(['a', 'b']))
    a.destroy()
    b.destroy()
  })

  it('T2: handoff keeps saving without stale-base 409', async () => {
    const s = await postSession(baseUrl, { path: 'repos/aaa/shared.txt' })
    const roomId = s.json.roomId as string
    const a = track(new YCollabSession(`${wsBase}/api/collab/${roomId}`, { name: 'a', color: '#e11d48' }))
    a.connect()
    await waitFor(() => a.synced, 'A synced')
    const b = track(new YCollabSession(`${wsBase}/api/collab/${roomId}`, { name: 'b', color: '#2563eb' }))
    b.connect()
    await waitFor(() => b.synced, 'B synced')
    a.doc.getText('t').insert(0, 'x')
    await waitFor(() => {
      const room = rooms.rooms.get(roomId)
      return !!room && room.ownerIds.has(a.clientId)
    }, 'A is owner')
    // A 저장 (baseHash 없이도 서버 lastHash 기준 통과).
    const bytes = new TextEncoder().encode('owner-bytes')
    const save1 = await testFetch(`${baseUrl}/api/collab/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, clientId: a.clientId, bytesB64: Buffer.from(bytes).toString('base64') }),
    })
    expect(save1.status).toBe(200)
    // A 퇴장 → B 승계. B는 오래된 knownHash를 들고 있지만 저장된다.
    a.destroy()
    await waitFor(() => {
      const room = rooms.rooms.get(roomId)
      return !!room && room.ownerIds.has(b.clientId)
    }, 'B promoted')
    const save2 = await testFetch(`${baseUrl}/api/collab/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, clientId: b.clientId, bytesB64: Buffer.from(bytes).toString('base64') }),
    })
    expect(save2.status).toBe(200)
    const lock = (await (await testFetch(`${baseUrl}/api/collab/lock?path=repos/aaa/shared.txt`)).json()) as {
      externalChanged: boolean
    }
    expect(lock.externalChanged).toBe(false)
    b.destroy()
  })

  it('T3: drop + offline edit + same-doc reconnect (no remount, no dup)', async () => {
    const s = await postSession(baseUrl, { path: 'repos/aaa/shared.txt' })
    const roomId = s.json.roomId as string
    const a = track(new YCollabSession(`${wsBase}/api/collab/${roomId}`, { name: 'a', color: '#e11d48' }))
    a.connect()
    await waitFor(() => a.synced, 'A synced')
    const b = track(new YCollabSession(`${wsBase}/api/collab/${roomId}`, { name: 'b', color: '#2563eb' }))
    b.connect()
    await waitFor(() => b.synced, 'B synced')
    const docBefore = b.doc
    // B 소켓 강제 종료 후 오프라인 편집.
    ;(b as unknown as { ws: WebSocket }).ws?.close()
    await new Promise((r) => setTimeout(r, 300))
    b.doc.getText('t').insert(0, 'offline-edit')
    // 같은 doc으로 재연결.
    b.reconnect()
    await waitFor(() => b.synced, 'B resynced')
    await waitFor(() => a.doc.getText('t').toString().includes('offline-edit'), 'A got offline edit')
    expect(b.doc).toBe(docBefore)
    expect(a.doc.getText('t').toString().split('offline-edit').length - 1).toBe(1)
    a.destroy()
    b.destroy()
  })

  it('T4a: wiped server resumes same epoch without duplication', async () => {
    const s = await postSession(baseUrl, { path: 'repos/aaa/shared.txt' })
    const roomId = s.json.roomId as string
    const epoch = s.json.epoch as string
    const a = track(new YCollabSession(`${wsBase}/api/collab/${roomId}`, { name: 'a', color: '#e11d48' }))
    a.connect()
    await waitFor(() => a.synced, 'A synced')
    a.doc.getText('t').insert(0, 'keepme')
    const b = track(new YCollabSession(`${wsBase}/api/collab/${roomId}`, { name: 'b', color: '#2563eb' }))
    b.connect()
    await waitFor(() => b.doc.getText('t').toString() === 'keepme', 'B has keepme')
    const hashBefore = (await rooms.currentDiskHash(roomId)) as string
    // 서버 재시작 시뮬레이션: 메모리 wipe (디스크는 그대로). 소켓도 끊긴 것으로 취급.
    rooms.resetCollabForTests()
    ;(a as unknown as { ws: WebSocket }).ws?.close()
    ;(b as unknown as { ws: WebSocket }).ws?.close()
    await new Promise((r) => setTimeout(r, 300))
    // 양쪽 resume (같은 epoch, knownHash 일치).
    for (const client of [a, b]) {
      const r = await postSession(baseUrl, {
        path: 'repos/aaa/shared.txt',
        resumeEpoch: epoch,
        knownHash: hashBefore,
        clientId: client.clientId,
      })
      expect(r.status).toBe(200)
      expect(r.json.epoch).toBe(epoch)
      expect(r.json.role).toBe('resume')
    }
    // 같은 doc으로 재연결 (리마운트 없음).
    a.reconnect()
    b.reconnect()
    await waitFor(() => a.synced && b.synced, 'both resynced', 20000)
    // 내용 중복 없이 유지된다.
    expect(a.doc.getText('t').toString().split('keepme').length - 1).toBe(1)
    expect(b.doc.getText('t').toString().split('keepme').length - 1).toBe(1)
    // owner 재선출을 조건 대기한다 (awareness 전파가 sync보다 늦을 수 있다 —
    // 고정 500ms 대기는 loopback 차단 폭풍에 깨진다).
    let lock = { active: false, owner: [] as number[] }
    for (let i = 0; i < 100; i++) {
      lock = (await (
        await testFetch(`${baseUrl}/api/collab/lock?path=repos/aaa/shared.txt`)
      ).json()) as { active: boolean; owner: number[] }
      if (lock.active && lock.owner.length > 0) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(lock.active).toBe(true)
    expect(lock.owner.length).toBeGreaterThan(0)
    // owner 저장 200 (둘 중 하나는 owner다).
    const ownerId = lock.owner.includes(a.clientId) ? a.clientId : b.clientId
    const save = await testFetch(`${baseUrl}/api/collab/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId,
        clientId: ownerId,
        bytesB64: Buffer.from(new TextEncoder().encode('after-resume')).toString('base64'),
      }),
    })
    expect(save.status).toBe(200)
    a.destroy()
    b.destroy()
  })

  it('T4b: newcomer seeds new epoch; stale resume gets epoch_mismatch', async () => {
    const lock0 = (await (await testFetch(`${baseUrl}/api/collab/lock?path=repos/aaa/shared.txt`)).json()) as {
      active: boolean
    }
    expect(lock0.active).toBe(false)
    const c = await postSession(baseUrl, { path: 'repos/aaa/shared.txt' })
    expect(c.json.role).toBe('host')
    const cv = track(new YCollabSession(`${wsBase}/api/collab/${c.json.roomId}`, { name: 'c', color: '#059669' }))
    cv.connect()
    await waitFor(() => cv.synced, 'C synced')
    cv.doc.getText('t').insert(0, 'cee')
    const stale = await postSession(baseUrl, {
      path: 'repos/aaa/shared.txt',
      resumeEpoch: 'deadbeef-dead-beef-dead-deadbeefdead',
      knownHash: '00',
    })
    expect(stale.status).toBe(409)
    expect(stale.json.code).toBe('epoch_mismatch')
    // C 내용 오염 없음.
    expect(cv.doc.getText('t').toString()).toBe('cee')
    cv.destroy()
  })

  it('T4c: disk changed while away -> external_change', async () => {
    const s = await postSession(baseUrl, { path: 'repos/aaa/shared.txt' })
    rooms.resetCollabForTests()
    await fs.writeFile(path.join(tmp, 'repos', 'aaa', 'shared.txt'), 'changed-while-away')
    const r = await postSession(baseUrl, {
      path: 'repos/aaa/shared.txt',
      resumeEpoch: s.json.epoch,
      knownHash: s.json.lastHash,
    })
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('external_change')
    await fs.writeFile(path.join(tmp, 'repos', 'aaa', 'shared.txt'), 'seed')
  })

  it('T7: save before seed -> not_seeded', async () => {
    const s = await postSession(baseUrl, { path: 'repos/aaa/shared.txt' })
    // WS도 붙이고 awareness까지 갔지만 doc update는 없음.
    const c = track(new YCollabSession(`${wsBase}/api/collab/${s.json.roomId}`, { name: 'c', color: '#059669' }))
    c.connect()
    await waitFor(() => c.synced, 'C synced')
    await waitFor(async () => {
      const lock = (await (
        await testFetch(`${baseUrl}/api/collab/lock?path=repos/aaa/shared.txt`)
      ).json()) as { owner: number[] }
      return lock.owner?.includes(c.clientId) ?? false
    }, 'C owns')
    const save = await testFetch(`${baseUrl}/api/collab/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: s.json.roomId, clientId: c.clientId, bytesB64: Buffer.from('x').toString('base64') }),
    })
    expect(save.status).toBe(409)
    expect(((await save.json()) as { code: string }).code).toBe('not_seeded')
    c.destroy()
  })

  it('T8: untouched room expires via TTL (P1-3)', async () => {
    rooms.setRoomTtlMs(150)
    try {
      await postSession(baseUrl, { path: 'repos/aaa/shared.txt' })
      await new Promise((r) => setTimeout(r, 250))
      rooms.sweepRooms()
      const lock = (await (await testFetch(`${baseUrl}/api/collab/lock?path=repos/aaa/shared.txt`)).json()) as {
        active: boolean
      }
      expect(lock.active).toBe(false)
    } finally {
      rooms.setRoomTtlMs(30_000)
    }
  })

  it('unknown room is refused', async () => {
    // EACCES(일시적 loopback 차단)면 소켓을 버리고 재시도한다.
    let code = -1
    for (let attempt = 0; attempt < 12 && code !== 1008; attempt++) {
      const ws = new WebSocket(`${wsBase}/api/collab/f_${'0'.repeat(40)}`)
      sockets.push(ws)
      code = await new Promise<number>((resolve) => {
        ws.on('error', (e: Error & { code?: string }) => {
          if (e?.code === 'EACCES' || e?.code === 'ECONNREFUSED') resolve(-2)
        })
        ws.on('close', (c: number) => resolve(c))
        setTimeout(() => resolve(-1), 5000)
      })
      try {
        ws.close()
      } catch { /* 무시 */ }
      if (code === -2) {
        await new Promise((r) => setTimeout(r, 300))
        code = -1
      }
    }
    expect(code).toBe(1008)
  })
})
