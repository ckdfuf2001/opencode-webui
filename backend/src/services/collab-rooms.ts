import { createHash, randomUUID } from 'node:crypto'
import { promises as fs, watch as fsWatch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { resolveWorkspaceFile } from './files'
import { writeFileContent } from './file-operations'
import { logger } from '../utils/logger'

/**
 * 공동편집 room 레지스트리 (Phase 0 + v0.12.50).
 *
 * 원칙:
 * - 파일(디스크)이 원본, room(Y.Doc)은 열린 동안만 존재하는 휘발성 상태.
 *   Yjs를 서버에 영구 저장하지 않는다. 마지막 사람이 나가면 폐기(0명 30초 TTL).
 * - roomId = 'f_' + sha256(정규화 절대경로)[:40]. mtime을 넣으면 안 된다
 *   (저장할 때마다 room이 갈라진다).
 * - room마다 epoch(UUID). 서버 재시작 등으로 room이 새로 만들어지면 epoch가
 *   바뀌고, 이전 epoch의 resume은 거부된다.
 * - 첫 세션 요청자가 host, 첫 WS 접속 conn이 owner. 저장은 owner만.
 * - role은 클라이언트 권고일 뿐이다. 저장은 서버가 owner 집합으로 강제한다.
 * - 충돌 판정은 서버의 lastHash 기준이다. 클라이언트 baseHash는 진단용.
 * - seed 전(아무 update도 받지 않은 doc)의 저장은 거부한다.
 *
 * 알려진 한계: 백엔드 재시작 직전 5초 안에 owner가 저장했다면, guest의
 * knownHash가 오래돼서 resume이 409로 거부될 수 있다. 이 경우에도 사본
 * 다운로드로 안전하게 빠지므로 허용한다.
 */

export interface CollabSocket {
  send(data: Uint8Array): void
}

interface ConnInfo {
  joinedAt: number
  clientIds: Set<number>
}

export interface CollabRoom {
  id: string
  /** 정규화된 절대경로. */
  path: string
  /** room 세대. 서버 재시작 등으로 room이 다시 만들어지면 바뀐다. */
  epoch: string
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  conns: Map<unknown, ConnInfo>
  /** 접속 순서 (owner 선출용). */
  order: unknown[]
  /** 현재 owner conn. */
  ownerConn: unknown | null
  /** owner conn이 기여한 awareness clientID 집합. */
  ownerIds: Set<number>
  /** owner였던 clientID (재접속 승격 판단용, dispose 때만 초기화). */
  everOwner: Set<number>
  /** 한 번이라도 WS가 붙은 적 있는가 (고아 재활용 판단용). */
  everConnected: boolean
  /** 원격 update를 한 번이라도 받은 doc인가 (seed 여부). */
  seeded: boolean
  /** conns가 0이 된 시각 (TTL용, null이면 비어 있지 않음). */
  emptySince: number | null
  watcher: FSWatcher | null
  watchTimer: ReturnType<typeof setTimeout> | null
  /** 마지막으로 우리가 저장한(또는 room 생성 시 읽은) 해시. */
  lastHash: string
  externalChanged: boolean
}

export const rooms = new Map<string, CollabRoom>()
/** path(abs 정규화) -> roomId. 같은 파일을 두 room이 열지 않게 한다. */
const pathIndex = new Map<string, string>()

export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
export const MAX_SAVE_BYTES = 50 * 1024 * 1024
/** 0명 room 유지 시간. 짧은 재연결 동안 room을 살린다. */
let roomTtlMs = 30_000
export function setRoomTtlMs(ms: number): void {
  roomTtlMs = ms
}

let sweepTimer: ReturnType<typeof setInterval> | null = null
/** 0명 room TTL 만료분을 정리한다. 테스트에서 직접 호출 가능. */
export function sweepRooms(now: number = Date.now()): void {
  for (const room of [...rooms.values()]) {
    if (room.conns.size === 0 && room.emptySince !== null && now - room.emptySince >= roomTtlMs) {
      logger.info(`Collab room ${room.id} expired after ${roomTtlMs}ms empty`)
      disposeRoom(room)
    }
  }
}
function ensureSweeper(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    sweepRooms()
    if (rooms.size === 0 && sweepTimer) {
      clearInterval(sweepTimer)
      sweepTimer = null
    }
  }, 10_000)
  const t = sweepTimer as unknown as { unref?: () => void }
  if (typeof t.unref === 'function') t.unref()
}

export function normalizeAbs(p: string): string {
  const fwd = path.resolve(p).replace(/\\/g, '/')
  return process.platform === 'win32' ? fwd.toLowerCase() : fwd
}

export function roomIdForAbs(absPath: string): string {
  const h = createHash('sha256').update(normalizeAbs(absPath), 'utf8').digest('hex')
  return `f_${h.slice(0, 40)}`
}

export function isValidRoomId(id: string): boolean {
  return ROOM_ID_RE.test(id)
}

export async function hashFile(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath)
  return createHash('sha256').update(buf).digest('hex')
}

export function hashBytes(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

function sendTo(room: CollabRoom, ws: unknown, data: Uint8Array): void {
  try {
    ;(ws as CollabSocket).send(data)
  } catch (error) {
    logger.warn(`Collab room ${room.id}: send failed, dropping conn`)
    dropConnFromRoom(room, ws)
  }
}

function broadcast(room: CollabRoom, data: Uint8Array): void {
  for (const ws of [...room.conns.keys()]) sendTo(room, ws, data)
}

/** y-websocket message 0 + sync.update 래핑. */
function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, 0)
  syncProtocol.writeUpdate(e, update)
  return encoding.toUint8Array(e)
}

function encodeAwareness(clients: number[], awareness: awarenessProtocol.Awareness): Uint8Array {
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, 1)
  encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(awareness, clients))
  return encoding.toUint8Array(e)
}

function createRoom(id: string, absPath: string, seedHash: string): CollabRoom {
  const doc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(doc)
  awareness.setLocalState(null)
  const room: CollabRoom = {
    id,
    path: absPath,
    epoch: randomUUID(),
    doc,
    awareness,
    conns: new Map(),
    order: [],
    ownerConn: null,
    ownerIds: new Set(),
    everOwner: new Set(),
    everConnected: false,
    seeded: false,
    emptySince: Date.now(),
    watcher: null,
    watchTimer: null,
    lastHash: seedHash,
    externalChanged: false,
  }
  awareness.on('update', (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    const info = room.conns.get(origin)
    if (info) {
      added.forEach((cid) => info.clientIds.add(cid))
      removed.forEach((cid) => info.clientIds.delete(cid))
    }
    // owner는 "살아 있음이 증명된 첫 conn"이다 (접속 순서가 아니라 awareness 기준).
    // 이렇게 해야 재접속한 이전 owner가 게스트보다 늦게 붙어도 복원된다.
    if (room.ownerConn === null && origin !== null && origin !== undefined && added.length > 0) {
      room.ownerConn = origin
      logger.info(`Collab room ${room.id}: owner conn assigned (first live awareness)`)
    }
    if (origin !== null && origin !== undefined && origin === room.ownerConn) {
      added.forEach((cid) => {
        room.ownerIds.add(cid)
        room.everOwner.add(cid)
      })
      removed.forEach((cid) => room.ownerIds.delete(cid))
    }
    broadcast(room, encodeAwareness([...added, ...updated, ...removed], room.awareness))
  })
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    // 서버는 직접 쓰지 않으므로 origin이 있는 update는 전부 원격 내용이다.
    if (origin !== null && origin !== undefined) room.seeded = true
    broadcast(room, encodeSyncUpdate(update))
  })
  rooms.set(id, room)
  pathIndex.set(normalizeAbs(absPath), id)
  ensureSweeper()
  return room
}

function startWatch(room: CollabRoom): void {
  if (room.watcher) return
  try {
    const dir = path.dirname(room.path)
    const base = path.basename(room.path)
    room.watcher = fsWatch(dir, (event, filename) => {
      const hit = typeof filename === 'string'
        ? filename === base
        : filename != null && filename.toString() === base
      if (!hit) return
      if (room.watchTimer) clearTimeout(room.watchTimer)
      room.watchTimer = setTimeout(() => {
        void (async () => {
          try {
            const h = await hashFile(room.path)
            // 우리 저장 직후 해시와 같으면 무시한다.
            if (h !== room.lastHash && !room.externalChanged) {
              logger.warn(`Collab room ${room.id}: external change detected (not from owner save)`)
              room.externalChanged = true
            }
          } catch {
            room.externalChanged = true
          }
        })()
      }, 400)
    })
    room.watcher.on('error', () => {
      try { room.watcher?.close() } catch { /* 무시 */ }
      room.watcher = null
    })
  } catch (error) {
    logger.warn(`Collab room ${room.id}: watch failed:`, error)
  }
}

function stopWatch(room: CollabRoom): void {
  if (room.watchTimer) {
    clearTimeout(room.watchTimer)
    room.watchTimer = null
  }
  if (room.watcher) {
    try { room.watcher.close() } catch { /* 무시 */ }
    room.watcher = null
  }
}

function disposeRoom(room: CollabRoom): void {
  stopWatch(room)
  try { room.doc.destroy() } catch { /* 무시 */ }
  rooms.delete(room.id)
  const key = normalizeAbs(room.path)
  if (pathIndex.get(key) === room.id) pathIndex.delete(key)
  logger.info(`Collab room ${room.id} disposed (last conn left)`)
}

export interface SessionResult {
  roomId: string
  role: 'host' | 'guest' | 'resume'
  epoch: string
  lastHash: string
  path: string
}

export interface ResumeOptions {
  resumeEpoch?: string
  knownHash?: string
  /** 재접속 클라이언트의 Y clientID (owner 복원 판단용). */
  clientId?: number
}

/**
 * 세션 생성/참가/재개.
 *
 * | 상황 | 처리 |
 * |---|---|---|
 * | room 없음, resume 없음 | 새 epoch 발급, role=host(seed) |
 * | room 없음, resume 있음, 디스크 == knownHash | epoch 유지하고 재생성, role=resume(seed 금지) |
 * | room 없음, resume 있음, 디스크 != knownHash | 409 external_change |
 * | room 있음, resume 없음 | join, role=guest. 단 conns==0이면 dispose 후 host로 재생성 |
 * | room 있음, epoch 일치 | join (이전 owner였으면 즉시 복원) |
 * | room 있음, epoch 불일치 | 409 epoch_mismatch |
 */
export async function createSession(
  userPath: string,
  opts?: ResumeOptions,
): Promise<SessionResult> {
  const abs = await resolveWorkspaceFile(String(userPath ?? ''))
  if (!abs) throw { message: 'File not found', statusCode: 404 }
  const id = roomIdForAbs(abs)
  const resumeEpoch = opts?.resumeEpoch
  const existing = rooms.get(id)

  if (!existing) {
    if (resumeEpoch) {
      let disk: string | null = null
      try {
        disk = await hashFile(abs)
      } catch {
        throw { message: 'File not readable', statusCode: 404 }
      }
      if (disk !== opts?.knownHash) {
        throw { message: 'File changed while away (no auto-merge)', statusCode: 409, code: 'external_change', currentHash: disk }
      }
      const room = createRoom(id, abs, disk)
      room.epoch = resumeEpoch
      startWatch(room)
      logger.info(`Collab room ${id} re-created on resume (epoch kept)`)
      return { roomId: id, role: 'resume', epoch: resumeEpoch, lastHash: disk, path: abs }
    }
    let fileHash: string
    try {
      fileHash = await hashFile(abs)
    } catch {
      throw { message: 'File not readable', statusCode: 404 }
    }
    const room = createRoom(id, abs, fileHash)
    startWatch(room)
    logger.info(`Collab room ${id} created for ${abs}`)
    return { roomId: id, role: 'host', epoch: room.epoch, lastHash: fileHash, path: abs }
  }

  if (!resumeEpoch) {
    if (existing.conns.size === 0 && existing.everConnected) {
      // 붙었다 나간 고아 room: 정리하고 host로 재생성한다.
      // (한 번도 붙지 않은 room은 host가 오는 중일 수 있어 guest로 참가한다.
      // 무조건 재생성하면 host 세션-POST와 guest WS-connect 사이 경합에서
      // host 방을 guest가 빼앗는 레이스가 생긴다.)
      disposeRoom(existing)
      let fileHash: string
      try {
        fileHash = await hashFile(abs)
      } catch {
        throw { message: 'File not readable', statusCode: 404 }
      }
      const room = createRoom(id, abs, fileHash)
      startWatch(room)
      logger.info(`Collab room ${id} re-created (orphan disposed, host)`)
      return { roomId: id, role: 'host', epoch: room.epoch, lastHash: fileHash, path: abs }
    }
    return { roomId: id, role: 'guest', epoch: existing.epoch, lastHash: existing.lastHash, path: abs }
  }

  if (resumeEpoch !== existing.epoch) {
    throw { message: 'Another session started this file', statusCode: 409, code: 'epoch_mismatch' }
  }
  // 같은 epoch 복귀: 디스크가 knownHash와 다르면 외부 변경으로 거부한다.
  if (opts?.knownHash !== undefined && opts.knownHash !== null) {
    let disk: string | null = null
    try {
      disk = await hashFile(abs)
    } catch {
      throw { message: 'File not readable', statusCode: 404 }
    }
    if (disk !== opts.knownHash) {
      throw { message: 'File changed while away (no auto-merge)', statusCode: 409, code: 'external_change', currentHash: disk }
    }
  }
  // 같은 epoch 복귀: 이전 owner였으면 즉시 복원한다.
  const cid = opts?.clientId
  if (
    typeof cid === 'number' && Number.isInteger(cid) && existing.everOwner.has(cid)
    && existing.ownerConn === null
  ) {
    existing.ownerIds.add(cid)
  }
  return { roomId: id, role: 'resume', epoch: existing.epoch, lastHash: existing.lastHash, path: abs }
}

/** WS 접속 등록. owner는 첫 awareness가 증명한 conn이 된다. syncStep1 + awareness 스냅샷을 보낸다. */
export function addConn(roomId: string, ws: unknown): CollabRoom | null {
  const room = rooms.get(roomId)
  if (!room) return null
  const sock = ws as CollabSocket
  if (!room.conns.has(ws)) {
    room.conns.set(ws, { joinedAt: Date.now(), clientIds: new Set() })
    room.order.push(ws)
    room.emptySince = null
    room.everConnected = true
  }
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, 0)
  syncProtocol.writeSyncStep1(e, room.doc)
  try {
    sock.send(encoding.toUint8Array(e))
  } catch {
    dropConnFromRoom(room, ws)
    return null
  }
  const states = [...room.awareness.getStates().keys()] as number[]
  if (states.length > 0) {
    try {
      sock.send(encodeAwareness(states, room.awareness))
    } catch { /* 무시 */ }
  }
  return room
}

function connOfClient(room: CollabRoom, clientId: number): unknown | null {
  for (const [ws, info] of room.conns) {
    if (info.clientIds.has(clientId)) return ws
  }
  return null
}

export function isOwner(room: CollabRoom, clientId: number): boolean {
  return room.ownerIds.has(clientId)
}

/** y-websocket 메시지 처리 (0=sync, 1=awareness). */
export function wsMessage(roomId: string, ws: unknown, data: Uint8Array): void {
  const room = rooms.get(roomId)
  if (!room || !room.conns.has(ws)) return
  let d: ReturnType<typeof decoding.createDecoder>
  try {
    d = decoding.createDecoder(data)
  } catch {
    return
  }
  const sock = ws as CollabSocket
  try {
    const messageType = decoding.readVarUint(d)
    if (messageType === 0) {
      const e = encoding.createEncoder()
      encoding.writeVarUint(e, 0)
      syncProtocol.readSyncMessage(d, e, room.doc, ws)
      if (encoding.length(e) > 1) sock.send(encoding.toUint8Array(e))
    } else if (messageType === 1) {
      awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(d), ws)
    }
  } catch (error) {
    logger.warn(`Collab room ${roomId}: bad message ignored`)
  }
}

function dropConnFromRoom(room: CollabRoom, ws: unknown): void {
  const info = room.conns.get(ws)
  if (info) {
    try {
      awarenessProtocol.removeAwarenessStates(room.awareness, [...info.clientIds], null)
    } catch { /* 무시 */ }
    for (const cid of info.clientIds) room.ownerIds.delete(cid)
  }
  room.conns.delete(ws)
  room.order = room.order.filter((w) => w !== ws)
  if (room.ownerConn === ws) {
    room.ownerConn = null
    // 남은 사람 중 가장 먼저 들어온 conn으로 owner 승계.
    const next = room.order[0] ?? null
    if (next !== null && next !== undefined) {
      room.ownerConn = next
      const nextInfo = room.conns.get(next)
      room.ownerIds = new Set(nextInfo ? [...nextInfo.clientIds] : [])
      for (const cid of room.ownerIds) room.everOwner.add(cid)
      logger.info(`Collab room ${room.id}: owner handed off to earliest remaining conn`)
    } else {
      room.ownerIds = new Set()
    }
  }
  if (room.conns.size === 0) {
    room.emptySince = Date.now()
    ensureSweeper()
  }
}

export function removeConn(roomId: string, ws: unknown): void {
  const room = rooms.get(roomId)
  if (!room) return
  dropConnFromRoom(room, ws)
}

export interface SaveCheck {
  ok: boolean
  status?: number
  error?: string
  code?: string
}

export function checkSave(roomId: string, clientId: number, byteLength: number): SaveCheck {
  const room = rooms.get(roomId)
  if (!room) return { ok: false, status: 404, error: 'No such room', code: 'no_room' }
  if (!room.seeded) {
    return { ok: false, status: 409, error: 'Room has no synced content yet', code: 'not_seeded' }
  }
  if (!Number.isInteger(clientId) || !room.ownerIds.has(clientId)) {
    return { ok: false, status: 409, error: 'Only the current owner can save', code: 'not_owner' }
  }
  const ownerConn = room.ownerConn
  if (ownerConn === null || ownerConn === undefined || !room.conns.has(ownerConn)) {
    return { ok: false, status: 409, error: 'Owner is not connected', code: 'owner_offline' }
  }
  if (byteLength > MAX_SAVE_BYTES) {
    return { ok: false, status: 413, error: 'File too large', code: 'too_large' }
  }
  return { ok: true }
}

export async function currentDiskHash(roomId: string): Promise<string | null> {
  const room = rooms.get(roomId)
  if (!room) return null
  try {
    return await hashFile(room.path)
  } catch {
    return null
  }
}

/**
 * owner 저장 적용. 판정은 서버의 lastHash 기준이다 (클라이언트 baseHash는
 * 진단용으로만 받는다). 디스크가 lastHash와 다르면 409 conflict (자동 병합 없음).
 */
export async function applySave(
  roomId: string,
  bytes: Uint8Array,
): Promise<{ newHash: string } | { conflict: true; currentHash: string | null }> {
  const room = rooms.get(roomId)
  if (!room) throw { message: 'No such room', statusCode: 404 }
  const disk = await currentDiskHash(roomId)
  if (disk !== room.lastHash) {
    room.externalChanged = true
    return { conflict: true, currentHash: disk }
  }
  await writeFileContent(room.path, Buffer.from(bytes))
  const newHash = hashBytes(bytes)
  room.lastHash = newHash
  room.externalChanged = false
  return { newHash }
}

export { connOfClient }

export interface HandoffResult {
  ok: boolean
  status?: number
  error?: string
  code?: string
  owner?: number[]
}

export function handoff(roomId: string, fromClientId: number, toClientId: number): HandoffResult {
  const room = rooms.get(roomId)
  if (!room) return { ok: false, status: 404, error: 'No such room', code: 'no_room' }
  if (!room.ownerIds.has(fromClientId)) {
    return { ok: false, status: 409, error: 'Only the current owner can hand off', code: 'not_owner' }
  }
  const toConn = connOfClient(room, toClientId)
  if (toConn === null || toConn === undefined) {
    return { ok: false, status: 409, error: 'Target is not connected', code: 'target_offline' }
  }
  room.ownerConn = toConn
  room.ownerIds = new Set([toClientId])
  logger.info(`Collab room ${roomId}: owner handed off ${fromClientId} -> ${toClientId}`)
  return { ok: true, owner: [...room.ownerIds] }
}

export interface LockInfo {
  active: boolean
  roomId?: string
  owner?: number[]
  epoch?: string
  lastHash?: string
  externalChanged?: boolean
}

/**
 * AI 편집 차단 + 외부변경 배너 + knownHash 갱신용 조회. 조용히 inactive를 돌려준다.
 * poll마다 파일을 hash하지 않는다 (watcher/save 시점의 lastHash를 쓴다).
 */
export async function lockInfo(userPath: string): Promise<LockInfo> {
  let abs: string | null = null
  try {
    abs = await resolveWorkspaceFile(String(userPath ?? ''))
  } catch {
    return { active: false }
  }
  if (!abs) return { active: false }
  const id = pathIndex.get(normalizeAbs(abs)) ?? roomIdForAbs(abs)
  const room = rooms.get(id)
  if (!room || room.conns.size === 0) return { active: false }
  return {
    active: true,
    roomId: id,
    owner: [...room.ownerIds],
    epoch: room.epoch,
    lastHash: room.lastHash,
    externalChanged: room.externalChanged,
  }
}

/** 테스트용 리셋. */
export function resetCollabForTests(): void {
  for (const room of [...rooms.values()]) disposeRoom(room)
  rooms.clear()
  pathIndex.clear()
  roomTtlMs = 30_000
}
