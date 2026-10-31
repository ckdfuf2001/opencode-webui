/**
 * C5-1 O4: OLE 첨부 꺼내기 (순수 함수, 의존성 없음).
 *
 * - rel 타입이 `package`면 임베딩 파트 자체가 원본 파일이다.
 * - rel 타입이 `oleObject`면 CFB 컨테이너 안의 Ole10Native 스트림을 풀어
 *   원본 파일명과 바이트를 꺼낸다.
 * - 보안: 파일명 살균(경로 제거·위험 문자 제거), MIME 고정(octet-stream,
 *   다운로드 전용), 크기 필드가 실제보다 크면 거부.
 */

export type OleRelType = 'package' | 'oleObject'

export interface OleExtractedFile {
  fileName: string
  mimeType: 'application/octet-stream'
  bytes: Uint8Array
}

export type OleExtractErrorCode =
  | 'not_cfb'
  | 'no_stream'
  | 'truncated'
  | 'bad_size'
  | 'bad_name'
  | 'empty'

export class OleExtractError extends Error {
  readonly code: OleExtractErrorCode
  constructor(code: OleExtractErrorCode, detail?: string) {
    super(`ole extract failed: ${code}${detail ? ` (${detail})` : ''}`)
    this.name = 'OleExtractError'
    this.code = code
  }
}

/** 다운로드 크래시 방지 상한 (C5-2의 20MB 삽입 상한보다 넉넉하게). */
const MAX_BYTES = 500 * 1024 * 1024

function fail(code: OleExtractErrorCode, detail?: string): never {
  throw new OleExtractError(code, detail)
}

/**
 * 파일명 살균: 경로를 떼고, 빈 이름·예약어·위험 문자를 제거한다.
 * 실패하면 fallback(호출자가 준 안전한 이름)을 쓴다.
 */
export function sanitizeOleFileName(raw: string | null | undefined, fallback: string): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? ''
  // 제어문자·윈도우 예약 문자 제거, 앞뒤 점/공백 제거, 길이 제한.
  const cleaned = base
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180)
  if (!cleaned) return fallback
  const lower = cleaned.toLowerCase()
  if (lower === '.' || lower === '..') return fallback
  return cleaned
}

/* ---------------- CFB (Compound File Binary) 최소 리더 ---------------- */

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const FAT_FREE = 0xffffffff
const FAT_END = 0xfffffffe

function u16(view: DataView, off: number): number {
  return view.getUint16(off, true)
}
function u32(view: DataView, off: number): number {
  return view.getUint32(off, true)
}
function i32(view: DataView, off: number): number {
  return view.getInt32(off, true)
}

interface CfbStream {
  bytes: Uint8Array
}

/** 디렉터리에서 이름이 일치하는 스트림을 찾아 체인을 읽는다. */
function readCfbStream(file: Uint8Array, wantName: string): CfbStream {
  if (file.length < 512) fail('not_cfb', 'too small')
  for (let i = 0; i < CFB_MAGIC.length; i++) {
    if (file[i] !== CFB_MAGIC[i]) fail('not_cfb', 'bad magic')
  }
  const view = new DataView(file.buffer, file.byteOffset, file.length)
  const sectorShift = u16(view, 30)
  if (sectorShift !== 9 && sectorShift !== 12) fail('not_cfb', `sectorShift ${sectorShift}`)
  const sectorSize = 1 << sectorShift
  if (file.length < sectorSize) fail('not_cfb', 'short header')
  const numFatSectors = u32(view, 44)
  const firstDirSector = i32(view, 48)
  const miniSectorCutoff = u32(view, 56)
  const firstMiniFatSector = i32(view, 60)
  const firstDifatSector = i32(view, 68)

  const sectorAt = (n: number): Uint8Array => {
    const off = (n + 1) * sectorSize
    if (off + sectorSize > file.length) fail('truncated', 'sector oob')
    return file.subarray(off, off + sectorSize)
  }

  // DIFAT: 헤더 109개 + 체인
  const fatSectors: number[] = []
  for (let i = 0; i < 109; i++) {
    const s = i32(view, 76 + i * 4)
    if (s === -1) break
    fatSectors.push(s)
  }
  let difatNext = firstDifatSector
  // 종료자는 FREESECT(-1)와 ENDOFCHAIN(-2) 둘 다 올 수 있다.
  while (difatNext !== -1 && difatNext !== -2) {
    if (difatNext < 0 || difatNext > 100000) fail('not_cfb', 'difat oob')
    const sec = sectorAt(difatNext)
    const dv = new DataView(sec.buffer, sec.byteOffset, sec.length)
    const count = sectorSize / 4 - 1
    for (let i = 0; i < count; i++) {
      const s = dv.getInt32(i * 4, true)
      if (s === -1) break
      fatSectors.push(s)
    }
    difatNext = dv.getInt32(sectorSize - 4, true)
    if (fatSectors.length > 100000) fail('not_cfb', 'difat loop')
  }
  if (numFatSectors > 0 && fatSectors.length === 0) fail('not_cfb', 'no fat')

  const fat: number[] = []
  for (const fs of fatSectors) {
    if (fs < 0 || fs > 100000) fail('not_cfb', 'fat sector oob')
    const sec = sectorAt(fs)
    const dv = new DataView(sec.buffer, sec.byteOffset, sec.length)
    for (let i = 0; i < sectorSize / 4; i++) fat.push(dv.getUint32(i * 4, true))
  }
  const chainSectors = (start: number): number[] => {
    const out: number[] = []
    let cur = start >>> 0
    while (cur !== FAT_END && cur !== FAT_FREE) {
      if (cur >= fat.length) fail('truncated', 'fat oob')
      out.push(cur)
      cur = fat[cur]! >>> 0
      if (out.length > 1000000) fail('not_cfb', 'fat loop')
    }
    return out
  }
  const chainBytes = (start: number, size: number): Uint8Array => {
    if (size < 0 || size > MAX_BYTES) fail('bad_size', `stream ${size}`)
    // 체인 데이터는 파일 안에 있으므로 파일보다 클 수 없다 (손상 파일 OOM 방지).
    if (size > file.length) fail('bad_size', `stream ${size} > file ${file.length}`)
    const secs = start === FAT_END ? [] : chainSectors(start)
    const out = new Uint8Array(size)
    let copied = 0
    for (const s of secs) {
      if (copied >= size) break
      const sec = sectorAt(s)
      const n = Math.min(sec.length, size - copied)
      out.set(sec.subarray(0, n), copied)
      copied += n
    }
    if (copied < size) fail('truncated', 'short chain')
    return out
  }

  if (firstDirSector < 0) fail('no_stream', 'no dir')
  // 디렉터리: 체인을 끝까지 걸어 엔트리를 모은다 (개수를 미리 알 수 없다).
  const dirSecs = chainSectors(firstDirSector >>> 0)
  if (dirSecs.length > 10000) fail('not_cfb', 'dir too long')
  const dirBytes = new Uint8Array(dirSecs.length * sectorSize)
  dirSecs.forEach((s, i) => dirBytes.set(sectorAt(s), i * sectorSize))
  // 디렉터리 엔트리 128B씩 스캔 (체인 길이는 넉넉히, 엔트리 수로 종료)
  const dv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.length)
  let miniStreamStart = -1
  let miniStreamSize = 0
  type Entry = { name: string; type: number; start: number; size: number }
  const entries: Entry[] = []
  const maxEntries = Math.floor(dirBytes.length / 128)
  for (let i = 0; i < maxEntries; i++) {
    const base = i * 128
    const nameLen = u16(dv, base + 64)
    if (nameLen === 0 || nameLen > 64) continue
    // nameLen은 NUL 포함 바이트 수다.
    const chars: string[] = []
    for (let k = 0; k + 1 < nameLen - 2; k += 2) chars.push(String.fromCharCode(u16(dv, base + k)))
    const entryName = chars.join('')
    const type = dv.getUint8(base + 66)
    const start = i32(dv, base + 116)
    const sizeLow = u32(dv, base + 120)
    entries.push({ name: entryName, type, start, size: sizeLow })
    if (entryName === 'Root Entry' && type === 5) {
      miniStreamStart = start
      miniStreamSize = sizeLow
    }
  }
  const hit = entries.find((e) => e.type === 2 && e.name === wantName)
  if (!hit) fail('no_stream', wantName)
  const readMini = hit.size < miniSectorCutoff
  if (!readMini) return { bytes: chainBytes(hit.start >>> 0, hit.size) }
  // 미니스트림 (64B 섹터, Root Entry 체인 안에 들어 있다)
  if (miniStreamStart < 0) fail('no_stream', 'no ministream')
  const miniFat: number[] = []
  if (firstMiniFatSector >= 0) {
    for (const s of chainSectors(firstMiniFatSector >>> 0)) {
      const sec = sectorAt(s)
      const mdv = new DataView(sec.buffer, sec.byteOffset, sec.length)
      for (let i = 0; i < sec.length / 4; i++) miniFat.push(mdv.getUint32(i * 4, true))
    }
  }
  const miniData = chainBytes(miniStreamStart >>> 0, miniStreamSize)
  const out = new Uint8Array(hit.size)
  let cur = hit.start >>> 0
  let copied = 0
  let guard = 0
  while (copied < hit.size) {
    if (cur >= miniFat.length && miniFat.length > 0) fail('truncated', 'minifat oob')
    const off = cur * 64
    if (off + 64 > miniData.length && miniFat.length === 0) {
      // 미니FAT이 없으면 단일 블록으로 간주
      if (off >= miniData.length) fail('truncated', 'ministream oob')
      const n = Math.min(64, hit.size - copied, miniData.length - off)
      out.set(miniData.subarray(off, off + n), copied)
      copied += n
      break
    }
    if (off + 64 > miniData.length) fail('truncated', 'ministream oob')
    const n = Math.min(64, hit.size - copied)
    out.set(miniData.subarray(off, off + n), copied)
    copied += n
    const nxt = miniFat.length > 0 ? (miniFat[cur] ?? FAT_END) >>> 0 : FAT_END
    if (nxt === FAT_END || nxt === FAT_FREE) break
    cur = nxt
    if (++guard > 1000000) fail('not_cfb', 'minifat loop')
  }
  if (copied < hit.size) fail('truncated', 'short ministream')
  return { bytes: out }
}

/* ---------------- Ole10Native ---------------- */

const OLE10_NATIVE_STREAM = '\x01Ole10Native'

function readAnsiZ(view: DataView, file: Uint8Array, off: number): { text: string; next: number } {
  let end = off
  while (end < file.length && file[end] !== 0) {
    const c = file[end]!
    if (c < 0x20 || c > 0x7e) fail('bad_name', `byte ${c}`)
    end++
  }
  if (end >= file.length) fail('truncated', 'ansiz')
  return { text: new TextDecoder('ascii').decode(file.subarray(off, end)), next: end + 1 }
}

function readU32(view: DataView, off: number, what: string): number {
  if (off + 4 > view.byteLength) fail('truncated', what)
  return u32(view, off)
}

/** Ole10Native 스트림에서 (파일명, 바이트)를 꺼낸다. */
function parseOle10Native(stream: Uint8Array): { fileName: string; bytes: Uint8Array } {
  if (stream.length < 4) fail('truncated', 'native header')
  const view = new DataView(stream.buffer, stream.byteOffset, stream.length)
  const total = readU32(view, 0, 'total')
  if (total !== stream.length - 4) fail('truncated', `total ${total} != ${stream.length - 4}`)
  let off = 4
  if (off + 2 > stream.length) fail('truncated', 'flags')
  off += 2 // flags (보통 2)
  const label = readAnsiZ(view, stream, off)
  off = label.next
  const srcPath = readAnsiZ(view, stream, off)
  void srcPath
  off = srcPath.next
  if (off + 2 > stream.length) fail('truncated', 'u2')
  off += 2
  if (off + 2 > stream.length) fail('truncated', 'u3')
  off += 2 // u3 (보통 3)
  const tmpLen = readU32(view, off, 'tmplen')
  off += 4
  if (tmpLen > stream.length || off + tmpLen > stream.length) fail('bad_size', `tmp ${tmpLen}`)
  off += tmpLen // ANSI 임시 경로 (검증 없이 건너뜀)
  const dataLen = readU32(view, off, 'datalen')
  off += 4
  if (dataLen === 0) fail('empty', 'zero data')
  if (dataLen > MAX_BYTES) fail('bad_size', `data ${dataLen}`)
  if (off + dataLen > stream.length) fail('bad_size', `data ${dataLen} > room ${stream.length - off}`)
  const bytes = stream.slice(off, off + dataLen)
  return { fileName: label.text, bytes }
}

/**
 * 임베딩 파트 바이트에서 원본 첨부를 꺼낸다.
 * - package: 파트 자체가 원본 파일이다.
 * - oleObject: CFB 안 Ole10Native를 푼다.
 */
export function extractOleAttachment(
  entryBytes: Uint8Array,
  relType: OleRelType,
  fallbackName: string,
): OleExtractedFile {
  if (!(entryBytes instanceof Uint8Array) || entryBytes.length === 0) fail('empty', 'no bytes')
  if (entryBytes.length > MAX_BYTES) fail('bad_size', `entry ${entryBytes.length}`)
  if (relType === 'package') {
    return {
      fileName: sanitizeOleFileName(fallbackName, 'attachment.bin'),
      mimeType: 'application/octet-stream',
      bytes: entryBytes.slice(),
    }
  }
  const stream = readCfbStream(entryBytes, OLE10_NATIVE_STREAM)
  const parsed = parseOle10Native(stream.bytes)
  return {
    fileName: sanitizeOleFileName(parsed.fileName, fallbackName),
    mimeType: 'application/octet-stream',
    bytes: parsed.bytes,
  }
}
