import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'

// files.ts가 모듈 로드 시점에 WORKSPACE_PATH를 캡처하므로 적재 import보다 먼저 env를 깐다.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'collabstricthttp-'))
process.env.WORKSPACE_PATH = tmp

const SEED_DIR = path.join(tmp, 'repos', 'pp')
await fs.mkdir(SEED_DIR, { recursive: true })
const FIX_HOST = path.resolve('..', 'e2e/collab/fixtures/ole/embed-docx.pptx')
await fs.copyFile(FIX_HOST, path.join(SEED_DIR, 'host.pptx'))
const HOST_REL = path.join('repos', 'pp', 'host.pptx')
const PART = 'ppt/embeddings/Microsoft_Word_Document.docx'

const {
  createSession,
  resetCollabForTests,
} = await import('../../src/services/collab-rooms')

const hostAbs = (...p: string[]) => path.join(tmp, ...p)

async function diskPartHash(): Promise<string> {
  const buf = await fs.readFile(hostAbs(HOST_REL))
  const zip = await JSZip.loadAsync(buf)
  const f = zip.file(PART)
  if (!f) throw new Error('part missing')
  return createHash('sha256').update(await f.async('uint8array')).digest('hex')
}

/** 방을 거치지 않고 디스크의 파트를 직접 바꾼다 (외부 변경 시뮬레이션). */
async function tamperPartDisk(marker: string): Promise<void> {
  const file = hostAbs(HOST_REL)
  const zip = await JSZip.loadAsync(await fs.readFile(file))
  const raw = await zip.file(PART)!.async('uint8array')
  const inner = await JSZip.loadAsync(raw)
  const name = 'word/document.xml'
  const cur = await inner.file(name)!.async('string')
  inner.file(name, cur.replace(/C5-0 payload|P0X4[A-Z0-9]*/, marker))
  zip.file(PART, await inner.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
  await fs.writeFile(file, await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
}

beforeEach(() => {
  resetCollabForTests()
})

afterEach(() => {
  resetCollabForTests()
})

describe('P0-4 strict without knownHash (subtle-less http)', () => {
  it('서버가 디스크 해시로 strict 판정 + serverHash 반환', async () => {
    const s = await createSession(HOST_REL, { part: PART, strict: true })
    expect(s.stale).toBeFalsy()
    expect(s.serverHash).toBe(await diskPartHash())
  })

  it('방이 낡았으면 knownHash 없이도 stale_room', async () => {
    await createSession(HOST_REL, { part: PART, strict: true })
    await tamperPartDisk('P0X4EXT')
    const s2 = await createSession(HOST_REL, { part: PART, strict: true })
    expect(s2.stale).toBe(true)
    expect(s2.code).toBe('stale_room')
  })
})
