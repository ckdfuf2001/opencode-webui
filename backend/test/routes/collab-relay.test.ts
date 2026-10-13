import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

// 모듈 로드 전 워크스페이스 격리.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'collabrelay-'))
process.env.WORKSPACE_PATH = tmp
await fs.mkdir(path.join(tmp, 'repos', 'aaa'), { recursive: true })
await fs.writeFile(path.join(tmp, 'repos', 'aaa', 'shared.txt'), 'seed')

const { createCollabRoutes, registerCollabSockets } = await import('../../src/routes/collab')
const { checkSave, resetCollabForTests, rooms } = await import('../../src/services/collab-rooms')

/** 최소 y-websocket 클라이언트 (서버 프로토콜 검증용). */
class YClient {
  doc = new Y.Doc()
  awareness = new awarenessProtocol.Awareness(this.doc)
  ws: WebSocket
  synced = false

  constructor(url: string, name: string) {
    this.ws = new WebSocket(url)
    this.awareness.setLocalState({ user: name })
    this.doc.on('update', (update: Uint8Array) => {
      const e = encoding.createEncoder()
      encoding.writeVarUint(e, 0)
      syncProtocol.writeUpdate(e, update)
      this.send(encoding.toUint8Array(e))
    })
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const e = encoding.createEncoder()
      encoding.writeVarUint(e, 1)
      encoding.writeVarUint8Array(
        e,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]),
      )
      this.send(encoding.toUint8Array(e))
    })
    this.ws.on('message', (raw: Uint8Array) => {
      const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer)
      const d = decoding.createDecoder(data)
      const type = decoding.readVarUint(d)
      if (type === 0) {
        const e = encoding.createEncoder()
        encoding.writeVarUint(e, 0)
        syncProtocol.readSyncMessage(d, e, this.doc, null)
        if (encoding.length(e) > 1) this.send(encoding.toUint8Array(e))
        this.synced = true
      } else if (type === 1) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(d), null)
      }
    })
  }

  send(data: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data)
  }

  publishPresence(): void {
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, 1)
    encoding.writeVarUint8Array(
      e,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]),
    )
    this.send(encoding.toUint8Array(e))
  }

  close(): void {
    try { this.ws.close() } catch { /* 무시 */ }
    try { this.doc.destroy() } catch { /* 무시 */ }
  }
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (cond()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('collab relay (live server, y-websocket compatible)', () => {
  let baseUrl = ''
  let wsBase = ''
  let stop: () => Promise<void>
  const clients: YClient[] = []

  beforeAll(async () => {
    const root = new Hono()
    root.route('/api/collab', createCollabRoutes())
    const { injectWebSocket } = registerCollabSockets(root)
    const server = serve({ fetch: root.fetch, port: 0, hostname: '127.0.0.1' })
    injectWebSocket(server)
    await new Promise<void>((resolve) => server.on('listening', () => resolve()))
    const port = (server.address() as AddressInfo).port
    baseUrl = `http://127.0.0.1:${port}`
    wsBase = `ws://127.0.0.1:${port}`
    stop = async () => {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
    }
  })

  afterAll(async () => {
    for (const c of clients) c.close()
    resetCollabForTests()
    await stop()
  })

  it('two PCs sync Y.Text + awareness; first conn owns', async () => {
    const session = await (
      await fetch(`${baseUrl}/api/collab/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'repos/aaa/shared.txt' }),
      })
    ).json() as { roomId: string; role: string }
    expect(session.role).toBe('host')
    expect(session.roomId).toMatch(/^f_[0-9a-f]{40}$/)

    const a = new YClient(`${wsBase}/api/collab/${session.roomId}`, 'pc-a')
    const b = new YClient(`${wsBase}/api/collab/${session.roomId}`, 'pc-b')
    clients.push(a, b)
    await waitFor(() => a.synced && b.synced, 'both synced')

    // A가 쓰면 B에 보인다.
    a.doc.getText('t').insert(0, 'hello')
    await waitFor(() => b.doc.getText('t').toString() === 'hello', 'B sees hello')
    // B가 이어쓰면 A에 보인다.
    b.doc.getText('t').insert(5, ' world')
    await waitFor(() => a.doc.getText('t').toString() === 'hello world', 'A sees world')

    // presence 전파.
    a.publishPresence()
    b.publishPresence()
    await waitFor(() => {
      const states = b.awareness.getStates()
      return [...states.values()].some((s) => (s as { user?: string }).user === 'pc-a')
    }, 'B sees pc-a presence')

    // 첫 접속(A)이 owner다.
    await waitFor(() => {
      const room = rooms.get(session.roomId)
      return !!room && room.ownerIds.has(a.doc.clientID)
    }, 'server marks A owner')
    expect(checkSave(session.roomId, a.doc.clientID, 5)).toMatchObject({ ok: true })
    expect(checkSave(session.roomId, b.doc.clientID, 5)).toMatchObject({ ok: false, status: 409 })
  })

  it('unknown room is refused', async () => {
    const ws = new WebSocket(`${wsBase}/api/collab/f_${'0'.repeat(40)}`)
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c: number) => resolve(c))
      setTimeout(() => resolve(-1), 5000)
    })
    expect(code).toBe(1008)
  })
})
