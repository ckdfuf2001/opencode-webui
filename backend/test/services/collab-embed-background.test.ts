import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import JSZip from 'jszip'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

// files.ts가 모듈 로드 시점에 WORKSPACE_PATH를 캡처하므로 적재 import보다 먼저 env를 깐다.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'collabembedbg-'))
process.env.WORKSPACE_PATH = tmp

const SEED_DIR = path.join(tmp, 'repos', 'pp')
await fs.mkdir(SEED_DIR, { recursive: true })
const FIX_HOST = path.resolve('..', 'e2e/collab/fixtures/ole/embed-docx.pptx')
await fs.copyFile(FIX_HOST, path.join(SEED_DIR, 'host.pptx'))
const HOST_REL = path.join('repos', 'pp', 'host.pptx')

const {
  MSG_PART_EMBEDDED,
  applySave,
  createSession,
  hashBytes,
  registerEmbedInsert,
  resetCollabForTests,
  rooms,
} = await import('../../src/services/collab-rooms')

const { assemblePptxEmbed, readEmbedPart } = await import('../../src/services/office-embed')

const zipLoad = async (b: Uint8Array) => (await JSZip.loadAsync(b)) as unknown as Parameters<typeof assemblePptxEmbed>[0]

const hostAbs = (...p: string[]) => path.join(tmp, ...p)

function parentTyping(roomId: string, mark: string, origin: unknown): void {
  const room = rooms.get(roomId)!
  const tmpDoc = new Y.Doc()
  tmpDoc.getMap('t').set(`k-${mark}`, mark)
  Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(tmpDoc), origin)
}

beforeEach(() => {
  resetCollabForTests()
})

afterEach(() => {
  resetCollabForTests()
})

describe('C7: 백그라운드 삽입 (리셋 없이 106 + 저장 병합)', () => {
  it('registerEmbedInsert는 전원에게 106을 방송한다', async () => {
    const sParent = await createSession(HOST_REL)
    const room = rooms.get(sParent.roomId)!
    const fakeA = { send: (_b: unknown) => {} }
    room.conns.set(fakeA, { joinedAt: Date.now(), clientIds: new Set([1]), lastMsgAt: Date.now() })
    room.ownerConn = fakeA
    room.ownerIds = new Set([1])
    parentTyping(sParent.roomId, 'C7A1', fakeA)
    const got: Uint8Array[] = []
    const fakeB = { send: (b: unknown) => { if (b instanceof Uint8Array) got.push(b) } }
    room.conns.set(fakeB, { joinedAt: Date.now(), clientIds: new Set([2]), lastMsgAt: Date.now() })
    registerEmbedInsert(sParent.roomId, {
      norm: 'ppt/embeddings/n1.docx',
      name: 'n1.docx',
      kind: 'pptx',
      pos: { slide: 1, x: 0.5, y: 0.5 },
      preHash: room.lastHash,
    })
    const found = got
      .map((b) => {
        try {
          const d = decoding.createDecoder(b)
          if (decoding.readVarUint(d) !== MSG_PART_EMBEDDED) return null
          return JSON.parse(new TextDecoder().decode(decoding.readVarUint8Array(d)))
        } catch {
          return null
        }
      })
      .filter((x) => x !== null)
    expect(found).toEqual([
      {
        roomId: sParent.roomId,
        part: 'ppt/embeddings/n1.docx',
        name: 'n1.docx',
        kind: 'pptx',
        pos: { slide: 1, x: 0.5, y: 0.5 },
        newHash: room.lastHash,
      },
    ])
    expect(rooms.get(sParent.roomId)).toBeDefined()
  })

  it('삽입을 모르는 저장은 preHash로 받아주고 파트를 다시 끼운다', async () => {
    const sParent = await createSession(HOST_REL)
    const room = rooms.get(sParent.roomId)!
    const fakeA = { send: (_b: unknown) => {} }
    room.conns.set(fakeA, { joinedAt: Date.now(), clientIds: new Set([1]), lastMsgAt: Date.now() })
    room.ownerConn = fakeA
    room.ownerIds = new Set([1])
    parentTyping(sParent.roomId, 'C7B1', fakeA)
    const hostBytes = new Uint8Array(await fs.readFile(hostAbs(HOST_REL)))
    const preHash = room.lastHash
    // 서버가 삽입한 것처럼 디스크+해시를 갱신한다 (POST /embed 상당).
    const out = await assemblePptxEmbed(zipLoad, {
      hostBytes,
      attachBytes: new TextEncoder().encode('fake-attach-bytes'),
      attachName: 'n1.docx',
      attachKind: 'docx',
      slide: 1,
      xFrac: 0.5,
      yFrac: 0.5,
    })
    await fs.writeFile(hostAbs(HOST_REL), out)
    room.lastHash = hashBytes(out)
    registerEmbedInsert(sParent.roomId, {
      norm: 'ppt/embeddings/n1.docx',
      name: 'n1.docx',
      kind: 'pptx',
      pos: { slide: 1, x: 0.5, y: 0.5 },
      preHash,
    })
    // 삽입 전 바이트로 저장해도 409가 아니라 병합된다.
    const r = await applySave(sParent.roomId, hostBytes, { kind: 'pptx', baseHash: preHash, clientId: 1 })
    expect('newHash' in r).toBe(true)
    // 디스크에 파트가 살아 있다.
    const diskBytes = new Uint8Array(await fs.readFile(hostAbs(HOST_REL)))
    const part = await readEmbedPart(zipLoad, diskBytes, 'ppt/embeddings/n1.docx')
    expect(new TextDecoder().decode(part.bytes)).toBe('fake-attach-bytes')
    // 같은 옛 base 재사용은 409 (1회성 소비).
    const r2 = await applySave(sParent.roomId, hostBytes, { kind: 'pptx', baseHash: preHash, clientId: 1 })
    expect('conflict' in r2).toBe(true)
    // 무관한 stale base도 409.
    const r3 = await applySave(sParent.roomId, hostBytes, { kind: 'pptx', baseHash: 'deadbeef', clientId: 1 })
    expect('conflict' in r3).toBe(true)
  })
})
