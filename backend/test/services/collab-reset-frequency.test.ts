import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'

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
  currentDiskHash,
  resetCollabForTests,
  resetRoomByServer,
  resetStats,
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

async function partBytesWithMark(hostFile: string, part: string, mark: string): Promise<Uint8Array> {
  const inner = await JSZip.loadAsync(await readPart(hostFile, part))
  const name = 'word/document.xml'
  const cur = await inner.file(name)!.async('string')
  const next = cur.replace(/C5-0 payload|P0X4[A-Z0-9]*/, mark)
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
  it('무접속 방 리셋도 dispose한다 (집계에서만 제외)', async () => {
    const sParent = await createSession(HOST_REL)
    expect(rooms.get(sParent.roomId)!.conns.size).toBe(0)
    const sPart = await createSession(HOST_REL, { part: PART })
    const eBytes = await partBytesWithMark(hostAbs(HOST_REL), PART, 'P0X4A0')
    const r = await applySave(sPart.roomId, eBytes, {
      kind: rooms.get(sPart.roomId)!.kind,
      baseHash: sPart.lastHash,
      clientId: 7,
    })
    expect('newHash' in r).toBe(true)
    // 예전 동작: 접속자가 없어도 방은 해체한다. 카운터에는 잡히지 않는다.
    expect(rooms.get(sParent.roomId)).toBeUndefined()
    expect(resetStats(sParent.roomId)).toBeNull()
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

  it('부모 닫음 → 첨부 저장 → 재입장: 파트가 보이고 낡은 owner 자동저장은 막힌다', async () => {
    // 부모 세션만 있고 접속자는 없다 (닫힌 부모 방이 TTL 안에 남아 있는 상태).
    const sParent = await createSession(HOST_REL)
    expect(rooms.get(sParent.roomId)!.conns.size).toBe(0)
    const sPart = await createSession(HOST_REL, { part: PART })
    const partRoom = rooms.get(sPart.roomId)!
    const eBytes = await partBytesWithMark(hostAbs(HOST_REL), PART, 'P0X4B0')
    const r = await applySave(sPart.roomId, eBytes, {
      kind: partRoom.kind,
      baseHash: sPart.lastHash,
      clientId: 7,
    })
    expect('newHash' in r).toBe(true)
    // 30초 안에 부모를 다시 열면 새 방이 디스크 기준으로 시드된다 (첨부 보임).
    const re = await createSession(HOST_REL)
    expect(re.lastHash).toBe(await currentDiskHash(re.roomId))
    const after = await readPart(hostAbs(HOST_REL), PART)
    const inner = await JSZip.loadAsync(after)
    const doc = (await inner.file('word/document.xml')!.async('string')).replace(/<[^>]*>/g, '')
    expect(doc).toContain('P0X4B0')
    // 옛 바이트를 든 owner 자동저장(낡은 baseHash)은 막힌다 → 첨부 유지.
    const staleBase = sParent.lastHash
    const hostBytes = await fs.readFile(hostAbs(HOST_REL))
    const zip = await JSZip.loadAsync(hostBytes)
    const slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
    zip.file('ppt/slides/slide1.xml', slide.replace(/C5-0 host|P0X4[A-Z0-9]*/, 'P0X4STALE'))
    const staleBytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
    const r2 = await applySave(re.roomId, staleBytes, {
      kind: rooms.get(re.roomId)!.kind,
      baseHash: staleBase,
      clientId: 9,
    })
    expect('conflict' in r2).toBe(true)
    const after2 = await readPart(hostAbs(HOST_REL), PART)
    const inner2 = await JSZip.loadAsync(after2)
    const doc2 = (await inner2.file('word/document.xml')!.async('string')).replace(/<[^>]*>/g, '')
    expect(doc2).toContain('P0X4B0')
  })
})
