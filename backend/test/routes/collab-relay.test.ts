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

  it('T2b: binary save via octet-stream + headers (M1)', async () => {
    const s = await postSession(baseUrl, { path: 'repos/aaa/shared.txt' })
    const roomId = s.json.roomId as string
    const a = track(new YCollabSession(`${wsBase}/api/collab/${roomId}`, { name: 'a', color: '#e11d48' }))
    a.connect()
    await waitFor(() => a.synced, 'A synced')
    a.doc.getText('t').insert(0, 'x')
    await waitFor(() => {
      const room = rooms.rooms.get(roomId)
      return !!room && room.ownerIds.has(a.clientId)
    }, 'A is owner')
    const bytes = new TextEncoder().encode('owner-binary-bytes')
    const save = await testFetch(`${baseUrl}/api/collab/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-collab-room': roomId,
        'x-collab-client': String(a.clientId),
      },
      body: bytes as unknown as BodyInit,
    })
    expect(save.status).toBe(200)
    const body = (await save.json()) as { newHash?: string }
    expect(typeof body.newHash).toBe('string')
    // 헤더 누락이면 400.
    const bad = await testFetch(`${baseUrl}/api/collab/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes as unknown as BodyInit,
    })
    expect(bad.status).toBe(400)
    a.destroy()
  })

  it('T2c: image-loss save is blocked for pptx (4-0 guard)', async () => {
    await fs.writeFile(path.join(tmp, 'repos', 'aaa', 'media.pptx'), 'seed')
    const s = await postSession(baseUrl, { path: 'repos/aaa/media.pptx' })
    const roomId = s.json.roomId as string
    const a = track(new YCollabSession(`${wsBase}/api/collab/${roomId}`, { name: 'a', color: '#e11d48' }))
    a.connect()
    await waitFor(() => a.synced, 'A synced')
    a.doc.getText('t').insert(0, 'x')
    await waitFor(() => {
      const room = rooms.rooms.get(roomId)
      return !!room && room.ownerIds.has(a.clientId)
    }, 'A is owner')
    const withImages = new TextEncoder().encode(
      'PKppt/media/image1.pngPKppt/media/image2.pngPK' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image2.png"/>',
    )
    const post = (bytes: Uint8Array, allow?: boolean): Promise<Response> =>
      testFetch(`${baseUrl}/api/collab/save`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-collab-room': roomId,
          'x-collab-client': String(a.clientId),
          ...(allow ? { 'x-collab-allow-image-loss': '1' } : {}),
        },
        body: bytes as unknown as BodyInit,
      })
    // 이미지가 있는 상태로 저장 성공.
    expect((await post(withImages)).status).toBe(200)
    // 이미지가 사라진 저장은 409 image_loss.
    const lost = await post(new TextEncoder().encode('PKno media here'))
    expect(lost.status).toBe(409)
    const body = (await lost.json()) as { code?: string }
    expect(body.code).toBe('image_loss')
// 명시적 승인은 통과.
    expect((await post(new TextEncoder().encode('PKno media here'), true)).status).toBe(200)
    a.destroy()
  })

  it('T2d: repeated image_loss stays blocked; allow-header is the only way through (R1/R2)', async () => {
    await fs.writeFile(path.join(tmp, 'repos', 'aaa', 'media2.pptx'), 'seed')
    const s = await postSession(baseUrl, { path: 'repos/aaa/media2.pptx' })
    const roomId = s.json.roomId as string
    const a = track(new YCollabSession(`${wsBase}/api/collab/${roomId}`, { name: 'a', color: '#e11d48' }))
    a.connect()
    await waitFor(() => a.synced, 'A synced')
    a.doc.getText('t').insert(0, 'x')
    await waitFor(() => {
      const room = rooms.rooms.get(roomId)
      return !!room && room.ownerIds.has(a.clientId)
    }, 'A is owner')
    const good = new TextEncoder().encode(
      'PKppt/media/image1.pngPK<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>',
    )
    const bad = new TextEncoder().encode('PKnothing')
    const post = (bytes: Uint8Array, allow?: boolean): Promise<Response> =>
      testFetch(`${baseUrl}/api/collab/save`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-collab-room': roomId,
          'x-collab-client': String(a.clientId),
          ...(allow ? { 'x-collab-allow-image-loss': '1' } : {}),
        },
        body: bytes as unknown as BodyInit,
      })
    expect((await post(good)).status).toBe(200)
    // 자동 저장 반복(2.5초 간격 흉내) 3회 — 전부 409여야 한다.
    for (let i = 0; i < 3; i++) {
      const r = await post(bad)
      expect(r.status).toBe(409)
      expect(((await r.json()) as { code?: string }).code).toBe('image_loss')
    }
    // 디스크는 그대로다.
    const onDisk = await fs.readFile(path.join(tmp, 'repos', 'aaa', 'media2.pptx'))
    expect(onDisk.toString('utf8')).toBe(Buffer.from(good).toString('utf8'))
    a.destroy()
  })

  it('T2e: reset closes every conn with 4001 and disposes the room (Q1/Q2)', async () => {
    await fs.writeFile(path.join(tmp, 'repos', 'aaa', 'reset.pptx'), 'seed')
    const s = await postSession(baseUrl, { path: 'repos/aaa/reset.pptx' })
    const roomId = s.json.roomId as string
    const a = track(new YCollabSession(`${wsBase}/api/collab/${roomId}`, { name: 'a', color: '#e11d48' }))
    a.connect()
    await waitFor(() => a.synced, 'A synced')
    const b = track(new YCollabSession(`${wsBase}/api/collab/${roomId}`, { name: 'b', color: '#2563eb' }))
    b.connect()
    await waitFor(() => b.synced, 'B synced')
    // A가 owner가 되게 만든다.
    a.doc.getText('t').insert(0, 'x')
    await waitFor(() => {
      const room = rooms.rooms.get(roomId)
      return !!room && room.ownerIds.has(a.clientId)
    }, 'A is owner')
    // guest(B)는 reset을 요청해도 무시되어야 한다 (conn 기준 권한).
    const closeCodes: number[] = []
    const sendReset = (ws: WebSocket): void => {
      const e = encoding.createEncoder()
      encoding.writeVarUint(e, 101)
      ws.send(encoding.toUint8Array(e))
    }
    const rawA = (a as unknown as { ws: WebSocket }).ws
    const rawB = (b as unknown as { ws: WebSocket }).ws
    // ycollab은 브라우저 전역 WebSocket을 쓴다(.on이 아니라 addEventListener).
    rawA.addEventListener('close', (e) => {
      closeCodes.push((e as CloseEvent).code)
    })
    rawB.addEventListener('close', (e) => {
      closeCodes.push((e as CloseEvent).code)
    })
    sendReset(rawB)
    await new Promise((r) => setTimeout(r, 400))
    expect(rooms.rooms.has(roomId)).toBe(true)
    expect(closeCodes.length).toBe(0)
    // owner가 type 101 전송 → 전원 4001 + room 해체.
    sendReset(rawA)
    await waitFor(() => closeCodes.length >= 2, 'both conns closed with 4001')
    expect(closeCodes.every((c) => c === 4001)).toBe(true)
    expect(rooms.rooms.has(roomId)).toBe(false)
    // 재입장은 새 epoch로 host 권한이 돌아온다 (resume 없이).
    const again = await postSession(baseUrl, { path: 'repos/aaa/reset.pptx' })
    expect(again.json.role).toBe('host')
    expect(again.json.epoch).toBeTruthy()
    a.destroy()
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

  it('T2f: owner self-save is not an external change (watcher fires right after applySave)', async () => {
  // M10/V1: owner 가 applySave 로 저장한 직후 실제 fs watcher 이벤트가 울린다.
  // 그 이벤트는 "자기 저장" 이므로 externalChanged 가 되어서는 안 된다.
  // 지연을 0~50ms 변주시켜 rename 직후 watcher 콜백이 어떤 타이밍에 오든 잡는다.
  for (const delayMs of [0, 10, 50]) {
    const rel = `repos/aaa/selfsave-${delayMs}.txt`
    await fs.writeFile(path.join(tmp, rel), 'seed')
    const s = await postSession(baseUrl, { path: rel })
    const roomId = s.json.roomId as string
    const epoch = s.json.epoch as string
    const a = track(new YCollabSession(`${wsBase}/api/collab/${roomId}`, { name: 'a', color: '#e11d48' }))
    a.connect()
    await waitFor(() => a.synced, 'A synced')
    a.doc.getText('t').insert(0, 'x')
    await waitFor(() => {
      const room = rooms.rooms.get(roomId)
      return !!room && room.ownerIds.has(a.clientId)
    }, 'A is owner')

    const bytes = new TextEncoder().encode(`self-save-${delayMs}`)
    const save = await testFetch(`${baseUrl}/api/collab/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-collab-room': roomId,
        'x-collab-client': String(a.clientId),
      },
      body: bytes as unknown as BodyInit,
    })
    expect(save.status).toBe(200)

    // watcher 가 rename 이벤트를 즉시 받도록 같은 경로를 다시 건드린다.
    await fs.writeFile(path.join(tmp, rel), `self-save-${delayMs}`)
    await new Promise((r) => setTimeout(r, delayMs))
    // watcher debounce(400ms) + 판정 시간만큼 기다린다.
    await new Promise((r) => setTimeout(r, 900))

    const room = rooms.rooms.get(roomId)
    expect(room, `room must survive (delay=${delayMs})`).toBeTruthy()
    expect(room!.externalChanged, `self save must not look external (delay=${delayMs})`).toBe(false)
    expect(room!.ownerIds.has(a.clientId), `owner must survive (delay=${delayMs})`).toBe(true)
    expect(room!.epoch, `epoch must not change (delay=${delayMs})`).toBe(epoch)
    expect(a.synced, `connection must survive (delay=${delayMs})`).toBe(true)
    a.destroy()
  }
})

it('T2g: real external change flags the room but keeps room/owner/epoch', async () => {
  const rel = 'repos/aaa/external-change.txt'
  await fs.writeFile(path.join(tmp, rel), 'seed')
  const s = await postSession(baseUrl, { path: rel })
  const roomId = s.json.roomId as string
  const epoch = s.json.epoch as string
  const a = track(new YCollabSession(`${wsBase}/api/collab/${roomId}`, { name: 'a', color: '#e11d48' }))
  a.connect()
  await waitFor(() => a.synced, 'A synced')
  a.doc.getText('t').insert(0, 'x')
  await waitFor(() => {
    const room = rooms.rooms.get(roomId)
    return !!room && room.ownerIds.has(a.clientId)
  }, 'A is owner')

  // 백엔드 밖에서 파일을 덮어쓴다 (진짜 외부 변경).
  await fs.writeFile(path.join(tmp, rel), 'outside-wrote-this')
  await waitFor(() => rooms.rooms.get(roomId)?.externalChanged === true, 'externalChanged flagged')

  const room = rooms.rooms.get(roomId)
  expect(room, 'room must not be reset by an external change').toBeTruthy()
  expect(room!.epoch, 'epoch must not change').toBe(epoch)
  expect(room!.ownerIds.has(a.clientId), 'owner must be kept').toBe(true)

  // lock 응답에 외부 변경이 반영된다.
  const lock = (await (await testFetch(`${baseUrl}/api/collab/lock?path=${rel}`)).json()) as {
    owner?: number[]
    externalChanged?: boolean
  }
  expect(lock.externalChanged).toBe(true)
  expect(lock.owner?.includes(a.clientId)).toBe(true)

  // 이후 owner 의 저장은 막힌다 (자동 병합 없음).
  const save = await testFetch(`${baseUrl}/api/collab/save`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-collab-room': roomId,
      'x-collab-client': String(a.clientId),
    },
    body: new TextEncoder().encode('after-external') as unknown as BodyInit,
  })
  expect(save.status).toBe(409)
  const body = (await save.json()) as { code?: string }
  expect(['conflict', 'external_change']).toContain(body.code)
  a.destroy()
})

it('T2h: concurrent session POSTs for the same file create only one room', async () => {
  // M10/V1: StrictMode(dev) 등���서 같은 파일��� 세션 POST 가 동시에 나간다.
  // 방 생성에 경합 가드가 없으면 **방이 2개** 만들어지고, rooms 맵에는 나중 것만 남는다.
  // 앞의 방은 고아가 되��� 그 watcher 도 살아 있어, 다른 방이 방금 쓴 파일을
  // "외부 변경"으로 오인한다 → externalChanged → 클라이언트 재접속 → owner 상실 →
  // 편집이 디스크에 반영되지 않��(E2 실패의 근본 원인).
  const rel = 'repos/aaa/race.txt'
  await fs.writeFile(path.join(tmp, rel), 'seed')
  const [r1, r2] = await Promise.all([
    postSession(baseUrl, { path: rel }),
    postSession(baseUrl, { path: rel }),
  ])
  expect(r1.status).toBe(200)
  expect(r2.status).toBe(200)
  // 같은 방이어야 한다.
  expect(r2.json.roomId).toBe(r1.json.roomId)
  // 두 번째는 그 방에 **참가**(guest)해야 한다. host 라면 방을 또 만든 것이다.
  expect(r2.json.role).toBe('guest')
  // 방은 1개뿐.
  const room = rooms.rooms.get(r1.json.roomId as string)
  expect(room).toBeTruthy()
  expect(room!.path.endsWith('race.txt')).toBe(true)
  // owner 는 나중에 접속한 conn 이 아니라 최초 conn 이 elected 된다.
  const a = track(new YCollabSession(`${wsBase}/api/collab/${r1.json.roomId}`, { name: 'a', color: '#e11d48' }))
  a.connect()
  await waitFor(() => a.synced, 'A synced')
  await waitFor(() => {
    const r = rooms.rooms.get(r1.json.roomId as string)
    return !!r && r.ownerIds.has(a.clientId)
  }, 'A is owner')
  a.destroy()
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
