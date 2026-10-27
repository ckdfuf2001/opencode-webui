import { describe, it, expect, beforeEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'

// X2a ①: 서버 participants 가 app 키와 lib presence 키 두 가지를 읽는다.
// 기존 collab-rooms.test.ts 와 같은 방식으로 임시 워크스페이스를 쓴다.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'collabpart-'))
process.env.WORKSPACE_PATH = tmp

const TXT_REL = path.join('repos', 'aaa', 'note.txt')
const XLSX_REL = path.join('repos', 'aaa', 'book.xlsx')
await fs.mkdir(path.join(tmp, 'repos', 'aaa'), { recursive: true })
await fs.writeFile(path.join(tmp, TXT_REL), 'hello')
await fs.writeFile(path.join(tmp, XLSX_REL), 'xlsx-bytes')

const { addConn, applySave, connMode, createSession, resetCollabForTests, roomParticipants, rooms } = await import(
  '../../src/services/collab-rooms'
)

const sock = () => ({ send(_d: Uint8Array) {} })

/** 연결 하나에 awareness 상태 하나를 붙인다(실제 WS 없이 방 내부 상태만 채운다). */
function attach(roomId: string, ws: unknown, cid: number, state: Record<string, unknown>) {
  const room = addConn(roomId, ws)!
  room.conns.get(ws)!.clientIds.add(cid)
  room.awareness.getStates().set(cid, state as never)
  return room
}

beforeEach(() => {
  resetCollabForTests()
})

describe('roomParticipants: app 키와 presence 키', () => {
  it('app 키만 있으면 그대로 1명', async () => {
    const s = await createSession(TXT_REL)
    const ws = sock()
    const room = attach(s.roomId, ws, 11, { app: { id: 'ada', name: 'Ada', color: '#f00', mode: 'edit' } })
    expect(roomParticipants(room)).toMatchObject([{ id: 'ada', name: 'Ada', mode: 'edit' }])
  })

  it('presence 키만 있으면(xlsx lib) 1명, 이름·색·userId 를 읽는다', async () => {
    const s = await createSession(TXT_REL)
    const room = attach(s.roomId, sock(), 21, {
      presence: { userName: 'Grace', userColor: '#0f0', role: 'collaborator', userId: 'u-grace' },
    })
    expect(roomParticipants(room)).toMatchObject([
      { id: 'u-grace', name: 'Grace', color: '#0f0', mode: 'edit', userId: 'u-grace', owner: false },
    ])
  })

  it('둘 다 있으면 같은 clientId 는 app 쪽을 쓰고 1명으로 센다', async () => {
    const s = await createSession(TXT_REL)
    const room = attach(s.roomId, sock(), 31, {
      app: { id: 'ada', name: 'Ada', color: '#f00', mode: 'edit' },
      presence: { userName: 'Lib Name', userColor: '#00f', role: 'collaborator' },
    })
    const ps = roomParticipants(room)
    expect(ps).toHaveLength(1)
    expect(ps[0]).toMatchObject({ name: 'Ada', mode: 'edit' })
  })

  it('형식이 틀린 presence 는 무시한다(userName 없음, 객체 아님)', async () => {
    const s = await createSession(TXT_REL)
    const room = attach(s.roomId, sock(), 41, { presence: { userColor: '#0f0' } })
    attach(s.roomId, sock(), 42, { presence: 'not-an-object' })
    expect(roomParticipants(room)).toHaveLength(0)
  })

  it('같은 userId 는 탭이 달라도 1명으로 센다, userId 없으면 clientId 별로 센다', async () => {
    const s = await createSession(TXT_REL)
    attach(s.roomId, sock(), 51, { presence: { userName: 'Ada', userColor: '#f00', userId: 'u-ada' } })
    const room = attach(s.roomId, sock(), 52, { presence: { userName: 'Ada', userColor: '#f00', userId: 'u-ada' } })
    attach(s.roomId, sock(), 53, { presence: { userName: 'Ada', userColor: '#f00' } })
    attach(s.roomId, sock(), 54, { presence: { userName: 'Ada', userColor: '#f00' } })
    // userId 2건 → 1명, userId 없음 2건 → 각각 1명씩(합계 3)
    expect(roomParticipants(room)).toHaveLength(3)
  })

  it('같은 userId 가 edit 탭과 view 탭으로 공존하면 합친 mode 는 edit', async () => {
    const s = await createSession(TXT_REL)
    // view 탭을 먼저 넣어도, edit 탭을 나중에 넣어도 결과는 edit 이어야 한다.
    attach(s.roomId, sock(), 111, { presence: { userName: 'Ada', userColor: '#f00', role: 'viewer', userId: 'u-ada' } })
    const room = attach(s.roomId, sock(), 112, {
      presence: { userName: 'Ada', userColor: '#f00', role: 'collaborator', userId: 'u-ada' },
    })
    const ps = roomParticipants(room)
    expect(ps).toHaveLength(1)
    expect(ps[0]).toMatchObject({ id: 'u-ada', mode: 'edit' })
  })

  it('role=viewer 면 mode=view', async () => {
    const s = await createSession(TXT_REL)
    const room = attach(s.roomId, sock(), 61, { presence: { userName: 'Bob', userColor: '#999', role: 'viewer' } })
    expect(roomParticipants(room)).toMatchObject([{ name: 'Bob', mode: 'view' }])
  })
})

describe('connMode: role 기반', () => {
  it('viewer presence 만 있는 연결은 view', async () => {
    const s = await createSession(TXT_REL)
    const ws = sock()
    const room = attach(s.roomId, ws, 71, { presence: { userName: 'Bob', userColor: '#999', role: 'viewer' } })
    expect(connMode(room, ws)).toBe('view')
  })

  it('collaborator presence 연결은 edit', async () => {
    const s = await createSession(TXT_REL)
    const ws = sock()
    const room = attach(s.roomId, ws, 81, { presence: { userName: 'Ada', userColor: '#f00', role: 'collaborator' } })
    expect(connMode(room, ws)).toBe('edit')
  })
})

describe('xlsx 저장: viewer 거부', () => {
  it('clientId 가 viewer 면 403 view_only', async () => {
    const s = await createSession(XLSX_REL)
    const room = attach(s.roomId, sock(), 91, { presence: { userName: 'Bob', userColor: '#999', role: 'viewer' } })
    await expect(
      applySave(s.roomId, new Uint8Array([1, 2, 3]), { kind: 'xlsx', baseHash: room.lastHash, clientId: 91 }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'view_only' })
  })

  it('clientId 가 collaborator 면 저장된다', async () => {
    const s = await createSession(XLSX_REL)
    const room = attach(s.roomId, sock(), 101, { presence: { userName: 'Ada', userColor: '#f00', role: 'collaborator' } })
    const r = await applySave(s.roomId, new Uint8Array([1, 2, 3]), {
      kind: 'xlsx',
      baseHash: room.lastHash,
      clientId: 101,
    })
    expect(r).toHaveProperty('newHash')
    expect(rooms.get(s.roomId)).toBeTruthy()
  })
})
