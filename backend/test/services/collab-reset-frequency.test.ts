import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import JSZip from 'jszip'

// files.ts가 모듈 로드 시점에 WORKSPACE_PATH를 캡처하므로 적재 import보다 먼저 env를 깐다.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'collabresetfreq-'))
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
  resetCollabForTests,
  resetRoomByServer,
  resetStats,
  rooms,
} = await import('../../src/services/collab-rooms')

const hostAbs = (...p: string[]) => path.join(tmp, ...p)

async function partBytesWithMark(hostFile: string, part: string, mark: string): Promise<Uint8Array> {
  const buf = await fs.readFile(hostFile)
  const zip = await JSZip.loadAsync(buf)
  const f = zip.file(part)
  if (!f) throw new Error('part missing: ' + part)
  const inner = await JSZip.loadAsync(await f.async('uint8array'))
  const name = 'word/document.xml'
  const cur = await inner.file(name)!.async('string')
  const next = cur.replace(/C5-0 payload|P0X3E\d/, mark)
  if (next === cur) throw new Error('fixture changed: no part anchor text')
  inner.file(name, next)
  return new Uint8Array(await inner.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
}

beforeEach(() => {
  resetCollabForTests()
})

afterEach(() => {
  resetCollabForTests()
})

describe('P0-3 reset frequency', () => {
  it('무접속 방 리셋은 건너뛴다 (방 유지 + 카운터 미증가)', async () => {
    const sPart = await createSession(HOST_REL, { part: PART })
    const partRoom = rooms.get(sPart.roomId)!
    // 부모 방을 만든 뒤 접속자를 붙이지 않는다.
    const sParent = await createSession(HOST_REL)
    const before = rooms.get(sParent.roomId)!
    expect(before.conns.size).toBe(0)
    const eBytes = await partBytesWithMark(hostAbs(HOST_REL), PART, 'P0X3E0')
    const r = await applySave(sPart.roomId, eBytes, {
      kind: partRoom.kind,
      baseHash: sPart.lastHash,
      clientId: 7,
    })
    expect('newHash' in r).toBe(true)
    // 리셋 대신 lastHash만 adopt하고 방 객체를 유지한다.
    expect(rooms.get(sParent.roomId)).toBe(before)
    expect(resetStats(sParent.roomId)?.total ?? 0).toBe(0)
  })

  it('접속 중 리셋은 카운터에 잡힌다 (total/disruptive)', async () => {
    const s = await createSession(HOST_REL)
    const room = rooms.get(s.roomId)!
    room.conns.set({} as never, {
      joinedAt: Date.now(),
      clientIds: new Set([1]),
      lastMsgAt: Date.now(),
    } as never)
    const out = resetRoomByServer(s.roomId)
    expect(out).toEqual({ ok: true })
    expect(rooms.get(s.roomId)).toBeUndefined()
    expect(resetStats(s.roomId)).toMatchObject({ total: 1, disruptive: 1 })
  })
})
