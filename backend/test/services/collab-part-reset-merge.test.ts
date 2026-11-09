import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import JSZip from 'jszip'
import * as Y from 'yjs'

// files.ts가 모듈 로드 시점에 WORKSPACE_PATH를 캡처하므로 적재 import보다 먼저 env를 깐다.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'collabpartmerge-'))
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
  resetStats,
  rooms,
  setParentQuietMs,
  setParentResetMaxMs,
} = await import('../../src/services/collab-rooms')

const hostAbs = (...p: string[]) => path.join(tmp, ...p)

async function parentBytesWithMark(hostFile: string, mark: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await fs.readFile(hostFile))
  const name = 'ppt/slides/slide1.xml'
  const cur = await zip.file(name)!.async('string')
  const next = cur.replace(/C5-0 host|P0X5[A-Z0-9]*|P0X9[A-Z0-9]*|P0XD[A-Z0-9]*/, mark)
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
  const next = cur.replace(/C5-0 payload|P0X5[A-Z0-9]*|P0X9[A-Z0-9]*|P0XD[A-Z0-9]*/, mark)
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

async function slideMark(): Promise<string> {
  const zip = await JSZip.loadAsync(await fs.readFile(hostAbs(HOST_REL)))
  return zip.file('ppt/slides/slide1.xml')!.async('string')
}

async function partMark(): Promise<string> {
  const zip = await JSZip.loadAsync(await fs.readFile(hostAbs(HOST_REL)))
  const inner = await JSZip.loadAsync(await zip.file(PART)!.async('uint8array'))
  return inner.file('word/document.xml')!.async('string')
}

/**
 * 사용자 삭제 시뮬레이션: 디스크 바이트에서 파트 파일 + 그 rel을 지운다.
 * 편집기가 첨부 개체를 지우면 rel이 사라지므로, 병합은 이 파트를
 * 다시 끼우면 안 된다 (C6c-e item 3).
 */
async function parentBytesWithoutPart(hostFile: string, part: string): Promise<Uint8Array> {
  const raw = await fs.readFile(hostFile)
  const zip = await JSZip.loadAsync(raw)
  const base = part.split('/').pop()!
  for (const name of Object.keys(zip.files)) {
    if (!name.endsWith('.rels')) continue
    const f = zip.file(name)
    if (!f || f.dir) continue
    const text = await f.async('string')
    if (!text.includes(base)) continue
    const cleaned = text
      .replace(new RegExp(`<Relationship\\b[^>]*${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*\\/\\s*>`, 'g'), '')
      .replace(new RegExp(`<Relationship\\b[^>]*${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*>[\\s\\S]*?<\\/Relationship>`, 'g'), '')
    if (cleaned !== text) zip.file(name, cleaned)
  }
  zip.remove(part)
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
}

/** 디스크 zip의 rel 어딘가에 해당 파트를 가리키는 Relationship이 있는가. */
async function partHasRel(hostFile: string, part: string): Promise<boolean> {
  const raw = await fs.readFile(hostFile)
  const zip = await JSZip.loadAsync(raw)
  const base = part.split('/').pop()!
  for (const name of Object.keys(zip.files)) {
    if (!name.endsWith('.rels')) continue
    const f = zip.file(name)
    if (!f || f.dir) continue
    if ((await f.async('string')).includes(base)) return true
  }
  return false
}

/**
 * 파트 저장을 끝까지 진행시킨다. fake conn은 103에 답하지 않으므로,
 * 파트 저장 시작 뒤 부모 저장을 한 번 해서 flush를 settle시킨다 (실제 동작과 동일).
 * 부모 바이트/베이스는 호출자가 준 것을 그대로 쓴다 (멱등 저장이어도 됨).
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

describe('C6c-d-1: 미뤄진 동안 부모 저장은 adopt된 파트를 다시 끼워 쓴다', () => {
  it('stale base 부모 저장이 409가 아니라 병합 저장된다 (옛 파트 + 입력 둘 다 디스크 보존)', async () => {
    // C6c-d red: 파트 저장으로 부모 lastHash가 adopt됐는데, 타이핑 중인 부모는
    // 옛 파트를 든 바이트를 들고 있다. 이 저장이 409면 타이핑이 계속 실패하고(가),
    // 재시도가 통과하면 옛 파트가 디스크를 덮는다(나, 조용한 유실).
    // 올바른 동작: 서버가 디스크의 adopt 파트를 들어온 부모 zip에 다시 끼워 쓴다.
    setParentQuietMs(60000)
    const sParent = await createSession(HOST_REL)
    const parentRoom = rooms.get(sParent.roomId)!
    const { fakeA } = twoEditors(sParent.roomId)
    // A의 기준 바이트 (옛 파트 + A 입력). 기준 저장으로 lastHash를 고정한다.
    const staleParentBytes = await parentBytesWithMark(hostAbs(HOST_REL), 'P0XDD-A1')
    const r0 = await applySave(sParent.roomId, staleParentBytes, {
      kind: parentRoom.kind,
      baseHash: rooms.get(sParent.roomId)!.lastHash,
      clientId: 1,
    })
    expect('newHash' in r0).toBe(true)
    const adoptBase = (r0 as { newHash: string }).newHash
    // B의 파트 저장 (settle 저장으로 flush를 끝낸다).
    parentTyping(sParent.roomId, 'P0XDD-T1', fakeA)
    const sPart = await createSession(HOST_REL, { part: PART })
    const eBytes = await partInnerWithMark(hostAbs(HOST_REL), PART, 'P0XDD-E1')
    await partSaveWithSettle(rooms.get(sPart.roomId)!.id, eBytes, sParent.roomId, staleParentBytes, adoptBase, 1)
    // 미뤄졌다 (리셋 0, 방 유지).
    expect(rooms.get(sParent.roomId)).toBeDefined()
    expect(rooms.get(sParent.roomId)?.pendingPartReset).toBeTruthy()
    expect(resetStats(sParent.roomId)?.total ?? 0).toBe(0)
    // A의 자동저장: 옛 파트 바이트 + adopt 전 base.
    parentTyping(sParent.roomId, 'P0XDD-T2', fakeA)
    const gR = await applySave(sParent.roomId, staleParentBytes, {
      kind: parentRoom.kind,
      baseHash: adoptBase,
      clientId: 1,
    })
    expect('conflict' in gR).toBe(false)
    expect('newHash' in gR).toBe(true)
    // 디스크에 양쪽이 다 있다.
    expect(await slideMark()).toContain('P0XDD-A1')
    expect(await partMark()).toContain('P0XDD-E1')
    // 미뤄짐은 유지된다 (A 클라이언트는 아직 옛 파트를 들고 있음).
    expect(rooms.get(sParent.roomId)).toBeDefined()
    expect(resetStats(sParent.roomId)?.total ?? 0).toBe(0)
  }, 60000)

  it('병합 저장 뒤의 연속 저장이 이어지고, 묵은 base의 두 번째 타이피스트는 409 후 재시도로 병합된다', async () => {
    setParentQuietMs(60000)
    const sParent = await createSession(HOST_REL)
    const parentRoom = rooms.get(sParent.roomId)!
    const { fakeA, fakeB } = twoEditors(sParent.roomId)
    const staleParentBytes = await parentBytesWithMark(hostAbs(HOST_REL), 'P0XDD-A1')
    const r0 = await applySave(sParent.roomId, staleParentBytes, {
      kind: parentRoom.kind,
      baseHash: rooms.get(sParent.roomId)!.lastHash,
      clientId: 1,
    })
    expect('newHash' in r0).toBe(true)
    const adoptBase = (r0 as { newHash: string }).newHash
    parentTyping(sParent.roomId, 'P0XDD-T1', fakeA)
    const sPart = await createSession(HOST_REL, { part: PART })
    const eBytes = await partInnerWithMark(hostAbs(HOST_REL), PART, 'P0XDD-E1')
    await partSaveWithSettle(rooms.get(sPart.roomId)!.id, eBytes, sParent.roomId, staleParentBytes, adoptBase, 1)
    expect(rooms.get(sParent.roomId)?.pendingPartReset).toBeTruthy()
    // A의 첫 병합 저장.
    parentTyping(sParent.roomId, 'P0XDD-T2', fakeA)
    const g1 = await applySave(sParent.roomId, staleParentBytes, {
      kind: parentRoom.kind,
      baseHash: adoptBase,
      clientId: 1,
    })
    expect('newHash' in g1).toBe(true)
    const mergedHash = (g1 as { newHash: string }).newHash
    // A의 연속 저장 (base=병합 해시, 바이트는 여전히 옛 파트): 또 병합된다.
    parentTyping(sParent.roomId, 'P0XDD-T3', fakeA)
    const stale2 = await parentBytesWithMark(hostAbs(HOST_REL), 'P0XDD-A1')
    const g2 = await applySave(sParent.roomId, stale2, {
      kind: parentRoom.kind,
      baseHash: mergedHash,
      clientId: 1,
    })
    expect('newHash' in g2).toBe(true)
    expect(await partMark()).toContain('P0XDD-E1')
    // B(두 번째 타이피스트)가 묵은 base로 저장하면 409가 난다 (A 편집 보호, 1회성 소비).
    parentTyping(sParent.roomId, 'P0XDD-TB', fakeB)
    const staleB = await parentBytesWithMark(hostAbs(HOST_REL), 'P0XDD-B1')
    const bBad = await applySave(sParent.roomId, staleB, {
      kind: parentRoom.kind,
      baseHash: adoptBase,
      clientId: 2,
    })
    expect('conflict' in bBad).toBe(true)
    // B가 새 base로 재시도하면 병합 저장된다.
    parentTyping(sParent.roomId, 'P0XDD-TB2', fakeB)
    const bRetry = await applySave(sParent.roomId, staleB, {
      kind: parentRoom.kind,
      baseHash: rooms.get(sParent.roomId)!.lastHash,
      clientId: 2,
    })
    expect('newHash' in bRetry).toBe(true)
    expect(await slideMark()).toContain('P0XDD-B1')
    expect(await partMark()).toContain('P0XDD-E1')
    expect(resetStats(sParent.roomId)?.total ?? 0).toBe(0)
  }, 60000)
})

describe('C6c-d-2: 미뤄진 방은 마지막 퇴장 때 즉시 dispose된다', () => {
  it('부모 마지막 퇴장 → 방이 바로 없어지고, 10초 안 재입장은 새 파트가 보인다', async () => {
    // C6c-d red: 미뤄진 방이 TTL 30초를 기다리면, 그 안 재입장이 strict를 통과해
    // 옛 Y 상태를 받고, 자동저장이 디스크의 새 첨부를 덮는다.
    setParentQuietMs(60000)
    const sParent = await createSession(HOST_REL)
    const parentRoom = rooms.get(sParent.roomId)!
    const { fakeA } = twoEditors(sParent.roomId)
    const v0 = await parentBytesWithMark(hostAbs(HOST_REL), 'P0XDD-A1')
    const r0 = await applySave(sParent.roomId, v0, {
      kind: parentRoom.kind,
      baseHash: rooms.get(sParent.roomId)!.lastHash,
      clientId: 1,
    })
    expect('newHash' in r0).toBe(true)
    const adoptBase = (r0 as { newHash: string }).newHash
    parentTyping(sParent.roomId, 'P0XDD-T1', fakeA)
    const sPart = await createSession(HOST_REL, { part: PART })
    const eBytes = await partInnerWithMark(hostAbs(HOST_REL), PART, 'P0XDD-E1')
    await partSaveWithSettle(rooms.get(sPart.roomId)!.id, eBytes, sParent.roomId, v0, adoptBase, 1)
    expect(rooms.get(sParent.roomId)?.pendingPartReset).toBeTruthy()
    // 마지막 퇴장: 두 conn을 모두 끊는다.
    const room = rooms.get(sParent.roomId)!
    for (const ws of [...room.conns.keys()]) removeConn(sParent.roomId, ws)
    expect(rooms.get(sParent.roomId)).toBeUndefined()
    // 10초 안 재입장: 새 방이 디스크(새 파트) 기준으로 선다 (host, 미뤄짐 없음).
    const s2 = await createSession(HOST_REL)
    expect(s2.role).toBe('host')
    expect(rooms.get(s2.roomId)?.pendingPartReset).toBeFalsy()
    expect(await partMark()).toContain('P0XDD-E1')
  }, 60000)
})

describe('C6c-d-3: 조용한 구간이 안 와도 최대 상한 안에는 리셋된다', () => {
  it('계속 입력해도 상한이 지나면 리셋된다 (타이머만, 폴링 없음)', async () => {
    // C6c-d red: 조용한 구간 타이머가 입력마다 다시 시작되면, 계속 입력하는
    // 동안에는 리셋이 영원히 안 온다. 상한 타이머가 끊는다.
    setParentQuietMs(1000)
    setParentResetMaxMs(2500)
    const sParent = await createSession(HOST_REL)
    const { fakeA } = twoEditors(sParent.roomId)
    const v0 = await parentBytesWithMark(hostAbs(HOST_REL), 'P0XDD-A1')
    const r0 = await applySave(sParent.roomId, v0, {
      kind: rooms.get(sParent.roomId)!.kind,
      baseHash: rooms.get(sParent.roomId)!.lastHash,
      clientId: 1,
    })
    expect('newHash' in r0).toBe(true)
    const adoptBase = (r0 as { newHash: string }).newHash
    parentTyping(sParent.roomId, 'P0XDD-T1', fakeA)
    const sPart = await createSession(HOST_REL, { part: PART })
    const eBytes = await partInnerWithMark(hostAbs(HOST_REL), PART, 'P0XDD-E1')
    await partSaveWithSettle(rooms.get(sPart.roomId)!.id, eBytes, sParent.roomId, v0, adoptBase, 1)
    expect(rooms.get(sParent.roomId)?.pendingPartReset).toBeTruthy()
    // 1초 quiet 창을 계속 깨면서 상한(2.5초)을 넘긴다.
    for (let n = 0; n < 5; n += 1) {
      await new Promise((r) => setTimeout(r, 700))
      if (!rooms.get(sParent.roomId)) break
      parentTyping(sParent.roomId, `P0XDD-TK${n}`, fakeA)
    }
    await new Promise((r) => setTimeout(r, 1200))
    expect(rooms.get(sParent.roomId)).toBeUndefined()
    expect(resetStats(sParent.roomId)?.total ?? 0).toBe(1)
  }, 60000)
})

describe('C6c-e: 미뤄진 동안 부모가 첨부를 삭제하고 저장하면 부활하지 않는다', () => {
  it('rel 없는 파트는 다시 끼우지 않는다 (삭제 존중, 200)', async () => {
    // P0: 미뤄진 동안 사용자가 첨부 개체를 삭제하면, 들어온 바이트에
    // rel이 없다. 병합(re-embed)은 rel 기준으로만 끼워야 하며,
    // rel이 없으면 건너뛰어 삭제가 유지돼야 한다 (부활 금지).
    setParentQuietMs(60000)
    const sParent = await createSession(HOST_REL)
    const parentRoom = rooms.get(sParent.roomId)!
    const { fakeA } = twoEditors(sParent.roomId)
    const v0 = await parentBytesWithMark(hostAbs(HOST_REL), 'P0XE-A1')
    const r0 = await applySave(sParent.roomId, v0, {
      kind: parentRoom.kind,
      baseHash: rooms.get(sParent.roomId)!.lastHash,
      clientId: 1,
    })
    expect('newHash' in r0).toBe(true)
    const adoptBase = (r0 as { newHash: string }).newHash
    parentTyping(sParent.roomId, 'P0XE-T1', fakeA)
    const sPart = await createSession(HOST_REL, { part: PART })
    const eBytes = await partInnerWithMark(hostAbs(HOST_REL), PART, 'P0XE-E1')
    await partSaveWithSettle(rooms.get(sPart.roomId)!.id, eBytes, sParent.roomId, v0, adoptBase, 1)
    expect(rooms.get(sParent.roomId)?.pendingPartReset).toBeTruthy()
    // 현재 디스크(adopt 반영됨)에서 파트 파일 + rel을 지운다: 사용자 삭제 시뮬레이션.
    const noPartBytes = await parentBytesWithoutPart(hostAbs(HOST_REL), PART)
    // 유효한 base(현재 방 해시)로 삭제분 저장 → 200이어야 한다 (차단·부활 금지).
    const dR = await applySave(sParent.roomId, noPartBytes, {
      kind: parentRoom.kind,
      baseHash: rooms.get(sParent.roomId)!.lastHash,
      clientId: 1,
    })
    expect('newHash' in dR).toBe(true)
    // 디스크에 파트가 부활하지 않았다.
    const diskZip = await JSZip.loadAsync(await fs.readFile(hostAbs(HOST_REL)))
    expect(diskZip.file(PART)).toBeNull()
    expect(await partHasRel(hostAbs(HOST_REL), PART)).toBe(false)
    // 부모 입력 내용은 그대로 남는다 (삭제 외 부분 유실 없음).
    expect(await slideMark()).toContain('P0XE-A1')
  }, 60000)
})
