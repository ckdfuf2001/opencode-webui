import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'path'
import fs from 'node:fs/promises'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

// files.ts/shared가 모듈 로드 시점에 WORKSPACE_PATH를 캡처하므로
// 정적 import보다 먼저 env를 깐다.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'collabobj-'))
process.env.WORKSPACE_PATH = tmp

const NOTE_REL = path.join('repos', 'aaa', 'note.txt')
await fs.mkdir(path.join(tmp, 'repos', 'aaa'), { recursive: true })
await fs.writeFile(path.join(tmp, NOTE_REL), 'hello')

const {
  addConn,
  createSession,
  removeConn,
  resetCollabForTests,
  registerRoomObjects,
  acquireObjectLock,
  releaseObjectLock,
  moveObject,
  deleteObject,
  getRoomObjects,
  rooms,
} = await import('../../src/services/collab-rooms')

const sock = () => ({ send(_d: Uint8Array) {} })

beforeEach(() => {
  resetCollabForTests()
})

afterEach(() => {
  resetCollabForTests()
})

async function freshRoom() {
  const s = await createSession(NOTE_REL)
  return s.roomId
}

const ITEMS = [
  { sheet: 0, kind: 'image' },
  { sheet: 0, kind: 'unsupported:shape' },
]

describe('collab objects: register', () => {
  it('assigns o1.. keys in order; same hash returns same keys', async () => {
    const roomId = await freshRoom()
    const r1 = registerRoomObjects(roomId, 'hash1', ITEMS)
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    expect(r1.keys).toEqual(['o1', 'o2'])
    const r2 = registerRoomObjects(roomId, 'hash1', ITEMS)
    expect(r2).toMatchObject({ ok: true, keys: ['o1', 'o2'] })
  })

  it('order mismatch is rejected (fail-closed)', async () => {
    const roomId = await freshRoom()
    const r1 = registerRoomObjects(roomId, 'hash1', ITEMS)
    expect(r1.ok).toBe(true)
    const bad = registerRoomObjects(roomId, 'hash1', [{ sheet: 0, kind: 'image' }])
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.code).toBe('order_mismatch')
    const bad2 = registerRoomObjects(roomId, 'hash1', [
      { sheet: 0, kind: 'image' },
      { sheet: 0, kind: 'chart' },
    ])
    expect(bad2.ok).toBe(false)
  })

  it('unknown room -> no_room', () => {
    const r = registerRoomObjects('f_nope', 'h', ITEMS)
    expect(r).toMatchObject({ ok: false, code: 'no_room' })
  })
})

describe('collab objects: lock contention', () => {
  it('second holder gets locked + holder id', async () => {
    const roomId = await freshRoom()
    registerRoomObjects(roomId, 'hash1', ITEMS)
    const a = acquireObjectLock(roomId, 'o1', 11)
    expect(a.ok).toBe(true)
    const b = acquireObjectLock(roomId, 'o1', 22)
    expect(b.ok).toBe(false)
    if (!b.ok) {
      expect(b.code).toBe('locked')
      expect((b as { holder?: number }).holder).toBe(11)
    }
  })

  it('same holder renews with same lockId', async () => {
    const roomId = await freshRoom()
    registerRoomObjects(roomId, 'hash1', ITEMS)
    const a = acquireObjectLock(roomId, 'o1', 11, 1000)
    expect(a.ok).toBe(true)
    if (!a.ok) return
    const a2 = acquireObjectLock(roomId, 'o1', 11, 2000)
    expect(a2).toMatchObject({ ok: true, lockId: a.lockId })
  })

  it('move without lockId is blocked when another holds the lock', async () => {
    const roomId = await freshRoom()
    registerRoomObjects(roomId, 'hash1', ITEMS)
    acquireObjectLock(roomId, 'o1', 11)
    const r = moveObject(roomId, 'o1', 22, { from: { row: 9 } }, 0)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('locked')
  })

  it('move with wrong lockId is rejected', async () => {
    const roomId = await freshRoom()
    registerRoomObjects(roomId, 'hash1', ITEMS)
    acquireObjectLock(roomId, 'o1', 11)
    const r = moveObject(roomId, 'o1', 22, { from: { row: 9 } }, 0, 'nope')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not_holder')
  })

  it('move without lockId grants an implicit lock when free', async () => {
    const roomId = await freshRoom()
    registerRoomObjects(roomId, 'hash1', ITEMS)
    const r = moveObject(roomId, 'o1', 22, { from: { row: 9 } }, 0)
    expect(r).toMatchObject({ ok: true, version: 1 })
    // 다른 사람이 바로 잡으려 하면 막힌다 (implicit lock 유효).
    const b = acquireObjectLock(roomId, 'o1', 33)
    expect(b.ok).toBe(false)
  })
})

describe('collab objects: lease + disconnect', () => {
  it('lease expires after ttl', async () => {
    const roomId = await freshRoom()
    registerRoomObjects(roomId, 'hash1', ITEMS)
    const a = acquireObjectLock(roomId, 'o1', 11, 1000)
    expect(a.ok).toBe(true)
    const b = acquireObjectLock(roomId, 'o1', 22, 1000 + 10_001)
    expect(b.ok).toBe(true)
  })

  it('removeConn releases locks held by that conn clientIds', async () => {
    const roomId = await freshRoom()
    const s = await createSession(NOTE_REL)
    expect(s.roomId).toBe(roomId)
    const w = sock()
    addConn(roomId, w)
    // wsMessage를 직접 import한다.
    const { wsMessage } = await import('../../src/services/collab-rooms')
    const doc = new Y.Doc()
    const aw = new awarenessProtocol.Awareness(doc)
    aw.setLocalState({ user: { name: 'A' } })
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, 1)
    encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(aw, [aw.clientID]))
    wsMessage(roomId, w, encoding.toUint8Array(e))
    const cid = aw.clientID
    registerRoomObjects(roomId, 'hash1', ITEMS)
    const a = acquireObjectLock(roomId, 'o1', cid)
    expect(a.ok).toBe(true)
    removeConn(roomId, w)
    const b = acquireObjectLock(roomId, 'o1', 999)
    expect(b.ok).toBe(true)
  })
})

describe('collab objects: version', () => {
  it('stale baseVersion is rejected with current state', async () => {
    const roomId = await freshRoom()
    registerRoomObjects(roomId, 'hash1', ITEMS)
    const r1 = moveObject(roomId, 'o1', 11, { from: { row: 9 } }, 0)
    expect(r1).toMatchObject({ ok: true, version: 1 })
    const r2 = moveObject(roomId, 'o2', 11, { from: { row: 3 } }, 0)
    expect(r2.ok).toBe(false)
    if (!r2.ok) {
      expect(r2.code).toBe('version_mismatch')
      expect(r2.version).toBe(1)
      expect(Array.isArray(r2.objects)).toBe(true)
    }
    const r3 = moveObject(roomId, 'o2', 11, { from: { row: 3 } }, 1)
    expect(r3).toMatchObject({ ok: true, version: 2 })
  })
})

describe('collab objects: reset + EMB guard', () => {
  it('orphan recreate drops the object table', async () => {
    const s1 = await createSession(NOTE_REL)
    registerRoomObjects(s1.roomId, 'hash1', ITEMS)
    acquireObjectLock(s1.roomId, 'o1', 11)
    const w = sock()
    addConn(s1.roomId, w)
    removeConn(s1.roomId, w)
    const s2 = await createSession(NOTE_REL)
    expect(s2.epoch).not.toBe(s1.epoch)
    const g = getRoomObjects(s2.roomId)
    expect(g).toMatchObject({ version: 0, objects: [] })
  })

  it('emb move/delete are rejected even solo', async () => {
    const roomId = await freshRoom()
    registerRoomObjects(roomId, 'hash1', [{ sheet: 0, kind: 'unsupported:object' }])
    const m = moveObject(roomId, 'o1', 11, { from: { row: 1 } }, 0)
    expect(m.ok).toBe(false)
    if (!m.ok) expect(m.code).toBe('emb_locked')
    const d = deleteObject(roomId, 'o1', 11, 0)
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.code).toBe('emb_locked')
  })

  it('GET returns version + order + objects', async () => {
    const s = await createSession(NOTE_REL)
    const roomId = s.roomId
    registerRoomObjects(roomId, s.lastHash, ITEMS)
    const g = getRoomObjects(roomId)
    expect(g).toMatchObject({ roomId, version: 0 })
    if ('objects' in g) {
      expect(g.objects).toHaveLength(2)
      expect(g.order).toEqual({ '0': ['o1', 'o2'] })
    }
  })
})
