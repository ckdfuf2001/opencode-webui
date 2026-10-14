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
  connMode,
  createSession,
  currentDiskHash,
  removeConn,
  resetCollabForTests,
  setRoomTtlMs,
  sweepRooms,
  handoff,
  hashBytes,
  isOwner,
  listRooms,
  lockInfo,
  markAiBlocked,
  normalizeAbs,
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
  it('first is host, second is guest, same room+epoch', async () => {
    const s1 = await createSession(NOTE_REL)
    const s2 = await createSession(NOTE_REL)
    expect(s1.roomId).toBe(s2.roomId)
    expect(s1.role).toBe('host')
    expect(s2.role).toBe('guest')
    expect(s1.epoch).toBe(s2.epoch)
    expect(s1.lastHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('missing file -> 404', async () => {
    await expect(createSession('repos/aaa/nope.txt')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('traversal -> 403', async () => {
    const outside = path.resolve(tmp, '..', 'outside.txt')
    await expect(createSession(outside)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('orphan room + fresh session disposes and recreates as host', async () => {
    const s1 = await createSession(NOTE_REL)
    // 붙었다 나간 고아 (everConnected=true, conns=0).
    const w = sock()
    addConn(s1.roomId, w)
    removeConn(s1.roomId, w)
    const s2 = await createSession(NOTE_REL)
    expect(s2.role).toBe('host')
    expect(s2.epoch).not.toBe(s1.epoch)
  })

  it('never-connected room + second session joins as guest (no race)', async () => {
    const s1 = await createSession(NOTE_REL)
    const s2 = await createSession(NOTE_REL)
    expect(s2.role).toBe('guest')
    expect(s2.epoch).toBe(s1.epoch)
  })

  it('live room + wrong epoch -> epoch_mismatch', async () => {
    const s1 = await createSession(NOTE_REL)
    addConn(s1.roomId, sock())
    await expect(
      createSession(NOTE_REL, { resumeEpoch: 'deadbeef', knownHash: s1.lastHash }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'epoch_mismatch' })
  })
})

describe('resume table', () => {
  it('same epoch rejoins (ownership comes from WS awareness, not session)', async () => {
    const s1 = await createSession(NOTE_REL)
    const r = await createSession(NOTE_REL, { resumeEpoch: s1.epoch, knownHash: s1.lastHash, clientId: 11 })
    expect(r.role).toBe('resume')
    expect(r.epoch).toBe(s1.epoch)
    expect(r.lastHash).toBe(s1.lastHash)
  })

  it('disk changed while away -> external_change (judged by server lastHash)', async () => {
    const s1 = await createSession(NOTE_REL)
    await fs.writeFile(path.join(tmp, NOTE_REL), 'outsider')
    await expect(
      createSession(NOTE_REL, { resumeEpoch: s1.epoch, knownHash: s1.lastHash }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'external_change' })
  })
})

describe('owner + save', () => {
  it('only owner saves; judgment is server lastHash (P0-2)', async () => {
    await createSession(NOTE_REL)
    const s = await createSession(NOTE_REL)
    const room = rooms.get(s.roomId)!
    const a = sock()
    const b = sock()
    addConn(s.roomId, a)
    addConn(s.roomId, b)
    room.ownerConn = a
    room.ownerIds.add(7)
    room.conns.get(a)!.clientIds.add(7)
    room.seeded = true
    expect(isOwner(room, 7)).toBe(true)
    expect(isOwner(room, 8)).toBe(false)

    expect(checkSave(s.roomId, 8, 10)).toMatchObject({ ok: false, status: 409, code: 'not_owner' })
    expect(checkSave(s.roomId, 7, 10)).toMatchObject({ ok: true })

    // owner 저장 후 승계된 쪽은 stale baseHash 없이도 저장된다 (서버 lastHash 기준).
    const applied = await applySave(s.roomId, new TextEncoder().encode('hello v2'))
    expect('newHash' in applied).toBe(true)
    expect(await currentDiskHash(s.roomId)).toBe(hashBytes(new TextEncoder().encode('hello v2')))
    // 같은 내용 또 저장해도 lastHash 일치로 통과한다.
    const again = await applySave(s.roomId, new TextEncoder().encode('hello v2'))
    expect('newHash' in applied && 'newHash' in again).toBe(true)

    // 외부 변경 후 저장은 conflict.
    await fs.writeFile(path.join(tmp, NOTE_REL), 'outsider')
    const conflicted = await applySave(s.roomId, new TextEncoder().encode('late'))
    expect('conflict' in conflicted).toBe(true)
  })

  it('save before seed -> not_seeded (P1-1)', async () => {
    const s = await createSession(NOTE_REL)
    const room = rooms.get(s.roomId)!
    const a = sock()
    addConn(s.roomId, a)
    room.ownerConn = a
    room.ownerIds.add(7)
    expect(checkSave(s.roomId, 7, 10)).toMatchObject({ ok: false, status: 409, code: 'not_seeded' })
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
    room.ownerConn = a
    room.ownerIds.add(7)
    room.conns.get(a)!.clientIds.add(7)
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
    room.ownerConn = a
    room.ownerIds.add(7)
    removeConn(roomId, a)
    expect(isOwner(room, 9)).toBe(true)
    expect(room.conns.has(a)).toBe(false)
  })

  it('empty room lingers for TTL then disposes (P1-3)', async () => {
    setRoomTtlMs(100)
    const { roomId } = await createSession(NOTE_REL)
    const a = sock()
    addConn(roomId, a)
    removeConn(roomId, a)
    expect(rooms.has(roomId)).toBe(true)
    await new Promise((r) => setTimeout(r, 150))
    sweepRooms()
    expect(rooms.has(roomId)).toBe(false)
  })
})

describe('lock + external watch', () => {
  it('inactive without conns, active with conns (no per-poll hash)', async () => {
    const before = await lockInfo(NOTE_REL)
    expect(before).toMatchObject({ active: false })
    const { roomId, epoch } = await createSession(NOTE_REL)
    addConn(roomId, sock())
    const during = await lockInfo(NOTE_REL)
    expect(during).toMatchObject({ active: true, roomId, epoch })
    expect(typeof during.lastHash).toBe('string')
    expect('diskHash' in during).toBe(false)
  })

  it('external change flips the flag; save then conflicts (P0-2)', async () => {
    await createSession(NOTE_REL)
    const s = await createSession(NOTE_REL)
    addConn(s.roomId, sock())
    const before = await fs.readFile(path.join(tmp, NOTE_REL))
    // 외부에서 직접 쓰기 (우리 save 경로가 아님) — 반드시 기존 내용과 다르게.
    await fs.writeFile(path.join(tmp, NOTE_REL), `outsider-${Date.now()}`)
    for (let i = 0; i < 40; i++) {
      const info = await lockInfo(NOTE_REL)
      if (info.externalChanged) break
      await new Promise((r) => setTimeout(r, 250))
      if (i === 39) throw new Error('external change not detected')
    }
    // 외부 변경 뒤 저장은 conflict (자동 병합 없음).
    const conflicted = await applySave(s.roomId, new TextEncoder().encode('late'))
    expect('conflict' in conflicted).toBe(true)
    // 원복 후 저장하면 성공하고 플래그가 꺼진다.
    await fs.writeFile(path.join(tmp, NOTE_REL), before)
    const applied = await applySave(s.roomId, new Uint8Array(before))
    expect('newHash' in applied).toBe(true)
    const after = await lockInfo(NOTE_REL)
    expect(after.externalChanged).toBe(false)
  })

  it('normalizeAbs is used for indexing', async () => {
    const { roomId } = await createSession(NOTE_REL)
    expect(roomId).toBe(roomIdForAbs(path.join(tmp, NOTE_REL)))
    expect(normalizeAbs('A\\B')).toBe(normalizeAbs('a/b'))
  })

  it('lock carries seeded flag (S1 client rule)', async () => {
    const { roomId } = await createSession(NOTE_REL)
    addConn(roomId, sock())
    const info = await lockInfo(NOTE_REL)
    expect(info).toMatchObject({ active: true, seeded: false })
  })
})

describe('view-mode rules (V5)', () => {
  it('view-only room: no election, lock inactive', async () => {
    const { roomId } = await createSession(NOTE_REL)
    const room = rooms.get(roomId)!
    const a = sock()
    addConn(roomId, a)
    room.conns.get(a)!.clientIds.add(41)
    const states = room.awareness.getStates() as Map<number, unknown>
    states.set(41, { app: { id: 'v1', name: 'Grace', color: '#000', mode: 'view' } })
    expect(connMode(room, a)).toBe('view')
    expect(room.ownerConn).toBe(null)
    const info = await lockInfo(NOTE_REL)
    expect(info.active).toBe(false)
    // view-only room도 참가자바용 participants는 돌려준다.
    expect(info.participants).toEqual([
      { id: 'v1', name: 'Grace', color: '#000', mode: 'view', slide: undefined, owner: false },
    ])
  })

  it('unknown mode defaults to eligible editor', async () => {
    const { roomId } = await createSession(NOTE_REL)
    const room = rooms.get(roomId)!
    const a = sock()
    addConn(roomId, a)
    room.conns.get(a)!.clientIds.add(42)
    expect(connMode(room, a)).toBe('edit')
    const info = await lockInfo(NOTE_REL)
    expect(info.active).toBe(true)
  })

  it('participants list reads awareness app fields (read-only)', async () => {
    const { roomId } = await createSession(NOTE_REL)
    addConn(roomId, sock())
    const empty = await lockInfo(NOTE_REL)
    expect(empty.participants ?? []).toEqual([])
    expect(empty.active).toBe(true)
    const room = rooms.get(roomId)!
    const states = room.awareness.getStates() as Map<number, unknown>
    states.set(7, { app: { id: 'u1', name: 'Ada', color: '#e11d48', mode: 'edit' } })
    const full = await lockInfo(NOTE_REL)
    expect(full.participants).toEqual([
      { id: 'u1', name: 'Ada', color: '#e11d48', mode: 'edit', slide: undefined, owner: false },
    ])
  })

  it('markAiBlocked records timestamp', async () => {
    const { roomId } = await createSession(NOTE_REL)
    addConn(roomId, sock())
    markAiBlocked(roomId)
    const room = rooms.get(roomId)!
    expect(typeof room.aiBlockedAt).toBe('number')
    // lock 응답에 그대로 노출된다 (E10 칩용).
    const info = await lockInfo(NOTE_REL)
    expect(info.aiBlockedAt).toBe(room.aiBlockedAt)
  })

  it('listRooms exposes active rooms', async () => {
    expect(listRooms()).toEqual([])
    const { roomId } = await createSession(NOTE_REL)
    addConn(roomId, sock())
    const list = listRooms()
    expect(list.length).toBe(1)
    expect(list[0].roomId).toBe(roomId)
    expect(list[0].rel).toBe('repos/aaa/note.txt')
    expect(Array.isArray(list[0].participants)).toBe(true)
  })

  it('concurrent saves serialize to a consistent state (S6C)', async () => {
    const { roomId } = await createSession(NOTE_REL)
    const room = rooms.get(roomId)!
    room.seeded = true
    const a = new TextEncoder().encode('aaa')
    const b = new TextEncoder().encode('bbb')
    const [r1, r2] = await Promise.all([applySave(roomId, a), applySave(roomId, b)])
    // 직렬화되므로 둘 다 성공하고, 최종 상태는 일관된다.
    expect('newHash' in r1 && 'newHash' in r2).toBe(true)
    const disk = await currentDiskHash(roomId)
    expect(disk).toBe(room.lastHash)
    const content = await fs.readFile(path.join(tmp, NOTE_REL), 'utf8')
    expect(['aaa', 'bbb']).toContain(content)
    // 그 뒤 외부 변경이 끼면 다음 저장은 conflict다.
    await fs.writeFile(path.join(tmp, NOTE_REL), 'outsider')
    const conflicted = await applySave(roomId, new TextEncoder().encode('late'))
    expect('conflict' in conflicted).toBe(true)
  })
})
