import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import JSZip from 'jszip'

// files.ts가 모듈 로드 시점에 WORKSPACE_PATH를 캡처하므로 적재 import보다 먼저 env를 깐다.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'collabflushgate-'))
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
  rooms,
} = await import('../../src/services/collab-rooms')

const hostAbs = (...p: string[]) => path.join(tmp, ...p)

async function parentBytesWithMark(hostFile: string, mark: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await fs.readFile(hostFile))
  const name = 'ppt/slides/slide1.xml'
  const cur = await zip.file(name)!.async('string')
  const next = cur.replace(/C5-0 host|P0X5[A-Z0-9]*/, mark)
  if (next === cur) throw new Error('fixture changed: no slide anchor text')
  zip.file(name, next)
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
}

async function partBytesWithMark(hostFile: string, part: string, mark: string): Promise<Uint8Array> {
  const buf = await fs.readFile(hostFile)
  const zip = await JSZip.loadAsync(buf)
  const inner = await JSZip.loadAsync(await zip.file(part)!.async('uint8array'))
  const name = 'word/document.xml'
  const cur = await inner.file(name)!.async('string')
  const next = cur.replace(/C5-0 payload|P0X5[A-Z0-9]*/, mark)
  if (next === cur) throw new Error('fixture changed: no part anchor text')
  inner.file(name, next)
  zip.file(part, await inner.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
}

beforeEach(() => {
  resetCollabForTests()
})

afterEach(() => {
  resetCollabForTests()
})

describe('P0-1 flush gate: requestId가 맞는 저장 하나만 체인을 건너뛴다', () => {
  it('flush 대기 중 일반 저장은 끼어들지 않는다', async () => {    const sParent = await createSession(HOST_REL)
    const parentRoom = rooms.get(sParent.roomId)!
    // owner인 척하는 가짜 conn: 103을 삼키고 ack하지 않아 flush를 펜딩시킨다.
    const fakeSock = { send: (_b: unknown) => {} }
    parentRoom.conns.set(fakeSock, { joinedAt: Date.now(), clientIds: new Set([1]), lastMsgAt: Date.now() })
    parentRoom.ownerConn = fakeSock
    parentRoom.ownerIds.add(1)
    const sPart = await createSession(HOST_REL, { part: PART })
    const partRoom = rooms.get(sPart.roomId)!
    const eBytes = await partBytesWithMark(hostAbs(HOST_REL), PART, 'P0X5E0')
    // 파트 저장은 부모 flush를 기다리며 펜딩된다 (최대 8초 — 테스트는 2~3초면 끝난다).
    const partP = applySave(sPart.roomId, eBytes, {
      kind: partRoom.kind,
      baseHash: sPart.lastHash,
      clientId: 7,
    })
    partP.catch(() => null)
    // flush 요청이 걸렸는지 확인하고 requestId를 읽는다.
    await new Promise((r) => setTimeout(r, 300))
    const reqId = rooms.get(sParent.roomId)!.pendingFlush?.requestId
    expect(typeof reqId).toBe('string')
    const host = hostAbs(HOST_REL)
    const gBytes = await parentBytesWithMark(host, 'P0X5G0')
    // G: 짝이 안 맞는 일반 저장 → 파트 저장이 끝날 때까지 체인에서 기다린다.
    // (red: 기존 코드는 pendingFlush만 보고 전부 건너뛰므로 곧바로 끝난다.)
    let gDone: boolean | string = false
    const gP = applySave(sParent.roomId, gBytes, {
      kind: parentRoom.kind,
      baseHash: rooms.get(sParent.roomId)!.lastHash,
      clientId: 10,
    }).then((r) => {
      gDone = 'conflict' in r ? 'conflict' : true
      return r
    }, (e) => {
      gDone = 'threw'
      throw e
    })
    await new Promise((r) => setTimeout(r, 1500))
    expect(gDone).toBe(false)
    // F: 짝이 맞는 flush 응답 → 체인을 건너뛰고 바로 수행된다 (우회 막힘 방지).
    const fBytes = await parentBytesWithMark(host, 'P0X5F0')
    const fR = await applySave(sParent.roomId, fBytes, {
      kind: parentRoom.kind,
      baseHash: rooms.get(sParent.roomId)!.lastHash,
      clientId: 9,
      flushRequestId: reqId,
    })
    expect('newHash' in fR).toBe(true)
    // 뒷정리: 방 해체가 펜딩 저장들을 끝낸다.
    resetCollabForTests()
    await partP.catch(() => null)
    await gP.catch(() => null)
  })

  it('요청 뒤에 끝난 일반 저장은 flush를 끝낸다 (교착 방지)', async () => {
    // 진행 중이던 저장이 flush 응답을 겸하는 경우: id가 없어도,
    // 요청 시점보다 늦게 끝났고 원격 업데이트를 모두 포함하면 끝낸다.
    const sParent = await createSession(HOST_REL)
    const room = rooms.get(sParent.roomId)!
    let resolveFlush!: (r: { ok: boolean; reason?: string }) => void
    const flushed = new Promise<{ ok: boolean; reason?: string }>((r) => {
      resolveFlush = r
    })
    room.pendingFlush = {
      promise: flushed,
      resolve: resolveFlush,
      timer: setTimeout(() => {}, 60000),
      conn: null,
      requestId: 'f-test-noid',
      requestedAt: Date.now() - 1000,
    }
    try {
      const b = await parentBytesWithMark(hostAbs(HOST_REL), 'P0X5N0')
      const r = await applySave(sParent.roomId, b, {
        kind: room.kind,
        baseHash: room.lastHash,
        clientId: 3,
      })
      expect('newHash' in r).toBe(true)
      const settled = await Promise.race([
        flushed.then(() => true),
        new Promise((rr) => setTimeout(() => rr(false), 2000)),
      ])
      expect(settled).toBe(true)
    } finally {
      clearTimeout(room.pendingFlush?.timer as unknown as ReturnType<typeof setTimeout>)
      resetCollabForTests()
    }
  })
})
