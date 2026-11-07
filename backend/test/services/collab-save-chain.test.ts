import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import JSZip from 'jszip'

// files.ts가 모듈 로드 시점에 WORKSPACE_PATH를 캡처하므로 적재 import보다 먼저 env를 깐다.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'collabsavechain-'))
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

async function readPart(hostFile: string, part: string): Promise<Buffer> {
  const buf = await fs.readFile(hostFile)
  const zip = await JSZip.loadAsync(buf)
  const f = zip.file(part)
  if (!f) throw new Error('part missing: ' + part)
  return Buffer.from(await f.async('uint8array'))
}

async function parentBytesWithSlideMark(hostFile: string, mark: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await fs.readFile(hostFile))
  const name = 'ppt/slides/slide1.xml'
  const cur = await zip.file(name)!.async('string')
  const next = cur.replace(/C5-0 host|P0X1P\d/, mark)
  if (next === cur) throw new Error('fixture changed: no slide anchor text')
  zip.file(name, next)
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
}

async function partBytesWithMark(hostFile: string, part: string, mark: string): Promise<Uint8Array> {
  const inner = await JSZip.loadAsync(await readPart(hostFile, part))
  const name = 'word/document.xml'
  const cur = await inner.file(name)!.async('string')
  const next = cur.replace(/C5-0 payload|P0X1E\d/, mark)
  if (next === cur) throw new Error('fixture changed: no part anchor text')
  inner.file(name, next)
  return new Uint8Array(await inner.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
}

async function finalTexts(hostFile: string, part: string): Promise<{ slide: string; doc: string }> {
  const zip = await JSZip.loadAsync(await fs.readFile(hostFile))
  const slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
  const inner = await JSZip.loadAsync(await readPart(hostFile, part))
  const doc = (await inner.file('word/document.xml')!.async('string')).replace(/<[^>]*>/g, '')
  return { slide, doc }
}

beforeEach(() => {
  resetCollabForTests()
})

afterEach(() => {
  resetCollabForTests()
})

describe('P0-1 parent-path save serialization', () => {
  it('부모 방과 파트 방의 동시 저장이 모두 반영된다 (3라운드)', async () => {
    for (let round = 0; round < 3; round++) {
      // 파트 저장은 부모 방을 adopt+reset하므로(서버가 부모 lastHash를 새 부모로
      // 갱신하고 방을 리셋) 라운드마다 세션을 다시 붙는다 — 실제 클라이언트와 같다.
      const sParent = await createSession(HOST_REL)
      const sPart = await createSession(HOST_REL, { part: PART })
      const parentRoom = rooms.get(sParent.roomId)!
      const partRoom = rooms.get(sPart.roomId)!
      expect(parentRoom).toBeTruthy()
      expect(partRoom.part?.part).toBe(PART)
      const pMark = `P0X1P${round}`
      const eMark = `P0X1E${round}`
      const host = hostAbs(HOST_REL)
      const pBytes = await parentBytesWithSlideMark(host, pMark)
      const eBytes = await partBytesWithMark(host, PART, eMark)
      const [r1, r2] = await Promise.all([
        applySave(sParent.roomId, pBytes, {
          kind: parentRoom.kind,
          baseHash: rooms.get(sParent.roomId)!.lastHash,
          clientId: 11,
        }),
        applySave(sPart.roomId, eBytes, {
          kind: partRoom.kind,
          baseHash: rooms.get(sPart.roomId)!.lastHash,
          clientId: 22,
        }),
      ])
      // 조용한 유실이 아니라면 둘 다 성공한다 (충돌이면 큰 소리로 409).
      expect(r1).not.toHaveProperty('conflict')
      expect(r2).not.toHaveProperty('conflict')
      const t = await finalTexts(host, PART)
      expect(t.slide).toContain(pMark)
      expect(t.doc).toContain(eMark)
    }
  })
})
