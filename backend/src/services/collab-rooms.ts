import { createHash, randomUUID } from 'node:crypto'
import { promises as fs, watch as fsWatch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { resolveWorkspaceFile, workspaceRootAbs } from './files'
import { readLibPresence } from '@opencode-webui/shared/lib/collab-presence'
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
  /** 마지막 수신 시각 (D: half-open 감지용). */
  lastMsgAt: number
}

/** 무수신 conn 정리 임계값 (D). 테스트는 sweepDeadConns를 직접 호출한다. */
export const DEAD_CONN_MS = 120_000

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
  /** owner conn이 기여한 awareness clientID 집합 (표시용). */
  ownerIds: Set<number>
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
  /** 4-0 가드용: 마지막으로 계측한 디스크 이미지 수 (undefined=미계측). */
  lastImageCounts: { media: number; refs: number } | null | undefined
  /** 저장 직렬화 체인 (room 단위). */
  saveChain: Promise<void>
  /** 저장 중에는 watcher가 무시한다. */
  saving: boolean
  /** AI 편집이 409로 막힌 마지막 시각 (V7 칩용). */
  aiBlockedAt: number | null
}

export interface CollabParticipant {
  id: string
  name: string
  color: string
  mode: 'view' | 'edit'
  slide?: number
  /** 서버 owner 집합에 awareness clientId가 들어있는가. */
  owner: boolean
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
/** D: 120초 무수신 conn은 half-open으로 보고 정리한다. */
export function sweepDeadConns(now: number = Date.now()): void {
  for (const room of [...rooms.values()]) {
    for (const [ws, info] of [...room.conns.entries()]) {
      if (now - info.lastMsgAt < DEAD_CONN_MS) continue
      logger.info(`Collab room ${room.id}: dropping silent conn`)
      try {
        ;(ws as unknown as { close?: (code?: number) => void }).close?.(1001)
      } catch {
        // 무시
      }
      removeConn(room.id, ws)
    }
  }
}
/** type 99 keepalive: 유휴 room도 lastRxAt가 갱신되게 한다. */
function sendKeepalive(room: CollabRoom): void {
  if (room.conns.size === 0) return
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, 99)
  broadcast(room, encoding.toUint8Array(e))
}
function ensureSweeper(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    sweepRooms()
    sweepDeadConns()
    for (const room of rooms.values()) sendKeepalive(room)
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

/** type 100 room meta (서버→클라이언트 전용, lib은 모름). */
export interface RoomMeta {
  ownerClientId: number | null
  lastHash: string
  epoch: string
  externalChanged: boolean
  aiBlockedAt: number | null
}

function roomMeta(room: CollabRoom): RoomMeta {
  const owner = [...room.ownerIds][0] ?? null
  return {
    ownerClientId: owner,
    lastHash: room.lastHash,
    epoch: room.epoch,
    externalChanged: room.externalChanged,
    aiBlockedAt: room.aiBlockedAt,
  }
}

function encodeMeta(room: CollabRoom): Uint8Array {
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, 100)
  encoding.writeVarUint8Array(e, new TextEncoder().encode(JSON.stringify(roomMeta(room))))
  return encoding.toUint8Array(e)
}

function broadcastMeta(room: CollabRoom): void {
  if (room.conns.size === 0) return
  broadcast(room, encodeMeta(room))
}

/** conn의 모드. app.mode가 전부 view면 'view', 모르면 edit 취급(하위 호환). */
export function connMode(room: CollabRoom, ws: unknown): 'view' | 'edit' {
  const info = room.conns.get(ws)
  if (!info || info.clientIds.size === 0) return 'edit'
  let sawKnown = false
  for (const cid of info.clientIds) {
    const st = room.awareness.getStates().get(cid) as { app?: { mode?: string } } | undefined
    const mode = st?.app?.mode
    if (typeof mode === 'string') {
      sawKnown = true
      if (mode !== 'view') return 'edit'
    }
  }
  return sawKnown ? 'view' : 'edit'
}

/** owner 재선출: edit 참가자 중 가장 먼저 들어온 conn. 없으면 owner 해제. */
function reevaluateOwner(room: CollabRoom): void {
  const current = room.ownerConn
  if (current !== null && current !== undefined && room.conns.has(current) && connMode(room, current) !== 'view') {
    return
  }
  room.ownerConn = null
  room.ownerIds = new Set()
  for (const ws of room.order) {
    if (!room.conns.has(ws)) continue
    if (connMode(room, ws) === 'view') continue
    room.ownerConn = ws
    const info = room.conns.get(ws)
    room.ownerIds = new Set(info ? [...info.clientIds] : [])
    logger.info(`Collab room ${room.id}: owner elected`)
    break
  }
  // owner가 실제로 바뀌었을 때만 푸시한다 (view-only room 스팸 방지).
  if (room.ownerConn !== current) broadcastMeta(room)
}

/** AI 편집 409 시 기록 (V7 칩용). */
export function markAiBlocked(roomId: string): void {
  const room = rooms.get(roomId)
  if (!room) return
  room.aiBlockedAt = Date.now()
  broadcastMeta(room)
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
    everConnected: false,
    seeded: false,
    emptySince: Date.now(),
    watcher: null,
    watchTimer: null,
    lastHash: seedHash,
    externalChanged: false,
    lastImageCounts: undefined,
    saveChain: Promise.resolve(),
    saving: false,
    aiBlockedAt: null,
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
    // owner가 비어 있거나 view-only가 되면 edit 참가자 중 첫 conn을 선출한다.
    if (room.ownerConn === null || !room.conns.has(room.ownerConn)) {
      reevaluateOwner(room)
    } else if (connMode(room, room.ownerConn) === 'view') {
      reevaluateOwner(room)
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
          // 저장 중에 뜬 이벤트는 무시한다 (S6C).
          if (room.saving) return
          try {
            const h = await hashFile(room.path)
            // 우리 저장 직후 해시와 같으면 무시한다.
            if (h !== room.lastHash && !room.externalChanged) {
              logger.warn(`Collab room ${room.id}: external change detected (not from owner save)`)
              room.externalChanged = true
              broadcastMeta(room)
            }
          } catch {
            if (!room.externalChanged) {
              room.externalChanged = true
              broadcastMeta(room)
            }
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
  // 같은 epoch 복귀: 판정은 서버 lastHash 기준이다 (클라이언트 knownHash 아님).
  // 디스크가 마지막 저장과 다르면 외부 변경으로 거부한다.
  {
    let disk: string | null = null
    try {
      disk = await hashFile(abs)
    } catch {
      throw { message: 'File not readable', statusCode: 404 }
    }
    if (disk !== existing.lastHash) {
      throw { message: 'File changed while away (no auto-merge)', statusCode: 409, code: 'external_change', currentHash: disk }
    }
  }
  return { roomId: id, role: 'resume', epoch: existing.epoch, lastHash: existing.lastHash, path: abs }
}

/** WS 접속 등록. owner는 첫 awareness가 증명한 conn이 된다. syncStep1 + awareness 스냅샷을 보낸다. */
export function addConn(roomId: string, ws: unknown): CollabRoom | null {
  const room = rooms.get(roomId)
  if (!room) return null
  const sock = ws as CollabSocket
  if (!room.conns.has(ws)) {
    room.conns.set(ws, { joinedAt: Date.now(), clientIds: new Set(), lastMsgAt: Date.now() })
    room.order.push(ws)
    room.emptySince = null
    room.everConnected = true
    broadcastMeta(room)
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

export function isOwner(room: CollabRoom, clientId: number): boolean {
  return room.ownerIds.has(clientId)
}

/** y-websocket 메시지 처리 (0=sync, 1=awareness). */
export function wsMessage(roomId: string, ws: unknown, data: Uint8Array): void {
  const room = rooms.get(roomId)
  if (!room || !room.conns.has(ws)) return
  room.conns.get(ws)!.lastMsgAt = Date.now()
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
    room.ownerIds = new Set()
    // 남은 edit 참가자 중 가장 먼저 들어온 conn으로 승계.
    reevaluateOwner(room)
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

/** clientId가 현재 ownerConn에 속하는지 검증한다 (S6B). */
function isCurrentOwner(room: CollabRoom, clientId: number): boolean {
  if (!Number.isInteger(clientId)) return false
  const oc = room.ownerConn
  if (oc === null || oc === undefined || !room.conns.has(oc)) return false
  const info = room.conns.get(oc)
  return !!info && info.clientIds.has(clientId)
}

export function checkSave(roomId: string, clientId: number, byteLength: number): SaveCheck {
  const room = rooms.get(roomId)
  if (!room) return { ok: false, status: 404, error: 'No such room', code: 'no_room' }
  if (!room.seeded) {
    return { ok: false, status: 409, error: 'Room has no synced content yet', code: 'not_seeded' }
  }
  if (!isCurrentOwner(room, clientId)) {
    return { ok: false, status: 409, error: 'Only the current owner can save', code: 'not_owner' }
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
 * zip 바이트에서 이미지 파트 수와 slide rel의 image 관계 수를 센다.
 * 이미지 손실 가드(4-0)와 계측에 쓴다. 읽기 실패면 null(판정하지 않음).
 */
export function countPptxImages(
  bytes: Uint8Array,
): { media: number; refs: number } | null {
  try {
    const buf = Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ) as Buffer
    // 로컬 헤더 탐색(중앙 디렉터리 파싱 불필요, 메모리 최소).
    const text = buf.toString('latin1')
    let media = 0
    let refs = 0
    // 파트 이름은 ZIP 로컬 헤더에서 'PK\x03\x04' 뒤 길이 필드 이후에 온다.
    const re = /ppt\/media\/[^\x00]*?(?=\x00)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m[0].length > 'ppt/media/'.length) media += 1
      if (refs > 4000) break
    }
    // image 관계 수: TargetMode 없는 image 관계 Target 개수.
    const reRef = /relationships\/image"[^>]*Target="/g
    while ((m = reRef.exec(text)) !== null) {
      refs += 1
      if (refs > 4000) break
    }
    return { media, refs }
  } catch {
    return null
  }
}

/** 직전 저장본(디스크)의 이미지 계측값. room에 캐시한다. */
async function diskImageCounts(room: CollabRoom): Promise<{ media: number; refs: number } | null> {
  if (room.lastImageCounts !== undefined) return room.lastImageCounts
  try {
    const buf = await fs.readFile(room.path)
    const counts = countPptxImages(new Uint8Array(buf))
    room.lastImageCounts = counts
    return counts
  } catch {
    return null
  }
}

/**
 * owner 저장 적용. 판정은 서버의 lastHash 기준이다 (클라이언트 baseHash는
 * 진단용으로만 받는다). 디스크가 lastHash와 다르면 409 conflict (자동 병합 없음).
 * room 단위 체인으로 직렬화한다 (S6C).
 * 이미지 손실이 감지되면 저장하지 않고 409 image_loss로 거절한다 (4-0 가드).
 */
export async function applySave(
  roomId: string,
  bytes: Uint8Array,
  opts?: { allowImageLoss?: boolean },
): Promise<
  | { newHash: string }
  | { conflict: true; currentHash: string | null }
  | { imageLoss: true; before: { media: number; refs: number }; after: { media: number; refs: number } }
> {
  const room = rooms.get(roomId)
  if (!room) throw { message: 'No such room', statusCode: 404 }
  const run = room.saveChain.then(async () => {
    const disk = await currentDiskHash(roomId)
    if (disk !== room.lastHash) {
      room.externalChanged = true
      broadcastMeta(room)
      const r: { conflict: true; currentHash: string | null } = { conflict: true, currentHash: disk }
      return r
    }
    // 4-0 가드: pptx 저장에서 이미지(파트·관계)가 줄었으면 막는다.
    // 명시적 승인(allowImageLoss)이 있을 때만 통과한다.
    if (!opts?.allowImageLoss && /\.pptx$/i.test(room.path)) {
      const before = await diskImageCounts(room)
      const after = countPptxImages(bytes)
      if (before && after && (after.media < before.media || after.refs < before.refs)) {
        logger.warn(
          `Collab room ${room.id}: image loss blocked (media ${before.media}->${after.media}, refs ${before.refs}->${after.refs})`,
        )
        const r: {
          imageLoss: true
          before: { media: number; refs: number }
          after: { media: number; refs: number }
        } = { imageLoss: true, before, after }
        return r
      }
    }
    room.saving = true
    try {
      await writeFileContent(room.path, Buffer.from(bytes))
    } finally {
      room.saving = false
    }
    const newHash = hashBytes(bytes)
    room.lastHash = newHash
    room.externalChanged = false
    if (/\.pptx$/i.test(room.path)) room.lastImageCounts = countPptxImages(bytes)
    broadcastMeta(room)
    const r: { newHash: string } = { newHash: newHash }
    return r
  })
  room.saveChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** awareness에서 참가자 목록을 읽는다 (서버는 읽기만, publish 금지). */
export function roomParticipants(room: CollabRoom): CollabParticipant[] {
  const out: CollabParticipant[] = []
  try {
    const states = room.awareness.getStates() as Map<number, {
      app?: { id?: string; name?: string; color?: string; mode?: string }
      userName?: string
    }>
    for (const [cid, st] of states) {
      const app = st?.app
      if (!app || typeof app !== 'object') continue
      // 슬라이스는 lib presence 키 아래에 있다 (shared 상수).
      const lib = readLibPresence(st as Record<string, unknown>)
      out.push({
        id: String(app.id ?? cid),
        name: String(app.name ?? st.userName ?? `user-${cid}`),
        color: String(app.color ?? '#6366f1'),
        mode: app.mode === 'view' ? 'view' : 'edit',
        slide: lib?.slide !== undefined ? lib.slide + 1 : undefined,
        owner: room.ownerIds.has(cid),
      })
    }
  } catch { /* 무시 */ }
  return out
}

/** edit 모드 참가자가 한 명이라도 있는가. 모르면 edit 취급 (하위 호환). */
export function roomHasEditors(room: CollabRoom): boolean {
  if (room.conns.size === 0) return false
  for (const ws of room.conns.keys()) {
    if (connMode(room, ws) !== 'view') return true
  }
  return false
}

export interface LockInfo {
  active: boolean
  /** conns는 0이지만 최근 편집 흔적이 있어 재연결 대기 중 (F). */
  reconnecting?: boolean
  roomId?: string
  owner?: number[]
  epoch?: string
  lastHash?: string
  seeded?: boolean
  externalChanged?: boolean
  participants?: CollabParticipant[]
  /** 마지막 AI 차단(409) 시각(ms). 칩 표시용으로 그대로 노출한다. */
  aiBlockedAt?: number | null
}

/**
 * AI 편집 차단 + 외부변경 배너 + knownHash 갱신용 조회. 조용히 inactive를 돌려준다.
 * V5: edit 참가자가 있을 때만 active. poll마다 파일을 hash하지 않는다.
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
  if (!room || room.conns.size === 0) {
    // F: conns가 0이어도 everConnected + TTL 안이면 재연결 대기로 알린다.
    // AI는 이 동안 편집하지 않는다 (409 유지).
    if (room && room.everConnected && room.emptySince !== null && Date.now() - room.emptySince < roomTtlMs) {
      return {
        active: true,
        reconnecting: true,
        roomId: id,
        epoch: room.epoch,
        lastHash: room.lastHash,
        participants: [],
        aiBlockedAt: room.aiBlockedAt,
      }
    }
    return { active: false }
  }
  // view-only room도 참가자바용으로 participants는 돌려준다 (active는 edit 있을 때만).
  if (!roomHasEditors(room)) {
    return { active: false, roomId: id, participants: roomParticipants(room), aiBlockedAt: room.aiBlockedAt }
  }
  return {
    active: true,
    roomId: id,
    owner: [...room.ownerIds],
    epoch: room.epoch,
    lastHash: room.lastHash,
    seeded: room.seeded,
    externalChanged: room.externalChanged,
    participants: roomParticipants(room),
    aiBlockedAt: room.aiBlockedAt,
  }
}

/** 활성 room 목록 (탐색기 아바타용, 10초 poll). */
export interface RoomSummary {
  roomId: string
  path: string
  /** workspace 상대경로 (탐색기 file.path 매칭용). */
  rel: string
  epoch: string
  participants: CollabParticipant[]
}

export function listRooms(): RoomSummary[] {
  const out: RoomSummary[] = []
  const root = workspaceRootAbs()
  for (const room of rooms.values()) {
    if (room.conns.size === 0) continue
    out.push({
      roomId: room.id,
      path: room.path,
      rel: path.relative(root, room.path).replace(/\\/g, '/'),
      epoch: room.epoch,
      participants: roomParticipants(room),
    })
  }
  return out
}

/** 테스트용 리셋. */
export function resetCollabForTests(): void {
  for (const room of [...rooms.values()]) disposeRoom(room)
  rooms.clear()
  pathIndex.clear()
  roomTtlMs = 30_000
}
