import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { Hono } from 'hono'

// files.ts가 모듈 로드 시점에 WORKSPACE_PATH를 캡처하므로 적재 import보다 먼저 env를 깐다.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'collabstricthttp-'))
process.env.WORKSPACE_PATH = tmp

const SEED_DIR = path.join(tmp, 'repos', 'pp')
await fs.mkdir(SEED_DIR, { recursive: true })
const FIX_HOST = path.resolve('..', 'e2e/collab/fixtures/ole/embed-docx.pptx')
await fs.copyFile(FIX_HOST, path.join(SEED_DIR, 'host.pptx'))
const HOST_REL = path.join('pp', 'host.pptx')
const HOST_FS = path.join('repos', 'pp', 'host.pptx')
const PART = 'ppt/embeddings/Microsoft_Word_Document.docx'

const rooms = await import('../../src/services/collab-rooms')
const { createSession, resetCollabForTests } = rooms
const { createCollabRoutes } = await import('../../src/routes/collab')

const hostAbs = (...p: string[]) => path.join(tmp, ...p)

async function diskPartBytes(): Promise<Buffer> {
  const buf = await fs.readFile(hostAbs(HOST_FS))
  const zip = await JSZip.loadAsync(buf)
  const f = zip.file(PART)
  if (!f) throw new Error('part missing')
  return Buffer.from(await f.async('uint8array'))
}

function partHashOf(b: Uint8Array | Buffer): string {
  return createHash('sha256').update(b).digest('hex')
}

/** 외부 변경 시뮬레이션: 방을 거치지 않고 디스크 파트를 직접 바꾼다. */
async function tamperDiskPart(marker: string): Promise<void> {
  const file = hostAbs(HOST_FS)
  const zip = await JSZip.loadAsync(await fs.readFile(file))
  const raw = await zip.file(PART)!.async('uint8array')
  const inner = await JSZip.loadAsync(raw)
  const name = 'word/document.xml'
  const cur = await inner.file(name)!.async('string')
  inner.file(name, cur.replace(/C5-0 payload|P0X5[A-Z0-9]*/, marker))
  zip.file(PART, await inner.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
  await fs.writeFile(file, await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
}

function collabApp(): Hono {
  const root = new Hono()
  root.route('/api/collab', createCollabRoutes())
  return root
}

beforeEach(() => {
  resetCollabForTests()
})

afterEach(() => {
  resetCollabForTests()
})

describe('P0-4 http subtle-less strict (server-issued part ETag)', () => {
  it('GET /embed가 파트 바이트 해시를 돌려준다', async () => {
    const app = collabApp()
    const res = await app.request(`/api/collab/embed?path=${encodeURIComponent(HOST_REL)}&part=${encodeURIComponent(PART)}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { partHash?: unknown; hash?: unknown }
    expect(typeof body.partHash).toBe('string')
    expect(body.partHash).toBe(partHashOf(await diskPartBytes()))
  })

  it('GET ETag를 knownHash로 쓰면 디스크 변경 뒤 세션이 stale_client다', async () => {
    // 1) GET: 바이트와 함께 ETag를 받는다 (이게 클라이언트가 가진 전부다).
    const app = collabApp()
    const r1 = await app.request(`/api/collab/embed?path=${encodeURIComponent(HOST_REL)}&part=${encodeURIComponent(PART)}`)
    const b1 = (await r1.json()) as { partHash: string }
    // 2) 그 사이 디스크가 바뀐다.
    await tamperDiskPart('P0X5EXT')
    // 3) 세션 strict + ETag knownHash → stale_client (subtle 없이도 검증된다).
    const s = await createSession(HOST_REL, { part: PART, strict: true, knownHash: b1.partHash })
    expect(s.stale).toBe(true)
    expect(s.code).toBe('stale_client')
  })

  it('방이 낡았으면 knownHash 없어도 stale_room이다', async () => {
    await createSession(HOST_REL, { part: PART, strict: true })
    await tamperDiskPart('P0X5EXT2')
    const s2 = await createSession(HOST_REL, { part: PART, strict: true })
    expect(s2.stale).toBe(true)
    expect(s2.code).toBe('stale_room')
  })
})
