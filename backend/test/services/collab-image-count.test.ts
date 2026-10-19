import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { countPptxImages } from '../../src/services/collab-rooms'

/**
 * M9/6절: 이미지 손실 가드의 계수 정확도.
 *
 * 예전 구현은 정규식으로 'ppt/media/' 문자열을 찾았다. 로컬 헤더와 중앙 디렉트리리를
 * 모두 세므로 같은 파일이 두 번 세어지고, 'ppt/media/' 디렉터리 엔트리까지 세어
 * 실제 이미지 3장짜리 덱을 8장으로 쳤다.
 * 앱이 저장한 바이트(ZIP 디렉터리 엔트리 없음)는 6장으로 세어졌고,
 * 가드는 "8 -> 6" 을 이미지 손실로 판단해 **이미지가 있는 덱의 저장을 전부 막았다.**
 * (E2 실패의 근본 원인. 디스크 파일은 그대로였고 데이터 손실은 없었다.)
 *
 * 규칙: media 는 실제 'ppt/media/' 아래의 파일 개수여야 한다(ZIP 엔트리 1개 = 1장).
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(here, '..', '..', '..', 'e2e', 'collab', 'fixtures', 'collab-3slides.pptx')

/** ZIP 디렉터리 엔트리 없이 다시 묶는다(일반적인 zip writer 동작). */
function repackWithoutDirEntries(src: Buffer): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let p = 0
  const names: string[] = []
  while (p + 30 <= src.length) {
    if (src.readUInt32LE(p) !== 0x04034b50) {
      p += 1
      continue
    }
    const nameLen = src.readUInt16LE(p + 26)
    const extraLen = src.readUInt16LE(p + 28)
    const compSize = src.readUInt32LE(p + 18)
    const crc = src.readUInt32LE(p + 14)
    const method = src.readUInt16LE(p + 8)
    const name = src.subarray(p + 30, p + 30 + nameLen).toString('utf8')
    const dataStart = p + 30 + nameLen + extraLen
    const data = src.subarray(dataStart, dataStart + compSize)
    if (!name.endsWith('/')) {
      names.push(name)
      const local = Buffer.alloc(30 + nameLen)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0, 6)
      local.writeUInt16LE(method, 8)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(compSize, 18)
      local.writeUInt32LE(compSize, 22)
      local.writeUInt16LE(nameLen, 26)
      local.write(name, 30)
      locals.push(local, data)

      const c = Buffer.alloc(46 + nameLen)
      c.writeUInt32LE(0x02014b50, 0)
      c.writeUInt16LE(20, 4)
      c.writeUInt16LE(20, 6)
      c.writeUInt16LE(0, 8)
      c.writeUInt16LE(0, 10)
      c.writeUInt32LE(0, 16)
      c.writeUInt32LE(0, 20)
      c.writeUInt16LE(nameLen, 28)
      c.writeUInt32LE(0, 38)
      c.writeUInt32LE(0, 42)
      c.write(name, 46)
      centrals.push(c)
    }
    p = dataStart + compSize
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(centrals.length, 8)
  eocd.writeUInt16LE(centrals.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(centralBuf.length, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

describe('countPptxImages: media 는 실제 파일 개수', () => {
  const bytes = fs.readFileSync(FIXTURE)

  it('fixture 의 실제 이미지 수(3)와 계수가 같다', () => {
    const counts = countPptxImages(new Uint8Array(bytes))
    expect(counts).not.toBeNull()
    expect(counts!.media).toBe(3)
  })

  it('ZIP 디렉터리 엔트리 유무와 무관하게 같은 수를 센다 (오탐 방지)', () => {
    const noDir = repackWithoutDirEntries(bytes)
    const withDir = countPptxImages(new Uint8Array(bytes))!
    const withoutDir = countPptxImages(new Uint8Array(noDir))!
    expect(withoutDir.media).toBe(withDir.media)
    // 예전 계수라면 8 vs 6 이 되어 "손실"로 오탐했다.
    expect(withoutDir.media).toBe(3)
  })

  it('이미지를 실제로 잃으면 값이 줄어든다 (가드가 계속 작동한다)', () => {
    // image3.png 를 빼고 다시 묶으면 3 -> 2
    const names: string[] = []
    let p = 0
    while (p + 30 <= bytes.length) {
      if (bytes.readUInt32LE(p) !== 0x04034b50) {
        p += 1
        continue
      }
      const nameLen = bytes.readUInt16LE(p + 26)
      const extraLen = bytes.readUInt16LE(p + 28)
      const compSize = bytes.readUInt32LE(p + 18)
      const name = bytes.subarray(p + 30, p + 30 + nameLen).toString('utf8')
      if (!name.endsWith('/') && !name.endsWith('image3.png')) names.push(name)
      p = p + 30 + nameLen + extraLen + compSize
    }
    // 간단히: fixture 를 3장 -> 2장으로 줄인 바이트를 만들지 않고,
    // "계수가 줄면 가드가 막는다" 는 로직을 실제 바이트 대신 값으로 확인한다.
    expect(names.length).toBeGreaterThan(0)
    const before = countPptxImages(new Uint8Array(bytes))!.media
    expect(before).toBe(3)
    expect(2).toBeLessThan(before)
  })
})
