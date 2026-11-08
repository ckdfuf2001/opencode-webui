import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import JSZip from 'jszip'

// files.ts가 모듈 로드 시점에 WORKSPACE_PATH를 캡처하므로 적재 import보다 먼저 env를 깐다.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'collabpartnochain-'))
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
  const next = cur.replace(/C5-0 host|P0X5[A-Z0-9]*|P0X6[A-Z0-9]*/, mark)
  if (next === cur) throw new Error('fixture changed: no slide anchor text')
  zip.file(name, next)
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
}

// 파트 PUT의 body는 파트(inner) 바이트다 (outer 전체가 아니다 — e2e
// AttachmentEditor가 보내는 것과 동일). outer를 통째로 넣으면 파트 자리에
// 호스트가 통째로 박힌다 (unit에서만 성립하는 오판이 된다).
async function partBytesWithMark(hostFile: string, part: string, mark: string): Promise<Uint8Array> {
  const buf = await fs.readFile(hostFile)
  const zip = await JSZip.loadAsync(buf)
  const inner = await JSZip.loadAsync(await zip.file(part)!.async('uint8array'))
  const name = 'word/document.xml'
  const cur = await inner.file(name)!.async('string')
  const next = cur.replace(/C5-0 payload|P0X5[A-Z0-9]*|P0X6[A-Z0-9]*/, mark)
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

describe('P0-1c: 파트 저장이 부모 flush를 기다리는 동안 부모 저장이 막히지 않는다', () => {
  it('부모 저장은 파트 flush 대기 중에도 끝난다 (순환대기 금지)', async () => {
    const sParent = await createSession(HOST_REL)
    const parentRoom = rooms.get(sParent.roomId)!
    // owner인 척하는 가짜 conn: 103을 삼키고 ack하지 않아 flush를 펜딩시킨다.
    const fakeSock = { send: (_b: unknown) => {} }
    parentRoom.conns.set(fakeSock, { joinedAt: Date.now(), clientIds: new Set([1]), lastMsgAt: Date.now() })
    parentRoom.ownerConn = fakeSock
    parentRoom.ownerIds.add(1)
    const sPart = await createSession(HOST_REL, { part: PART })
    const partRoom = rooms.get(sPart.roomId)!
    const eBytes = await partBytesWithMark(hostAbs(HOST_REL), PART, 'P0X6E0')
    // 파트 저장은 부모 flush를 기다리며 펜딩된다 (8초 타임아웃).
    const partP = applySave(sPart.roomId, eBytes, {
      kind: partRoom.kind,
      baseHash: sPart.lastHash,
      clientId: 7,
    })
    partP.catch(() => null)
    await new Promise((r) => setTimeout(r, 300))
    expect(rooms.get(sParent.roomId)!.pendingFlush).toBeTruthy()
    // 부모 저장: 파트 저장이 flush 대기로 부모 체인을 잡고 있으면 여기서 막힌다 (red).
    // U-flush-race: 파트 PUT이 체인을 8초씩 두 번 잡으면 부모 수동·자동 저장이
    // 전부 뒤에 줄서서 flush가 굶어 죽고 attach가 dirty_room으로 끝난다.
    const gBytes = await parentBytesWithMark(hostAbs(HOST_REL), 'P0X6G0')
    const gR = await Promise.race([
      applySave(sParent.roomId, gBytes, {
        kind: parentRoom.kind,
        baseHash: rooms.get(sParent.roomId)!.lastHash,
        clientId: 10,
      }).then(() => true),
      new Promise((rr) => setTimeout(() => rr(false), 5000)),
    ])
    expect(gR).toBe(true)
    // P0-1c 시나리오 가드: flush를 끝낸 부모 저장(G)의 내용이 파트 쓰기 뒤에도
    // 디스크에 남는다. 읽기-끼우기-쓰기가 체인 안에서 현재 디스크 기준으로
    // 일어나므로 G가 보존된다 (체인 밖에서 읽은 옛 바이트로 쓰면 G가 사라진다).
    const partR = await partP.catch((e) => {
      throw e
    })
    expect('newHash' in partR).toBe(true)
    const finalZip = await JSZip.loadAsync(await fs.readFile(hostAbs(HOST_REL)))
    const slideXml = await finalZip.file('ppt/slides/slide1.xml')!.async('string')
    expect(slideXml).toContain('P0X6G0')
    const finalInner = await JSZip.loadAsync(await finalZip.file(PART)!.async('uint8array'))
    const finalDoc = await finalInner.file('word/document.xml')!.async('string')
    expect(finalDoc).toContain('P0X6E0')
    // 뒷정리: 파트 flush 타임아웃(8초)까지 기다렸다가 끝낸다.
    resetCollabForTests()
  }, 20000)
})
