import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import JSZip from 'jszip'

// files.ts가 모듈 로드 시점에 WORKSPACE_PATH를 캡처하므로 적재 import보다 먼저 env를 깐다.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'collabpptxstale-'))
process.env.WORKSPACE_PATH = tmp

const SEED_DIR = path.join(tmp, 'repos', 'pp')
await fs.mkdir(SEED_DIR, { recursive: true })
const FIX_HOST = path.resolve('..', 'e2e/collab/fixtures/ole/embed-docx.pptx')
await fs.copyFile(FIX_HOST, path.join(SEED_DIR, 'host.pptx'))
const HOST_REL = path.join('repos', 'pp', 'host.pptx')

const {
  applySave,
  createSession,
  resetCollabForTests,
  rooms,
} = await import('../../src/services/collab-rooms')

const hostAbs = (...p: string[]) => path.join(tmp, ...p)

async function slideSwapped(hostFile: string, from: RegExp, to: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await fs.readFile(hostFile))
  const name = 'ppt/slides/slide1.xml'
  const cur = await zip.file(name)!.async('string')
  const next = cur.replace(from, to)
  if (next === cur) throw new Error('fixture changed: no slide anchor text')
  zip.file(name, next)
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
}

beforeEach(() => {
  resetCollabForTests()
})

afterEach(() => {
  resetCollabForTests()
})

describe('P0-2 PPT stale save blocked', () => {
  it('낡은 baseHash의 PPT 저장은 conflict_room으로 막힌다', async () => {
    const s = await createSession(HOST_REL)
    const room = rooms.get(s.roomId)!
    expect(room.kind).toBe('pptx')
    const host = hostAbs(HOST_REL)
    const fresh = await slideSwapped(host, /C5-0 host/, 'P0X2FRESH')
    const r1 = await applySave(s.roomId, fresh, {
      kind: room.kind,
      baseHash: s.lastHash,
      clientId: 1,
    })
    expect('newHash' in r1).toBe(true)
    // 다른 탭이 먼저 저장한 뒤, 낡은 해시로 덮어쓰면 막힌다.
    const stale = await slideSwapped(host, /P0X2FRESH|C5-0 host/, 'P0X2STALE')
    const r2 = await applySave(s.roomId, stale, {
      kind: room.kind,
      baseHash: s.lastHash,
      clientId: 2,
    })
    expect('conflict' in r2).toBe(true)
    if ('conflict' in r2) expect(r2.code).toBe('conflict_room')
    // baseHash가 없으면 기존 디스크 판정만 유지한다 (하위 호환 — 막지 않는다).
    const r3 = await applySave(s.roomId, fresh, { kind: room.kind, clientId: 3 })
    expect('newHash' in r3).toBe(true)
  })
})
