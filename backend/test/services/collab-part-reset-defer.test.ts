import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import JSZip from 'jszip'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

// files.ts가 모듈 로드 시점에 WORKSPACE_PATH를 캡처하므로 적재 import보다 먼저 env를 깐다.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'collabpartreset-'))
process.env.WORKSPACE_PATH = tmp

const SEED_DIR = path.join(tmp, 'repos', 'pp')
await fs.mkdir(SEED_DIR, { recursive: true })
const FIX_HOST = path.resolve('..', 'e2e/collab/fixtures/ole/embed-docx.pptx')
await fs.copyFile(FIX_HOST, path.join(SEED_DIR, 'host.pptx'))
const HOST_REL = path.join('repos', 'pp', 'host.pptx')
const PART = 'ppt/embeddings/Microsoft_Word_Document.docx'

const {
  adoptParentPartAndMaybeReset,
  addConn,
  applySave,
  createSession,
  isLibRoomKind,
  MSG_PART_PENDING,
  resetCollabForTests,
  resetStats,
  rooms,
  setParentQuietMs,
  wsMessage,
} = await import('../../src/services/collab-rooms')

const hostAbs = (...p: string[]) => path.join(tmp, ...p)

async function parentBytesWithMark(hostFile: string, mark: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await fs.readFile(hostFile))
  const name = 'ppt/slides/slide1.xml'
  const cur = await zip.file(name)!.async('string')
  const next = cur.replace(/C5-0 host|P0X5[A-Z0-9]*|P0X9[A-Z0-9]*/, mark)
  if (next === cur) throw new Error('fixture changed: no slide anchor text')
  zip.file(name, next)
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
}

async function partInnerWithMark(hostFile: string, part: string, mark: string): Promise<Uint8Array> {
  const raw = await fs.readFile(hostFile)
  const zip = await JSZip.loadAsync(raw)
  const f = zip.file(part)
  if (!f) throw new Error(`part missing in fixture: ${part}`)
  const inner = await JSZip.loadAsync(await zip.file(part)!.async('uint8array'))
  const name = 'word/document.xml'
  const cur = await inner.file(name)!.async('string')
  const next = cur.replace(/C5-0 payload|P0X5[A-Z0-9]*|P0X9[A-Z0-9]*/, mark)
  if (next === cur) throw new Error('fixture changed: no part anchor text')
  inner.file(name, next)
  return new Uint8Array(await inner.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
}

/** 부모 타이핑 시뮬레이션: Y 업데이트를 방 doc에 직접 적용한다 (원격 입력과 동일 경로). */
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

describe('C6c-1: 파트 저장은 부모가 조용할 때만 방을 리셋한다', () => {
  it('부모 입력 중 첨부 저장 3회 → 리셋 0회, 조용해지면 1회, 양쪽 디스크 보존', async () => {
    // C6c-1 red: 파트 저장이 부모 방을 즉시 리셋(4001+dispose)하면 타이핑이
    // 끊긴다. 조용한 구간까지 미뤄야 한다 (미뤄진 동안 부모 화면에 미반영 표시).
    // 라운드당 입력→저장 왕복이 quiet 창 안에 들어가도록 타이밍을 잡는다.
    setParentQuietMs(2000)
    try {
      const sParent = await createSession(HOST_REL)
      const parentRoom = rooms.get(sParent.roomId)!
      // 두 명의 편집자 conn (owner 선출용).
      // C6c-f item 2: 미뤄진 리셋은 flush(103) 후 4001이다. owner(fakeA)는 103을
      // 받으면 104 {ok:true}로 답한다 (미저장 없음 → B2 즉시-ok 상당).
      // ack는 비동기+지연으로 보낸다. 동기 ack는 서버가 p.conn을 적재하기 전이라
      // B1 짝짓기에 버려지고 (실제 WS 왕복은 항상 비동기), 즉시 ack는 파트 저장이
      // 부모 타이핑 전에 끝나 adopt가 defer 대신 즉시 리셋해 버린다. 300ms 지연은
      // 현실적인 왕복 latency이며 라운드 타이밍(입력→저장→adopt)을 보존한다.
      const ackFlush = (tag: { send: (b: unknown) => void }, roomId: string) => (b: unknown) => {
        try {
          if (!(b instanceof Uint8Array) || b.length === 0) return
          const d = decoding.createDecoder(b)
          if (decoding.readVarUint(d) !== 103) return
          const raw = decoding.readVarUint8Array(d)
          const body = JSON.parse(new TextDecoder().decode(raw)) as { requestId?: unknown }
          const reqId = body.requestId
          setTimeout(() => {
            try {
              const e = encoding.createEncoder()
              encoding.writeVarUint(e, 104)
              encoding.writeVarUint8Array(e, new TextEncoder().encode(JSON.stringify({ ok: true, requestId: reqId })))
              wsMessage(roomId, tag, encoding.toUint8Array(e))
            } catch {
              // 무시
            }
          }, 300)
        } catch {
          // 무시
        }
      }
      const fakeA: { send: (b: unknown) => void } = { send: () => {} }
      const fakeB = { send: (_b: unknown) => {} }
      fakeA.send = ackFlush(fakeA, sParent.roomId)
      parentRoom.conns.set(fakeA, { joinedAt: Date.now(), clientIds: new Set([1]), lastMsgAt: Date.now() })
      parentRoom.conns.set(fakeB, { joinedAt: Date.now(), clientIds: new Set([2]), lastMsgAt: Date.now() })
      parentRoom.ownerConn = fakeA
      parentRoom.ownerIds = new Set([1])
      const sPart = await createSession(HOST_REL, { part: PART })
      const partRoom = rooms.get(sPart.roomId)!
      // 3 라운드: 부모 입력(Y 업데이트) + 부모 저장 + 첨부 저장.
      // 입력은 파트 쓰기 직전에 갱신한다 (flush 왕복 뒤에도 quiet 창 안에 들도록).
      for (let n = 1; n <= 3; n += 1) {
        const eBytes = await partInnerWithMark(hostAbs(HOST_REL), PART, `P0X9E${n}`)
        const partP = applySave(sPart.roomId, eBytes, {
          kind: partRoom.kind,
          baseHash: rooms.get(sPart.roomId)!.lastHash,
          clientId: 7,
        })
        partP.catch(() => null)
        await new Promise((r) => setTimeout(r, 100))
        parentTyping(sParent.roomId, `P0X9T${n}`, fakeA)
        const gBytes = await parentBytesWithMark(hostAbs(HOST_REL), `P0X9G${n}`)
        const gR = await applySave(sParent.roomId, gBytes, {
          kind: parentRoom.kind,
          baseHash: rooms.get(sParent.roomId)!.lastHash,
          clientId: n % 2 === 0 ? 2 : 1,
        })
        expect('newHash' in gR).toBe(true)
        const partR = await partP
        expect('newHash' in partR).toBe(true)
        // 미뤄짐: 방이 해체되지 않고 편집 conn이 살아 있다.
        expect(rooms.get(sParent.roomId)).toBeDefined()
        expect(rooms.get(sParent.roomId)!.conns.size).toBe(2)
      }
      const before = resetStats(sParent.roomId)
      expect(before?.total ?? 0).toBe(0)
      // 입력을 멈추고 조용한 구간(+여유)을 기다리면 리셋이 1회 일어난다.
      await new Promise((r) => setTimeout(r, 3000))
      expect(rooms.get(sParent.roomId)).toBeUndefined()
      const after = resetStats(sParent.roomId)
      expect(after?.total ?? 0).toBe(1)
      expect(after?.disruptive ?? 0).toBe(1)
      // 양쪽 내용 디스크 보존: 부모 마크 + 파트 마크.
      const finalZip = await JSZip.loadAsync(await fs.readFile(hostAbs(HOST_REL)))
      const slideXml = await finalZip.file('ppt/slides/slide1.xml')!.async('string')
      expect(slideXml).toContain('P0X9G3')
      const finalInner = await JSZip.loadAsync(await finalZip.file(PART)!.async('uint8array'))
      const finalDoc = await finalInner.file('word/document.xml')!.async('string')
      expect(finalDoc).toContain('P0X9E3')
    } finally {
      setParentQuietMs(5000)
      resetCollabForTests()
    }
  }, 30000)

  it('미뤄진 리셋이면 lib 방 전원에게 105 part-pending을 보낸다 (C6N)', async () => {
    // lib 방(xlsx/docx)은 type 100 meta를 모르므로 별도 타입으로 알린다.
    // pptx 방에는 보내지 않는다 (meta 경로 그대로).
    setParentQuietMs(60000)
    try {
      const xlsxHost = path.join(SEED_DIR, 'host.xlsx')
      await fs.copyFile(path.resolve('..', 'e2e/collab/fixtures/ole/embed-pdf.xlsx'), xlsxHost)
      const sParent = await createSession(path.join('repos', 'pp', 'host.xlsx'))
      const proom = rooms.get(sParent.roomId)!
      expect(isLibRoomKind(proom.kind)).toBe(true)
      const got: Uint8Array[] = []
      const fakeA = {
        send: (b: unknown) => {
          if (b instanceof Uint8Array) got.push(b)
        },
      }
      const fakeB = { send: (_b: unknown) => {} }
      proom.conns.set(fakeA, { joinedAt: Date.now(), clientIds: new Set([1]), lastMsgAt: Date.now() })
      proom.conns.set(fakeB, { joinedAt: Date.now(), clientIds: new Set([2]), lastMsgAt: Date.now() })
      proom.ownerConn = fakeA
      proom.ownerIds = new Set([1])
      parentTyping(sParent.roomId, 'P0X9T1', fakeA)
      const r = adoptParentPartAndMaybeReset(sParent.roomId, 'basehash0', 'xl/embeddings/obj1.xlsx')
      expect(r.deferred).toBe(true)
      const found = got
        .map((b) => {
          try {
            const d = decoding.createDecoder(b)
            if (decoding.readVarUint(d) !== MSG_PART_PENDING) return null
            return JSON.parse(new TextDecoder().decode(decoding.readVarUint8Array(d)))
          } catch {
            return null
          }
        })
        .filter((x) => x !== null)
      expect(found).toEqual([{ roomId: sParent.roomId, hasPendingPartChange: true }])
      // 미뤄진 방은 아직 살아 있다 (리셋은 조용한 구간·상한에).
      expect(rooms.get(sParent.roomId)).toBeDefined()
    } finally {
      setParentQuietMs(5000)
      resetCollabForTests()
    }
  }, 30000)

  it('미뤄진 방에 늦게 붙으면 그 conn에만 105를 보낸다 (C6N late join)', async () => {
    setParentQuietMs(60000)
    try {
      const sParent = await createSession(HOST_REL)
      const room = rooms.get(sParent.roomId)!
      const fakeA = { send: (_b: unknown) => {} }
      room.conns.set(fakeA, { joinedAt: Date.now(), clientIds: new Set([1]), lastMsgAt: Date.now() })
      room.ownerConn = fakeA
      room.ownerIds = new Set([1])
      parentTyping(sParent.roomId, 'P0X9T1', fakeA)
      const r = adoptParentPartAndMaybeReset(sParent.roomId, 'basehash0', 'ppt/embeddings/obj1.docx')
      expect(r.deferred).toBe(true)
      expect(rooms.get(sParent.roomId)).toBeDefined()
      // 늦은 참가자: addConn으로 붙으면 105를 받아야 한다.
      const got: Uint8Array[] = []
      const fakeLate = { send: (b: unknown) => { if (b instanceof Uint8Array) got.push(b) } }
      const joined = addConn(sParent.roomId, fakeLate)
      expect(joined).not.toBeNull()
      const found = got.map((b) => {
        try {
          const d = decoding.createDecoder(b)
          if (decoding.readVarUint(d) !== MSG_PART_PENDING) return null
          return JSON.parse(new TextDecoder().decode(decoding.readVarUint8Array(d)))
        } catch { return null }
      }).filter((x) => x !== null)
      expect(found).toEqual([{ roomId: sParent.roomId, hasPendingPartChange: true }])
    } finally {
      setParentQuietMs(5000)
      resetCollabForTests()
    }
  }, 30000)
})
