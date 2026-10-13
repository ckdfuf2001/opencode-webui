import { createHash } from 'node:crypto'
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
 * 공동편집 room 레지스트리 (Phase 0).
 *
 * 원칙:
 * - 파일(디스크)이 원본, room(Y.Doc)은 열린 동안만 존재하는 휘발성 상태.
 *   Yjs를 서버에 영구 저장하지 않는다. 마지막 사람이 나가면 폐기.
 * - roomId = 'f_' + sha256(정규화 절대경로)[:40]. mtime을 넣으면 안 된다
 *   (저장할 때마다 room이 갈라진다).
 * - 첫 세션 요청자가 host, 첫 WS 접속 conn이 owner. 저장은 owner만.
 * - role은 클라이언트 권고일 뿐이다. 저장은 서버가 owner 집합으로 강제한다.
 * - 전송은 y-websocket 프로토콜과 호환된다 (message 0=sync, 1=awareness).
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
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  conns: Map<unknown, ConnInfo>
  /** 접속 순서 (owner 선출용). */
  order: unknown[]
  /** 현재 owner conn. */
  ownerConn: unknown | null
  /** owner conn이 기여한 awareness clientID 집합. */
  ownerIds: Set<number>
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
    doc,
    awareness,
    conns: new Map(),
    order: [],
    ownerConn: null,
    ownerIds: new Set(),
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
    if (origin !== null && origin !== undefined && origin === room.ownerConn) {
      added.forEach((cid) => room.ownerIds.add(cid))
      removed.forEach((cid) => room.ownerIds.delete(cid))
    }
    broadcast(room, encodeAwareness([...added, ...updated, ...removed], room.awareness))
  })
  doc.on('update', (update: Uint8Array) => {
    broadcast(room, encodeSyncUpdate(update))
  })
  rooms.set(id, room)
  pathIndex.set(normalizeAbs(absPath), id)
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
  role: 'host' | 'guest'
  fileHash: string
  path: string
}

/**
 * 세션 생성/참가. 파일은 반드시 존재해야 한다(host가 바이트로 seed).
 * 워크스페이스 밖이면 resolveWorkspaceFile이 403을 던진다.
 */
export async function createSession(userPath: string): Promise<SessionResult> {
  const abs = await resolveWorkspaceFile(String(userPath ?? ''))
  if (!abs) throw { message: 'File not found', statusCode: 404 }
  const id = roomIdForAbs(abs)
  const existing = rooms.get(id)
  if (existing) {
    return { roomId: id, role: 'guest', fileHash: existing.lastHash, path: abs }
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
  return { roomId: id, role: 'host', fileHash, path: abs }
}

/** WS 접속 등록. 첫 접속 conn이 owner가 된다. syncStep1 + awareness 스냅샷을 보낸다. */
export function addConn(roomId: string, ws: unknown): CollabRoom | null {
  const room = rooms.get(roomId)
  if (!room) return null
  const sock = ws as CollabSocket
  if (!room.conns.has(ws)) {
    room.conns.set(ws, { joinedAt: Date.now(), clientIds: new Set() })
    room.order.push(ws)
    if (room.ownerConn === null) {
      room.ownerConn = ws
      logger.info(`Collab room ${roomId}: owner conn assigned (first join)`)
    }
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
      logger.info(`Collab room ${room.id}: owner handed off to earliest remaining conn`)
    } else {
      room.ownerIds = new Set()
    }
  }
  if (room.conns.size === 0) disposeRoom(room)
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
}

export function checkSave(roomId: string, clientId: number, byteLength: number): SaveCheck {
  const room = rooms.get(roomId)
  if (!room) return { ok: false, status: 404, error: 'No such room' }
  if (!Number.isInteger(clientId) || !room.ownerIds.has(clientId)) {
    return { ok: false, status: 409, error: 'Only the current owner can save' }
  }
  const ownerConn = room.ownerConn
  if (ownerConn === null || ownerConn === undefined || !room.conns.has(ownerConn)) {
    return { ok: false, status: 409, error: 'Owner is not connected' }
  }
  if (byteLength > MAX_SAVE_BYTES) {
    return { ok: false, status: 413, error: 'File too large' }
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
 * owner 저장 적용. baseHash가 현재 디스크와 다르면 409(외부 변경, 자동 병합 없음).
 */
export async function applySave(
  roomId: string,
  baseHash: string,
  bytes: Uint8Array,
): Promise<{ newHash: string } | { conflict: true; currentHash: string | null }> {
  const room = rooms.get(roomId)
  if (!room) throw { message: 'No such room', statusCode: 404 }
  const disk = await currentDiskHash(roomId)
  if (disk !== baseHash) return { conflict: true, currentHash: disk }
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
  owner?: number[]
}

export function handoff(roomId: string, fromClientId: number, toClientId: number): HandoffResult {
  const room = rooms.get(roomId)
  if (!room) return { ok: false, status: 404, error: 'No such room' }
  if (!room.ownerIds.has(fromClientId)) {
    return { ok: false, status: 409, error: 'Only the current owner can hand off' }
  }
  const toConn = connOfClient(room, toClientId)
  if (toConn === null || toConn === undefined) {
    return { ok: false, status: 409, error: 'Target is not connected' }
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
  externalChanged?: boolean
  diskHash?: string | null
}

/** AI 편집 차단 + 외부변경 배너용 조회. 조용히 inactive를 돌려준다. */
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
  let diskHash: string | null = null
  try {
    diskHash = await hashFile(abs)
  } catch { /* 무시 */ }
  return {
    active: true,
    roomId: id,
    owner: [...room.ownerIds],
    externalChanged: room.externalChanged,
    diskHash,
  }
}

/** 테스트용 리셋. */
export function resetCollabForTests(): void {
  for (const room of [...rooms.values()]) disposeRoom(room)
  rooms.clear()
  pathIndex.clear()
}
