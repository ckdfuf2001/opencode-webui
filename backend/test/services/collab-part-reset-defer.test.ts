import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import JSZip from 'jszip'
import * as Y from 'yjs'

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
  applySave,
  createSession,
  resetCollabForTests,
  resetStats,
  rooms,
  setParentQuietMs,
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
  const zip = await JSZip.loadAsync(await fs.readFile(hostFile))
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
    setParentQuietMs(300)
    try {
      const sParent = await createSession(HOST_REL)
      const parentRoom = rooms.get(sParent.roomId)!
      const fakeSock = { send: (_b: unknown) => {} }
      parentRoom.conns.set(fakeSock, { joinedAt: Date.now(), clientIds: new Set([1]), lastMsgAt: Date.now() })
      parentRoom.ownerConn = fakeSock
      parentRoom.ownerIds.add(1)
      const sPart = await createSession(HOST_REL, { part: PART })
      const partRoom = rooms.get(sPart.roomId)!
      // 3 라운드: 부모 입력(Y 업데이트) + 부모 저장 + 첨부 저장.
      for (let n = 1; n <= 3; n += 1) {
        parentTyping(sParent.roomId, `P0X9T${n}`, fakeSock)
        const eBytes = await partInnerWithMark(hostAbs(HOST_REL), PART, `P0X9E${n}`)
        const partP = applySave(sPart.roomId, eBytes, {
          kind: partRoom.kind,
          baseHash: rooms.get(sPart.roomId)!.lastHash,
          clientId: 7,
        })
        partP.catch(() => null)
        await new Promise((r) => setTimeout(r, 200))
        const gBytes = await parentBytesWithMark(hostAbs(HOST_REL), `P0X9G${n}`)
        const gR = await applySave(sParent.roomId, gBytes, {
          kind: parentRoom.kind,
          baseHash: rooms.get(sParent.roomId)!.lastHash,
          clientId: 1,
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
      await new Promise((r) => setTimeout(r, 1200))
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
})
