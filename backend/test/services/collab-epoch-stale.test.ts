import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import JSZip from 'jszip'
import * as Y from 'yjs'

// files.ts가 모듈 로드 시점에 WORKSPACE_PATH를 캡처하므로 적재 import보다 먼저 env를 깐다.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'collabepochstale-'))
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
  removeConn,
  resetCollabForTests,
  rooms,
  setParentQuietMs,
  setParentResetMaxMs,
} = await import('../../src/services/collab-rooms')

const hostAbs = (...p: string[]) => path.join(tmp, ...p)

async function parentBytesWithMark(hostFile: string, mark: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await fs.readFile(hostFile))
  const name = 'ppt/slides/slide1.xml'
  const cur = await zip.file(name)!.async('string')
  const next = cur.replace(/C5-0 host|P0X5[A-Z0-9]*|P0X9[A-Z0-9]*|P0XD[A-Z0-9]*|P0XE[A-Z0-9]*/, mark)
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
  const next = cur.replace(/C5-0 payload|P0X5[A-Z0-9]*|P0X9[A-Z0-9]*|P0XD[A-Z0-9]*|P0XE[A-Z0-9]*/, mark)
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

function twoEditors(roomId: string): { fakeA: object; fakeB: object } {
  const room = rooms.get(roomId)!
  const fakeA = { send: (_b: unknown) => {} }
  const fakeB = { send: (_b: unknown) => {} }
  room.conns.set(fakeA, { joinedAt: Date.now(), clientIds: new Set([1]), lastMsgAt: Date.now() })
  room.conns.set(fakeB, { joinedAt: Date.now(), clientIds: new Set([2]), lastMsgAt: Date.now() })
  room.ownerConn = fakeA
  room.ownerIds = new Set([1])
  return { fakeA, fakeB }
}

async function partMark(): Promise<string> {
  const zip = await JSZip.loadAsync(await fs.readFile(hostAbs(HOST_REL)))
  const inner = await JSZip.loadAsync(await zip.file(PART)!.async('uint8array'))
  return inner.file('word/document.xml')!.async('string')
}

/**
 * 파트 저장의 flush 게이트를 통과시킨다 (fake conn은 103에 답하지 않으므로,
 * 파트 저장 시작 뒤 부모 저장을 한 번 해서 flush를 settle시킨다).
 */
async function partSaveWithSettle(
  partRoomId: string,
  partBytes: Uint8Array,
  settleParentId: string,
  settleBytes: Uint8Array,
  settleBase: string,
  settleClientId: number,
): Promise<void> {
  const partRoom = rooms.get(partRoomId)!
  const p = applySave(partRoomId, partBytes, {
    kind: partRoom.kind,
    baseHash: partRoom.lastHash,
    clientId: 7,
  })
  p.catch(() => null)
  await new Promise((r) => setTimeout(r, 150))
  const s = await applySave(settleParentId, settleBytes, {
    kind: rooms.get(settleParentId)!.kind,
    baseHash: settleBase,
    clientId: settleClientId,
  })
  expect('newHash' in s).toBe(true)
  const r = await p
  expect('newHash' in r).toBe(true)
}

beforeEach(() => {
  resetCollabForTests()
})

afterEach(() => {
  setParentQuietMs(5000)
  setParentResetMaxMs(60000)
  resetCollabForTests()
})

describe('C6c-e: 리셋을 넘어온 옛 저장은 막는다 (epoch)', () => {
  it('미룸 중 병합 저장(M) → 리셋 → 리셋 전 바이트를 base=M·옛 epoch으로 저장하면 409 stale_client (덮개 금지)', async () => {
    // C6c-e red: 병합 저장은 lastHash를 M으로 올리지만 클라이언트 메모리에는
    // 옛 파트가 남는다. 리셋 뒤 같은 base(M)로 도착하는 옛 저장은 base 대조를
    // 통과해 200으로 옛 파트를 덮는다 ((나)와 같은 유실). 방 세대(epoch)가
    // 바뀌었으면 409 stale_client로 거부해야 한다.
    setParentQuietMs(60000)
    const sParent = await createSession(HOST_REL)
    const parentRoom = rooms.get(sParent.roomId)!
    const { fakeA } = twoEditors(sParent.roomId)
    const epoch1 = sParent.epoch
    // A의 기준 바이트 (옛 파트 + A 입력).
    const staleParentBytes = await parentBytesWithMark(hostAbs(HOST_REL), 'P0XEE-A1')
    const r0 = await applySave(sParent.roomId, staleParentBytes, {
      kind: parentRoom.kind,
      baseHash: rooms.get(sParent.roomId)!.lastHash,
      clientId: 1,
    })
    expect('newHash' in r0).toBe(true)
    const adoptBase = (r0 as { newHash: string }).newHash
    // B의 파트 저장 → 미뤄짐 (디스크·방 해시는 즉시 adopt).
    parentTyping(sParent.roomId, 'P0XEE-T1', fakeA)
    const sPart = await createSession(HOST_REL, { part: PART })
    const eBytes = await partInnerWithMark(hostAbs(HOST_REL), PART, 'P0XEE-E1')
    await partSaveWithSettle(rooms.get(sPart.roomId)!.id, eBytes, sParent.roomId, staleParentBytes, adoptBase, 1)
    expect(rooms.get(sParent.roomId)?.pendingPartReset).toBeTruthy()
    // A의 병합 저장 (stale base 허용): lastHash = M.
    parentTyping(sParent.roomId, 'P0XEE-T2', fakeA)
    const gR = await applySave(sParent.roomId, staleParentBytes, {
      kind: parentRoom.kind,
      baseHash: adoptBase,
      clientId: 1,
    })
    expect('newHash' in gR).toBe(true)
    const mergedHash = (gR as { newHash: string }).newHash
    // 미뤄진 리셋 실행 → 방 해체.
    const room = rooms.get(sParent.roomId)!
    for (const ws of [...room.conns.keys()]) removeConn(sParent.roomId, ws)
    expect(rooms.get(sParent.roomId)).toBeUndefined()
    // 재입장: 새 방·새 epoch, lastHash는 디스크(M).
    const s2 = await createSession(HOST_REL)
    expect(s2.role).toBe('host')
    expect(s2.epoch).not.toBe(epoch1)
    expect(rooms.get(s2.roomId)!.lastHash).toBe(mergedHash)
    // 리셋 전 바이트(옛 파트)를 base=M·옛 epoch으로 저장하면 막아야 한다.
    const stale = await applySave(s2.roomId, staleParentBytes, {
      kind: rooms.get(s2.roomId)!.kind,
      baseHash: mergedHash,
      clientId: 1,
      epoch: epoch1,
    })
    expect('conflict' in stale).toBe(true)
    expect((stale as { code?: string }).code).toBe('stale_client')
    // 디스크 첨부는 그대로다.
    expect(await partMark()).toContain('P0XEE-E1')
  }, 60000)

  it('같은 epoch의 저장은 리셋 뒤에도 통과한다 (오탐 금지)', async () => {
    setParentQuietMs(60000)
    const sParent = await createSession(HOST_REL)
    const { fakeA } = twoEditors(sParent.roomId)
    const v0 = await parentBytesWithMark(hostAbs(HOST_REL), 'P0XEE-A1')
    const r0 = await applySave(sParent.roomId, v0, {
      kind: rooms.get(sParent.roomId)!.kind,
      baseHash: rooms.get(sParent.roomId)!.lastHash,
      clientId: 1,
    })
    expect('newHash' in r0).toBe(true)
    const adoptBase = (r0 as { newHash: string }).newHash
    parentTyping(sParent.roomId, 'P0XEE-T1', fakeA)
    const sPart = await createSession(HOST_REL, { part: PART })
    const eBytes = await partInnerWithMark(hostAbs(HOST_REL), PART, 'P0XEE-E1')
    await partSaveWithSettle(rooms.get(sPart.roomId)!.id, eBytes, sParent.roomId, v0, adoptBase, 1)
    parentTyping(sParent.roomId, 'P0XEE-T2', fakeA)
    const gR = await applySave(sParent.roomId, v0, {
      kind: rooms.get(sParent.roomId)!.kind,
      baseHash: adoptBase,
      clientId: 1,
    })
    expect('newHash' in gR).toBe(true)
    const room = rooms.get(sParent.roomId)!
    for (const ws of [...room.conns.keys()]) removeConn(sParent.roomId, ws)
    const s2 = await createSession(HOST_REL)
    // 새 epoch + 새 base + 디스크 기준 바이트면 정상 저장된다.
    const v2 = await parentBytesWithMark(hostAbs(HOST_REL), 'P0XEE-A2')
    const ok = await applySave(s2.roomId, v2, {
      kind: rooms.get(s2.roomId)!.kind,
      baseHash: rooms.get(s2.roomId)!.lastHash,
      clientId: 1,
      epoch: s2.epoch,
    })
    expect('newHash' in ok).toBe(true)
    expect(await partMark()).toContain('P0XEE-E1')
  }, 60000)

  it('epoch 없이 저장하면 기존대로 동작한다 (하위 호환)', async () => {
    const sParent = await createSession(HOST_REL)
    const v0 = await parentBytesWithMark(hostAbs(HOST_REL), 'P0XEE-A1')
    const r = await applySave(sParent.roomId, v0, {
      kind: rooms.get(sParent.roomId)!.kind,
      baseHash: rooms.get(sParent.roomId)!.lastHash,
      clientId: 1,
    })
    expect('newHash' in r).toBe(true)
  }, 30000)
})
