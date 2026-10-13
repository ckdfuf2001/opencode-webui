import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'

// files.ts/shared가 모듈 로드 시점에 WORKSPACE_PATH를 캡처하므로
// 정적 import보다 먼저 env를 깔는다.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'collabrooms-'))
process.env.WORKSPACE_PATH = tmp

const NOTE_REL = path.join('repos', 'aaa', 'note.txt')
await fs.mkdir(path.join(tmp, 'repos', 'aaa'), { recursive: true })
await fs.writeFile(path.join(tmp, NOTE_REL), 'hello')

const {
  addConn,
  applySave,
  checkSave,
  createSession,
  currentDiskHash,
  removeConn,
  handoff,
  hashBytes,
  isOwner,
  lockInfo,
  normalizeAbs,
  resetCollabForTests,
  roomIdForAbs,
  rooms,
} = await import('../../src/services/collab-rooms')

const sock = () => ({ send(_d: Uint8Array) {} })

beforeEach(() => {
  resetCollabForTests()
})

afterEach(() => {
  resetCollabForTests()
})

describe('collab room id', () => {
  it('f_ + 40 hex, stable, no mtime', () => {
    const abs = path.join(tmp, NOTE_REL)
    const a = roomIdForAbs(abs)
    expect(a).toMatch(/^f_[0-9a-f]{40}$/)
    expect(roomIdForAbs(abs)).toBe(a)
    expect(roomIdForAbs(abs.toUpperCase())).toBe(a)
  })
})

describe('session', () => {
  it('first is host, second is guest, same room', async () => {
    const s1 = await createSession(NOTE_REL)
    const s2 = await createSession(NOTE_REL)
    expect(s1.roomId).toBe(s2.roomId)
    expect(s1.role).toBe('host')
    expect(s2.role).toBe('guest')
    expect(s1.fileHash).toBe(s2.fileHash)
    expect(s1.fileHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('missing file -> 404', async () => {
    await expect(createSession('repos/aaa/nope.txt')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('traversal -> 403', async () => {
    const outside = path.resolve(tmp, '..', 'outside.txt')
    await expect(createSession(outside)).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('owner + save', () => {
  it('first conn owns; only owner saves; stale baseHash conflicts', async () => {
    const { roomId, fileHash } = await createSession(NOTE_REL)
    const room = rooms.get(roomId)!
    const a = sock()
    const b = sock()
    addConn(roomId, a)
    addConn(roomId, b)
    // awareness 도착 전이므로 ownerIds를 직접 심는다 (WS 경로는 릴레이 테스트에서 검증).
    room.ownerIds.add(7)
    expect(isOwner(room, 7)).toBe(true)
    expect(isOwner(room, 8)).toBe(false)

    expect(checkSave(roomId, 8, 10)).toMatchObject({ ok: false, status: 409 })
    expect(checkSave(roomId, 7, 10)).toMatchObject({ ok: true })

    const next = new TextEncoder().encode('hello v2')
    const applied = await applySave(roomId, fileHash, next)
    expect('newHash' in applied).toBe(true)
    expect(await currentDiskHash(roomId)).toBe(hashBytes(next))

    const stale = await applySave(roomId, fileHash, new TextEncoder().encode('stale'))
    expect('conflict' in stale).toBe(true)
  })

  it('unknown room -> 404', () => {
    expect(checkSave('f_' + '0'.repeat(40), 1, 1)).toMatchObject({ ok: false, status: 404 })
  })
})

describe('handoff', () => {
  it('owner transfers; non-owner and offline target rejected', async () => {
    const { roomId } = await createSession(NOTE_REL)
    const room = rooms.get(roomId)!
    const a = sock()
    const b = sock()
    addConn(roomId, a)
    addConn(roomId, b)
    room.ownerIds.add(7)
    // b의 clientId를 등록 (awareness 도착 시뮬레이션)
    room.conns.get(b)!.clientIds.add(9)

    expect(handoff(roomId, 8, 9)).toMatchObject({ ok: false, status: 409 })
    expect(handoff(roomId, 7, 10)).toMatchObject({ ok: false, status: 409 })
    const ok = handoff(roomId, 7, 9)
    expect(ok).toMatchObject({ ok: true })
    expect(isOwner(room, 9)).toBe(true)
    expect(isOwner(room, 7)).toBe(false)
  })

  it('owner conn drop promotes earliest remaining', async () => {
    const { roomId } = await createSession(NOTE_REL)
    const room = rooms.get(roomId)!
    const a = sock()
    const b = sock()
    addConn(roomId, a)
    addConn(roomId, b)
    room.conns.get(a)!.clientIds.add(7)
    room.conns.get(b)!.clientIds.add(9)
    room.ownerIds.add(7)
    removeConn(roomId, a)
    expect(isOwner(room, 9)).toBe(true)
    expect(room.conns.has(a)).toBe(false)
  })

  it('last conn out disposes the room', async () => {
    const { roomId } = await createSession(NOTE_REL)
    const a = sock()
    addConn(roomId, a)
    removeConn(roomId, a)
    expect(rooms.has(roomId)).toBe(false)
  })
})

describe('lock + external watch', () => {
  it('inactive without conns, active with conns', async () => {
    const before = await lockInfo(NOTE_REL)
    expect(before).toMatchObject({ active: false })
    const { roomId } = await createSession(NOTE_REL)
    addConn(roomId, sock())
    const during = await lockInfo(NOTE_REL)
    expect(during).toMatchObject({ active: true, roomId })
  })

  it('external change flips the flag (own saves ignored)', async () => {
    const { roomId, fileHash } = await createSession(NOTE_REL)
    addConn(roomId, sock())
    // 외부에서 직접 쓰기 (우리 save 경로가 아님)
    await fs.writeFile(path.join(tmp, NOTE_REL), 'outsider')
    for (let i = 0; i < 40; i++) {
      const info = await lockInfo(NOTE_REL)
      if (info.externalChanged) break
      await new Promise((r) => setTimeout(r, 250))
      if (i === 39) throw new Error('external change not detected')
    }
    // 우리 저장은 플래그를 끈다
    const disk = await currentDiskHash(roomId)
    const applied = await applySave(roomId, disk!, new TextEncoder().encode('owner v3'))
    expect('newHash' in applied).toBe(true)
    const after = await lockInfo(NOTE_REL)
    expect(after.externalChanged).toBe(false)
    expect(fileHash).not.toBe((applied as { newHash: string }).newHash)
  })

  it('normalizeAbs is used for indexing', async () => {
    const { roomId } = await createSession(NOTE_REL)
    expect(roomId).toBe(roomIdForAbs(path.join(tmp, NOTE_REL)))
    expect(normalizeAbs('A\\B')).toBe(normalizeAbs('a/b'))
  })
})
