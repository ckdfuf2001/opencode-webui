import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import JSZip from 'jszip'

// files.ts가 모듈 로드 시점에 WORKSPACE_PATH를 캡처하므로 정적 import보다 먼저 env를 깐다.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'collabparts-'))
process.env.WORKSPACE_PATH = tmp

const SEED_DIR = path.join(tmp, 'repos', 'pp')
await fs.mkdir(SEED_DIR, { recursive: true })
const FIX_HOST = path.resolve('..', 'e2e/collab/fixtures/ole/embed-docx.pptx')
await fs.copyFile(FIX_HOST, path.join(SEED_DIR, 'host.pptx'))
const HOST_REL = path.join('repos', 'pp', 'host.pptx')
const PART = 'ppt/embeddings/Microsoft_Word_Document.docx'

const {
  applySave,
  createSession,
  currentDiskHash,
  listRooms,
  resetCollabForTests,
  roomIdForAbs,
  roomIdForPart,
  rooms,
} = await import('../../src/services/collab-rooms')

const hostAbs = (...p: string[]) => path.join(tmp, ...p)

async function readPart(hostFile: string, part: string): Promise<Buffer> {
  const buf = await fs.readFile(hostFile)
  const zip = await JSZip.loadAsync(buf)
  const f = zip.file(part)
  if (!f) throw new Error('part missing: ' + part)
  return Buffer.from(await f.async('uint8array'))
}

beforeEach(() => {
  resetCollabForTests()
})

afterEach(() => {
  resetCollabForTests()
})

describe('part room id', () => {
  it('f_ + 40 hex, stable, part별·부모별 분리', async () => {
    const abs = hostAbs(HOST_REL)
    const a = roomIdForPart(abs, PART)
    expect(a).toMatch(/^f_[0-9a-f]{40}$/)
    expect(roomIdForPart(abs, PART)).toBe(a)
    // 부모 파일 방과 다르다.
    expect(a).not.toBe(roomIdForAbs(abs))
    // 파트가 다르면 다르다.
    expect(roomIdForPart(abs, 'ppt/embeddings/other.docx')).not.toBe(a)
  })
})

describe('part session', () => {
  it('host/guest 같은 방, lastHash는 파트 바이트 기준', async () => {
    const s1 = await createSession(HOST_REL, { part: PART })
    const partBytes = await readPart(hostAbs(HOST_REL), PART)
    const { createHash } = await import('node:crypto')
    const partHash = createHash('sha256').update(partBytes).digest('hex')
    expect(s1.roomId).toBe(roomIdForPart(hostAbs(HOST_REL), PART))
    expect(s1.role).toBe('host')
    expect(s1.lastHash).toBe(partHash)
    const room = rooms.get(s1.roomId)
    expect(room?.part).toMatchObject({ part: PART })
    expect(room?.kind).toBe('docx')
    const s2 = await createSession(HOST_REL, { part: PART })
    expect(s2.roomId).toBe(s1.roomId)
    expect(s2.role).toBe('guest')
    expect(s2.epoch).toBe(s1.epoch)
  })

  it('없는 파트는 404', async () => {
    await expect(createSession(HOST_REL, { part: 'ppt/embeddings/nope.docx' })).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  it('strict + 틀린 knownHash는 stale_client', async () => {
    await createSession(HOST_REL, { part: PART })
    const s = await createSession(HOST_REL, { part: PART, strict: true, knownHash: '0'.repeat(64) })
    expect(s.stale).toBe(true)
    expect(s.code).toBe('stale_client')
  })

  it('listRooms에 part가 표시된다', async () => {
    const s = await createSession(HOST_REL, { part: PART })
    const { addConn } = await import('../../src/services/collab-rooms')
    addConn(s.roomId, { send(_d: Uint8Array) {} })
    const all = await listRooms()
    const hit = all.find((r) => r.roomId === roomIdForPart(hostAbs(HOST_REL), PART))
    expect(hit?.part).toBe(PART)
  })
})

describe('part save', () => {
  it('파트 교체 + 부모 방 adopt', async () => {
    const s1 = await createSession(HOST_REL, { part: PART })
    const partBytes = await readPart(hostAbs(HOST_REL), PART)
    // docx 파트 끝에 공백을 덧붙인다 (유효한 zip 유지).
    const zip = await JSZip.loadAsync(partBytes)
    zip.file('word/part-stamp.txt', `stamp-${Date.now()}`)
    const next = Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
    const saved = await applySave(s1.roomId, new Uint8Array(next), { baseHash: s1.lastHash, kind: 'docx' })
    expect((saved as { newHash?: string }).newHash).toMatch(/^[0-9a-f]{64}$/)
    // 디스크 부모의 파트가 바뀌었다.
    const after = await readPart(hostAbs(HOST_REL), PART)
    expect(Buffer.from(after).equals(next)).toBe(true)
    // 파트 방 lastHash가 새 파트 해시로 갱신됐다.
    const room = rooms.get(s1.roomId)
    const { createHash } = await import('node:crypto')
    expect(room?.lastHash).toBe(createHash('sha256').update(next).digest('hex'))
    // currentDiskHash(파트 기준)도 새 해시와 같다.
    expect(await currentDiskHash(s1.roomId)).toBe(room?.lastHash)
  })

  it('baseHash가 방과 다르면 conflict_room', async () => {
    const s1 = await createSession(HOST_REL, { part: PART })
    const partBytes = await readPart(hostAbs(HOST_REL), PART)
    const r = await applySave(s1.roomId, new Uint8Array(partBytes), { baseHash: 'f'.repeat(64), kind: 'docx' })
    expect(r).toMatchObject({ conflict: true, code: 'conflict_room' })
  })

  it('파트 저장하면 열린 부모 방이 adopt된다 (PUT 동일)', async () => {
    const parent = await createSession(HOST_REL)
    const before = parent.lastHash
    const s1 = await createSession(HOST_REL, { part: PART })
    const partBytes = await readPart(hostAbs(HOST_REL), PART)
    const zip = await JSZip.loadAsync(partBytes)
    zip.file('word/part-stamp2.txt', `stamp-${Date.now()}`)
    const next = Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
    const saved = await applySave(s1.roomId, new Uint8Array(next), { baseHash: s1.lastHash, kind: 'docx' })
    expect((saved as { newHash?: string }).newHash).toMatch(/^[0-9a-f]{64}$/)
    // 부모 방 lastHash가 새 부모 해시로 adopt됐다.
    // P0-3: 접속자가 없으면 리셋 대신 방을 유지한다 (lastHash adopt는 동일).
    const proom = rooms.get(parent.roomId)
    expect(proom).toBeTruthy()
    expect(proom!.lastHash).not.toBe(before)
    expect(await currentDiskHash(parent.roomId)).toBe(proom!.lastHash)
    // 부모 파일에 새 파트가 들어있다.
    const after = await readPart(hostAbs(HOST_REL), PART)
    const z2 = await JSZip.loadAsync(after)
    expect(z2.file('word/part-stamp2.txt')).not.toBeNull()
  })
})
