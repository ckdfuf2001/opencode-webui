import { Hono } from 'hono'
import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import JSZip from 'jszip'
import { createNodeWebSocket } from '@hono/node-ws'
import { issueCollabName } from '../db/collab-name-queries'
import {
  acquireObjectLock,
  addConn,
  adoptParentPartAndMaybeReset,
  applySave,
  hasDeferredPartChange,
  checkSave,
  clearEditorDropOnCleanClose,
  clientRoleInRoom,
  createSession,
  currentDiskHash,
  deleteObject,
  doDeferredParentReset,
  getRoomObjects,
  hashBytes,
  hashFile,
  isValidRoomId,
  listRooms,
  lockInfo,
  moveObject,
  registerRoomObjects,
  releaseObjectLock,
  removeConn,
  requestParentFlush,
  resetRoomByServer,
  roomHasEditors,
  roomHasOpenEditor,
  roomIdForAbs,
  rooms,
  runParentChained,
  wsMessage,
  MAX_SAVE_BYTES,
} from '../services/collab-rooms'
import {
  acquireEmbedLock,
  getEmbedLock,
  releaseEmbedLock,
} from '../services/embed-locks'
import {
  assembleDocxEmbed,
  assemblePptxEmbed,
  assembleXlsxEmbed,
  assertAttachBytes,
  attachKindOf,
  listEmbedParts,
  normalizeEmbedPart,
  readEmbedPart,
  replaceEmbedPart,
  sanitizeEmbedName,
  type EmbedAttachKind,
  type ZipLike,
} from '../services/office-embed'
import { getRawFileContent, resolveWorkspaceFile } from '../services/files'
import { writeFileContent } from '../services/file-operations'
import { parseEditPath } from '@opencode-webui/shared/lib/editPath'
import { logger } from '../utils/logger'

const zipLoadJSZip = (b: Uint8Array): Promise<ZipLike> =>
  JSZip.loadAsync(b) as unknown as Promise<ZipLike>

const SessionSchema = z.object({
  path: z.string().min(1),
  resumeEpoch: z.string().min(1).optional(),
  knownHash: z.string().min(1).optional(),
  clientId: z.number().int().optional(),
  /**
   * X1b(P0-2): 서버가 staleness 를 판정한다.
   * XLSX(lib 방)는 "방에 먼저 들어온 문서"가 방의 기준이라, 디스크와 어긋난 방에 붙으면
   * 낡은 내용이 디스크를 덮어쓴다 ⇒ 서버가 미리 판정해 알려준다.
   */
  strict: z.boolean().optional(),
  /** C6c: 하위문서 방 — 부모 경로 안의 임베딩 파트 경로 (zip 정규 경로). */
  part: z.string().min(1).optional(),
})

const SaveSchema = z.object({
  roomId: z.string().min(1),
  clientId: z.number().int(),
  baseHash: z.string().optional(),
  bytesB64: z.string().min(1),
})

const ResetRoomSchema = z.object({
  roomId: z.string().min(1),
  clientId: z.number().int(),
})

// TODO(v0.13): ResetRoomSchema 제거 — reset은 WS(type 101)로만 받는다.

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (typeof data === 'string') return null
  try {
    return new Uint8Array(data as ArrayBuffer)
  } catch {
    return null
  }
}

function errJson(c: { json: (o: unknown, s?: number) => Response }, error: unknown, fallback: number): Response {
  if (error instanceof z.ZodError) {
    return c.json({ error: 'Invalid request', details: error.issues }, 400)
  }
  const e = error as { message?: string; statusCode?: number; code?: string; currentHash?: string | null }
  const body: Record<string, unknown> = { error: e?.message || 'Request failed' }
  if (e?.code) body.code = e.code
  if (e?.currentHash !== undefined) body.currentHash = e.currentHash
  return c.json(body, e?.statusCode || fallback)
}

const app = new Hono()

app.post('/session', async (c) => {
  try {
    const body = SessionSchema.parse(await c.req.json())
    const result = await createSession(body.path, {
      resumeEpoch: body.resumeEpoch,
      knownHash: body.knownHash,
      clientId: body.clientId,
      strict: body.strict,
      part: body.part,
    })
    return c.json(result)
  } catch (error) {
    return errJson(c, error, 500)
  }
})

app.post('/save', async (c) => {
  try {
    let roomId: string
    let clientId: number
    let bytes: Uint8Array
    let baseHash: string | undefined
    const contentType = c.req.header('content-type') ?? ''
    const forceImageLoss = c.req.header('x-collab-allow-image-loss') ?? ''
    // P0-1: flush 응답(103 requestId와 짝이 맞는 저장 하나)만 체인을 건너뛴다.
    const flushRequestId = c.req.header('x-collab-flush-request-id') || undefined
    if (contentType.includes('application/octet-stream')) {
      // M1: 바이너리 저장 (base64 없이 body 그대로). 메타는 헤더로.
      roomId = c.req.header('x-collab-room') ?? ''
      clientId = Number(c.req.header('x-collab-client'))
      if (!roomId || !Number.isInteger(clientId)) {
        return c.json({ error: 'Missing room/client headers' }, 400)
      }
      baseHash = c.req.header('x-collab-base-hash') || undefined
      bytes = new Uint8Array(await c.req.arrayBuffer())
    } else {
      // TODO(v0.13): JSON+base64 경로를 삭제한다.
      const body = SaveSchema.parse(await c.req.json())
      try {
        bytes = Buffer.from(body.bytesB64, 'base64')
      } catch {
        return c.json({ error: 'Invalid bytesB64' }, 400)
      }
      roomId = body.roomId
      clientId = body.clientId
      baseHash = body.baseHash
    }
    // X1b: 방 종류는 **서버가 방에서 안다**(클라이언트를 믿지 않는다).
    // xlsx 방은 lib 가 소유한다 → owner/seeded 검사 없이 낙관적 잠금으로만 판정한다.
    const kind = rooms.get(roomId)?.kind ?? 'other'
    const check = checkSave(roomId, clientId, bytes.length, { kind })
    if (!check.ok) return c.json({ error: check.error, code: check.code }, check.status || 409)
    const applied = await applySave(roomId, bytes, {
      allowImageLoss: forceImageLoss === '1',
      clientId,
      baseHash,
      kind,
      flushRequestId,
    })
    if ('conflict' in applied) {
      // X1b: conflict_room = 다른 참가자가 먼저 저장(재직렬화 후 1회 재시도 가능).
      //          conflict_external = 외부 변경(재시도 금지, 배너·다운로드로 알린다).
      // C6c: dirty_room = 부모 파일에 미저장이 있어 파트 저장을 막았다(부모 먼저 저장).
      // 문구는 기존 PUT 경로의 클라이언트 토스트와 동일하게 둔다 (U-parent 단언).
      // P0-1c(3): retryable이 true면(편집자 있음) 클라이언트가 상한 내 대기 후
      // 1회 재시도하고, false면(닫힌 부모) 즉시 실패한다 (U-close-save).
      // C6c-1: 미뤄진 파트 변경이 있으면 알린다 (배너→다시 불러오기).
      const code = applied.code ?? 'conflict'
      return c.json(
        {
          error:
            code === 'conflict_room'
              ? 'Another participant saved first (re-serialize and retry)'
              : code === 'conflict_external'
                ? 'File changed outside this session (no auto-merge)'
                : code === 'dirty_room'
                  ? '부모 파일을 먼저 저장하세요'
                  : 'File changed on disk since last save (no auto-merge)',
          code,
          currentHash: applied.currentHash,
          retryable: 'retryable' in applied ? (applied.retryable ?? false) : undefined,
          hasPendingPartChange: hasDeferredPartChange(roomId),
        },
        409,
      )
    }
    if ('imageLoss' in applied) {
      return c.json(
        {
          error: 'Image loss detected — save blocked. Download your copy.',
          code: 'image_loss',
          before: applied.before,
          after: applied.after,
        },
        409,
      )
    }
    return c.json({ saved: true, newHash: applied.newHash, hasPendingPartChange: hasDeferredPartChange(roomId) })
  } catch (error) {
    return errJson(c, error, 500)
  }
})

app.post('/handoff', async (c) => {
  // H: 수동 handoff 제거됨 — owner는 awareness 기반 자동 선출만 쓴다.
  // 이 스텁은 owner 상태를 절대 바꾸지 않고 410만 돌려준다.
  // TODO(v0.13): 이 라우트를 삭제한다.
  logger.warn('Collab /handoff called by legacy client; ownership is automatic now')
  return c.json({ error: 'Handoff was removed; ownership is elected automatically', code: 'removed' }, 410)
})

app.get('/lock', async (c) => {
  const path = c.req.query('path') ?? ''
  if (!path) return c.json({ error: 'Missing path' }, 400)
  return c.json(await lockInfo(path))
})

app.get('/rooms', async (c) => {
  return c.json({ rooms: listRooms() })
})

// ---------------------------------------------------------------------------
// C6c-d-3: 미뤄진 리셋의 즉시 수행 ("다시 불러오기" 배너용).
// - 미뤄진 변경이 있을 때만 동작한다 (임의 방 리셋 불가).
// - 호출자는 방의 편집자여야 한다 (viewer 실수 클릭·외부 호출로 타이핑이
//   끊기지 않게; clientId는 presence 기준 — 저장 경로와 같은 신뢰 수준).
// ---------------------------------------------------------------------------
app.post('/:room/reset-pending', async (c) => {
  try {
    const roomId = c.req.param('room')
    const body = (await c.req.json().catch(() => ({}))) as { clientId?: unknown }
    const clientId = typeof body.clientId === 'number' ? body.clientId : undefined
    if (!isValidRoomId(roomId) || !rooms.has(roomId)) {
      return c.json({ error: 'No such room', code: 'no_room' }, 404)
    }
    const room = rooms.get(roomId)!
    if (!room.pendingPartReset) return c.json({ error: 'No deferred reset', code: 'no_pending' }, 404)
    if (clientId === undefined || clientRoleInRoom(roomId, clientId) !== 'edit') {
      return c.json({ error: 'Only an editor can reload now', code: 'forbidden' }, 403)
    }
    doDeferredParentReset(roomId)
    return c.json({ ok: true })
  } catch (error) {
    return errJson(c, error, 500)
  }
})

// C6c-a0: 편집 URL 해석의 단일 진실. 클라이언트·테스트는 URL 문자열을
// 직접 파싱하지 않고 이 결과를 따른다 (D64 스킴, D71 전환 시 여기만 바뀐다).
app.get('/resolve', async (c) => {
  const pathname = c.req.query('path') ?? ''
  if (!pathname.startsWith('/edit/')) return c.json({ error: 'Not an edit URL', code: 'bad_path' }, 400)
  const parsed = parseEditPath(pathname)
  if (!parsed) return c.json({ error: 'Unparseable edit URL', code: 'bad_path' }, 400)
  return c.json(parsed)
})

// ---------------------------------------------------------------------------
// C4: 시트 개체 lock/move/delete (키 발급·순서 대조 포함).
// ---------------------------------------------------------------------------

const ObjectsKeyParam = z.object({ room: z.string().min(1).max(128), key: z.string().min(1).max(64) })

const ObjectsRegisterSchema = z.object({
  hash: z.string().min(1).max(128),
  items: z.array(z.object({ sheet: z.number().int().min(0).max(1024), kind: z.string().min(1).max(80) })).max(500),
})

const ObjectsLockSchema = z.object({ clientId: z.number().int() })

const ObjectsUnlockSchema = z.object({ lockId: z.string().min(1).max(128) })

const ObjectsMoveSchema = z.object({
  clientId: z.number().int(),
  // anchor는 서버가 파싱하지 않는다. unknown(JSON) 그대로 저장·방송한다.
  anchor: z.unknown(),
  baseVersion: z.number().int().min(0),
  lockId: z.string().min(1).max(128).optional(),
})

const ObjectsDeleteSchema = z.object({
  clientId: z.number().int(),
  baseVersion: z.number().int().min(0),
  lockId: z.string().min(1).max(128).optional(),
})

function objErr(c: { json: (o: unknown, s?: number) => Response }, r: { code?: string } & Record<string, unknown>): Response {
  const code = r.code ?? 'error'
  const status = code === 'no_room' || code === 'gone' ? 404 : 409
  return c.json({ error: code, ...r }, status)
}

app.get('/:room/objects', async (c) => {
  const { room } = ObjectsKeyParam.extend({ key: z.string().optional() }).parse({ room: c.req.param('room') })
  if (!isValidRoomId(room) || !rooms.has(room)) return c.json({ error: 'No such room', code: 'no_room' }, 404)
  return c.json(getRoomObjects(room))
})

app.post('/:room/objects/register', async (c) => {
  try {
    const room = c.req.param('room')
    if (!isValidRoomId(room) || !rooms.has(room)) return c.json({ error: 'No such room', code: 'no_room' }, 404)
    const body = ObjectsRegisterSchema.parse(await c.req.json())
    const r = registerRoomObjects(room, body.hash, body.items)
    if (!r.ok) return objErr(c, r)
    return c.json(r)
  } catch (error) {
    return errJson(c, error, 500)
  }
})

app.post('/:room/objects/:key/lock', async (c) => {
  try {
    const { room, key } = ObjectsKeyParam.parse({ room: c.req.param('room'), key: c.req.param('key') })
    if (!isValidRoomId(room)) return c.json({ error: 'No such room', code: 'no_room' }, 404)
    const body = ObjectsLockSchema.parse(await c.req.json())
    const r = acquireObjectLock(room, key, body.clientId)
    if (!r.ok) return objErr(c, r)
    return c.json(r)
  } catch (error) {
    return errJson(c, error, 500)
  }
})

app.delete('/:room/objects/:key/lock', async (c) => {
  try {
    const { room, key } = ObjectsKeyParam.parse({ room: c.req.param('room'), key: c.req.param('key') })
    if (!isValidRoomId(room)) return c.json({ error: 'No such room', code: 'no_room' }, 404)
    const body = ObjectsUnlockSchema.parse(await c.req.json())
    const r = releaseObjectLock(room, key, body.lockId)
    if (!r.ok) return objErr(c, r)
    return c.json(r)
  } catch (error) {
    return errJson(c, error, 500)
  }
})

app.post('/:room/objects/:key/move', async (c) => {
  try {
    const { room, key } = ObjectsKeyParam.parse({ room: c.req.param('room'), key: c.req.param('key') })
    if (!isValidRoomId(room)) return c.json({ error: 'No such room', code: 'no_room' }, 404)
    const body = ObjectsMoveSchema.parse(await c.req.json())
    const r = moveObject(room, key, body.clientId, body.anchor, body.baseVersion, body.lockId)
    if (!r.ok) return objErr(c, r)
    return c.json(r)
  } catch (error) {
    return errJson(c, error, 500)
  }
})

app.post('/:room/objects/:key/delete', async (c) => {
  try {
    const { room, key } = ObjectsKeyParam.parse({ room: c.req.param('room'), key: c.req.param('key') })
    if (!isValidRoomId(room)) return c.json({ error: 'No such room', code: 'no_room' }, 404)
    const body = ObjectsDeleteSchema.parse(await c.req.json())
    const r = deleteObject(room, key, body.clientId, body.baseVersion, body.lockId)
    if (!r.ok) return objErr(c, r)
    return c.json(r)
  } catch (error) {
    return errJson(c, error, 500)
  }
})

app.post('/suggest-name', async (c) => {
  try {
    return c.json({ name: issueCollabName(collabDb) })
  } catch (error) {
    return errJson(c, error, 500)
  }
})

const EmbedSchema = z.object({
  path: z.string().min(1).max(512),
  slide: z.coerce.number().int().min(1).max(999).optional(),
  sheet: z.coerce.number().int().min(0).max(1024).optional(),
  roomId: z.string().min(1).max(128).optional(),
  clientId: z.coerce.number().int().optional(),
  baseHash: z.string().min(1).max(128).optional(),
})

/**
 * C5-2: INSERT 문서 첨부 (multipart: path + file + slide? + roomId? + clientId? + baseHash?).
 * - 첨부는 docx/xlsx/pptx + 매직바이트 + 20MB (office-embed).
 * - viewer는 403 (방이 있고 clientId의 role이 viewer면).
 * - dirty면 409 dirty_room: 방 기준(disk != lastHash) 또는 baseHash stale.
 *   클라이언트는 owner 저장 후 1회 재시도한다.
 * - 조립 후 디스크에 쓰고 방이 있으면 resetRoomByServer → 4001 재입장.
 *   방이 없어도(solo 미참가) 디스크 조립은 수행한다 (호출자가 reload).
 */
app.post('/embed', async (c) => {
  try {
    const body = await c.req.parseBody()
    const q = EmbedSchema.parse({
      path: typeof body.path === 'string' ? body.path : '',
      slide: body.slide !== undefined ? Number(body.slide) : undefined,
      sheet: body.sheet !== undefined ? Number(body.sheet) : undefined,
      roomId: typeof body.roomId === 'string' ? body.roomId : undefined,
      clientId: body.clientId !== undefined ? Number(body.clientId) : undefined,
      baseHash: typeof body.baseHash === 'string' ? body.baseHash : undefined,
    })
    const file = body.file as unknown as { arrayBuffer?: () => Promise<ArrayBuffer>; name?: unknown } | undefined
    if (!file || typeof file.arrayBuffer !== 'function') {
      return c.json({ error: 'Missing file', code: 'bad_file' }, 400)
    }
    const attachBytes = new Uint8Array(await file.arrayBuffer())
    const attachName = sanitizeEmbedName(typeof file.name === 'string' ? file.name : 'attachment', 'bin')
    const kind = attachKindOf(attachName)
    try {
      assertAttachBytes(attachBytes, kind)
    } catch (e) {
      return errJson(c, e, 500)
    }
    const abs = await resolveWorkspaceFile(q.path).catch(() => null)
    if (!abs) return c.json({ error: 'Host file not found', code: 'no_host' }, 404)
    const hostLower = abs.toLowerCase()
    const hostKind = hostLower.endsWith('.pptx') ? 'pptx' : hostLower.endsWith('.xlsx') ? 'xlsx' : hostLower.endsWith('.docx') ? 'docx' : null
    if (!hostKind) {
      return c.json({ error: 'Only pptx/xlsx/docx hosts supported', code: 'unsupported_host' }, 400)
    }
    const roomId = q.roomId && isValidRoomId(q.roomId) ? q.roomId : roomIdForAbs(abs)
    const room = rooms.get(roomId)
    if (room && q.clientId === undefined) {
      return c.json({ error: 'Missing client', code: 'bad_client' }, 400)
    }
    if (room && q.clientId !== undefined && clientRoleInRoom(roomId, q.clientId) === 'view' && roomHasEditors(room)) {
      return c.json({ error: 'View-only participant cannot attach while editors are present', code: 'view_only' }, 403)
    }
    const disk = room ? await currentDiskHash(roomId) : await hashFile(abs).catch(() => null)
    if (room) {
      if (!q.baseHash || q.baseHash !== room.lastHash || disk !== room.lastHash) {
        return c.json({ error: 'Room changed since loaded — save first, then retry', code: 'dirty_room', currentHash: disk }, 409)
      }
    } else if (q.baseHash && disk !== q.baseHash) {
      return c.json({ error: 'File changed since loaded — reload, then retry', code: 'dirty_room', currentHash: disk }, 409)
    }
    // P0-1: 조립+쓰기를 부모 체인에서 직렬화한다 (PUT /save와 같은 체인).
    return runParentChained(abs, async () => {
    const hostBytes = new Uint8Array(await getRawFileContent(q.path))
    let out: Uint8Array
    let embPart: string
    try {
      if (hostKind === 'pptx') {
        out = await assemblePptxEmbed(zipLoadJSZip, {
          hostBytes,
          attachBytes,
          attachName,
          attachKind: kind,
          slide: q.slide,
        })
        embPart = `ppt/embeddings/${attachName}`
      } else if (hostKind === 'xlsx') {
        out = await assembleXlsxEmbed(zipLoadJSZip, {
          hostBytes,
          attachBytes,
          attachName,
          attachKind: kind,
          sheet: q.sheet,
        })
        embPart = `xl/embeddings/${attachName}`
      } else {
        out = await assembleDocxEmbed(zipLoadJSZip, {
          hostBytes,
          attachBytes,
          attachName,
          attachKind: kind,
        })
        embPart = `word/embeddings/${attachName}`
      }
    } catch (e) {
      return errJson(c, e, 500)
    }
    await writeFileContent(abs, Buffer.from(out))
    const newHash = hashBytes(out)
    logger.warn(`[embed] room=${roomId.slice(0, 8)} bytes=${out.length} newHash=${newHash.slice(0, 8)}`)
    if (room) {
      room.lastHash = newHash
      room.externalChanged = false
      resetRoomByServer(roomId)
    }
    return c.json({ ok: true, newHash, embeddings: [embPart] })
    })
  } catch (error) {
    return errJson(c, error, 500)
  }
})

// ---------------------------------------------------------------------------
// C5-3: 첨부 읽기/교체/잠금 (GET/PUT /api/collab/embed, /embed/lock).
// - GET: 파트 바이트 + 파일 해시(baseHash용) 반환. 읽기 전용 열람에도 쓴다.
// - PUT: 해당 파트만 원자 교체. dirty_room(디스크 선행 변경)/stale(baseHash 불일치)
//   구분, viewer 403, 잠금 확인, 조립 후 방 리셋(4001)은 POST embed과 동일.
// - lock: path+part 임대 (TTL 60s, renew로 연장, 만료 시 자동 해제).
// ---------------------------------------------------------------------------

const EmbedPartQuery = z.object({
  path: z.string().min(1).max(512),
  part: z.string().min(1).max(512),
  roomId: z.string().min(1).max(128).optional(),
  clientId: z.coerce.number().int().optional(),
})

const EmbedPutSchema = z.object({
  baseHash: z.string().min(1).max(128).optional(),
  lockId: z.string().min(1).max(128),
  roomId: z.string().min(1).max(128).optional(),
  clientId: z.coerce.number().int().optional(),
  // U-stale: 파트 단위 낙관적 잠금. 연 시점 파트 해시와 다르면 409 stale_part.
  partHash: z.string().min(1).max(128).optional(),
})

const EmbedLockSchema = z.object({
  path: z.string().min(1).max(512),
  part: z.string().min(1).max(512),
  name: z.string().max(100).optional(),
  token: z.string().min(1).max(128),
  lockId: z.string().min(1).max(128).optional(),
})

const EmbedUnlockSchema = z.object({
  path: z.string().min(1).max(512),
  part: z.string().min(1).max(512),
  lockId: z.string().min(1).max(128),
  token: z.string().min(1).max(128).optional(),
})

/** POST /embed과 같은 viewer 판정 (room+viewer+편집자 존재 → 403). */
function embedViewerForbidden(roomId: string, clientId: number | undefined): boolean {
  if (clientId === undefined) return false
  const room = rooms.get(roomId)
  if (!room) return false
  return clientRoleInRoom(roomId, clientId) === 'view' && roomHasEditors(room)
}

app.get('/embed', async (c) => {
  try {
    const q = EmbedPartQuery.parse({
      path: c.req.query('path'),
      part: c.req.query('part'),
      roomId: c.req.query('roomId') ?? undefined,
      clientId: c.req.query('clientId') ?? undefined,
    })
    const abs = await resolveWorkspaceFile(q.path).catch(() => null)
    if (!abs) return c.json({ error: 'Host file not found', code: 'no_host' }, 404)
    const roomId = q.roomId && isValidRoomId(q.roomId) ? q.roomId : roomIdForAbs(abs)
    const room = rooms.get(roomId)
    if (room && embedViewerForbidden(roomId, q.clientId)) {
      return c.json({ error: 'View-only participant cannot read attachments while editors are present', code: 'view_only' }, 403)
    }
    const norm = normalizeEmbedPart(q.part)
    const hostBytes = new Uint8Array(await getRawFileContent(q.path))
    const { bytes, name } = await readEmbedPart(zipLoadJSZip, hostBytes, norm)
    const hash = hashBytes(hostBytes)
    // P0-4: 파트 바이트 자체의 해시(ETag). 클라이언트는 subtle 없이도
    // 이 값을 knownHash로 써서 strict 검증 + 저장 partHash 검증에 쓴다.
    const partHash = hashBytes(bytes)
    return c.json({
      ok: true,
      name,
      hash,
      partHash,
      size: bytes.length,
      data: Buffer.from(bytes).toString('base64'),
    })
  } catch (error) {
    return errJson(c, error, 500)
  }
})

app.put('/embed', async (c) => {
  try {
    const q = EmbedPartQuery.parse({
      path: c.req.query('path'),
      part: c.req.query('part'),
      roomId: c.req.query('roomId') ?? undefined,
      clientId: c.req.query('clientId') ?? undefined,
    })
    const body = await c.req.parseBody()
    const q2 = EmbedPutSchema.parse({
      baseHash: typeof body.baseHash === 'string' ? body.baseHash : undefined,
      lockId: typeof body.lockId === 'string' ? body.lockId : undefined,
      roomId: typeof body.roomId === 'string' ? body.roomId : undefined,
      clientId: body.clientId !== undefined ? Number(body.clientId) : undefined,
      partHash: typeof body.partHash === 'string' ? body.partHash : undefined,
    })
    const roomId = q.roomId ?? q2.roomId
    const clientId = q.clientId ?? q2.clientId
    const norm = normalizeEmbedPart(q.part)
    const abs = await resolveWorkspaceFile(q.path).catch(() => null)
    if (!abs) return c.json({ error: 'Host file not found', code: 'no_host' }, 404)
    const file = body.file as unknown as { arrayBuffer?: () => Promise<ArrayBuffer>; name?: unknown } | undefined
    if (!file || typeof file.arrayBuffer !== 'function') {
      return c.json({ error: 'Missing file', code: 'bad_file' }, 400)
    }
    const attachBytes = new Uint8Array(await file.arrayBuffer())
    const partBase = norm.split('/').pop() ?? 'attachment.bin'
    const kind = attachKindOf(partBase) ?? attachKindOf(typeof file.name === 'string' ? file.name : '')
    try {
      assertAttachBytes(attachBytes, kind)
    } catch (e) {
      return errJson(c, e, 500)
    }
    // 잠금 확인 (임대자만 교체).
    const lock = getEmbedLock(abs, norm)
    if (!lock || lock.lockId !== q2.lockId) {
      if (lock && lock.expiresAt > Date.now()) {
        return c.json({ error: 'Attachment is being edited', code: 'locked', holderName: lock.holder }, 409)
      }
      return c.json({ error: 'Attachment lock required', code: 'no_lock' }, 409)
    }
    const rid = roomId && isValidRoomId(roomId) ? roomId : roomIdForAbs(abs)
    const room = rooms.get(rid)
    // C5-4: standalone 편집 탭(유효 잠금 보유)은 방 identity가 없다.
    // 위에서 lockId 일치로 편집권을 이미 확인했으므로 clientId 부재를 막지 않는다
    // (lockId는 서버 발급 랜덤 비밀값이라 탈취 없이 보유 자체가 소유 증명).
    // 방 참가자 신원이 있을 때만 viewer 여부를 판정한다.
    if (room && embedViewerForbidden(rid, clientId)) {
      return c.json({ error: 'View-only participant cannot edit attachments while editors are present', code: 'view_only' }, 403)
    }
    // P0-1c: flush 판정은 체인을 잡기 전에 끝낸다. 체인 안에서 flush(최대 8초)를
    // 기다리면 부모 수동·자동 저장이 뒤에 줄서서 flush가 굶어 죽는 순환대기가
    // 된다 (U-flush-race). 판정만 먼저 하고 읽기-검사-쓰기는 체인 안에서 한다.
    // flush 뒤에 도착한 부모 저장은 아래 base/disk 대조에서 409가 난다.
    let preFlushHash: string | null = null
    if (room) {
      // U-parent: 부모 방에 저장할 수 있는 편집자가 있으면 flush를 강제한다 (D64).
      // flush가 부모 미저장을 디스크에 쓴 뒤에야 파트를 교체한다 (둘 다 생존).
      preFlushHash = room.lastHash
      if (roomHasOpenEditor(rid)) {
        const flush = await requestParentFlush(rid)
        if (!flush.ok) {
          const cur = await currentDiskHash(rid)
          return c.json({ error: 'Parent has unsaved changes — save the parent file first, then retry', code: 'dirty_room', currentHash: cur, retryable: true }, 409)
        }
      } else if (room.docDirty || room.lastEditorDropAt > 0) {
        // B3: 편집 conn이 없고 (a) 방이 dirty면 미저장이 stranded될 수 있으므로 막는다.
        // (b) 비정상 종료 기록이 있으면 보수적으로 막는다. clean close(1000/1001)는
        // onClose에서 기록을 지우므로 여기로 오지 않는다.
        // retryable: false — 편집자가 없어 부모가 스스로 수렴하지 않는다 (U-close-save).
        const cur = await currentDiskHash(rid)
        const why = room.docDirty
          ? 'Parent has unsaved changes — save the parent file first, then retry'
          : 'Parent tab is unreachable — open the parent file, save it, then retry'
        return c.json({ error: why, code: 'dirty_room', currentHash: cur, retryable: false }, 409)
      }
    }
    // P0-1: 읽기-검사-쓰기를 부모 체인에서 직렬화한다 (PUT /save와 같은 체인).
    // flush 응답은 이 경로로 오지 않으므로 교착 없이 대기한다.
    return runParentChained(abs, async () => {
    const hostBytes = new Uint8Array(await getRawFileContent(q.path))
    const disk = room ? await currentDiskHash(rid) : await hashFile(abs).catch(() => null)
    // U-stale: 파트 단위 낙관적 잠금. 연 시점 파트와 다르면 덮어쓰지 않는다.
    // 방 해시와 무관하게 파트 자체를 비교한다 (방이 모르는 외부 변경도 잡힌다).
    if (q2.partHash) {
      try {
        const cur = await readEmbedPart(zipLoadJSZip, hostBytes, norm)
        if (hashBytes(cur.bytes) !== q2.partHash) {
          return c.json({ error: 'Part changed since loaded — reload the attachment and retry', code: 'stale_part', currentHash: disk }, 409)
        }
      } catch {
        // 파트 읽기 실패는 아래 replaceEmbedPart에서 404 등으로 판정한다.
      }
    }
    if (room) {
      // 수렴성: flush 저장 자체가 lastHash를 움직이므로, 재시도 base가 flush 전 해시와
      // 같아도 받아들인다 (그 사이 부모 저장은 flush 저장에 포함되어 보존된다).
      if (!q2.baseHash || (q2.baseHash !== room.lastHash && q2.baseHash !== preFlushHash)) {
        return c.json({ error: 'Stale base — reload the attachment and retry', code: 'stale', currentHash: disk }, 409)
      }
      if (disk !== room.lastHash) {
        return c.json({ error: 'Room changed since loaded — save first, then retry', code: 'dirty_room', currentHash: disk }, 409)
      }
    } else if (q2.baseHash && disk !== q2.baseHash) {
      return c.json({ error: 'File changed since loaded — reload, then retry', code: 'dirty_room', currentHash: disk }, 409)
    }
    const out = await replaceEmbedPart(zipLoadJSZip, hostBytes, norm, attachBytes)
    await writeFileContent(abs, Buffer.from(out))
    const newHash = hashBytes(out)
    logger.warn(`[embed-put] room=${rid.slice(0, 8)} part=${norm} bytes=${out.length} newHash=${newHash.slice(0, 8)}`)
    if (room) {
      // C6c-d-1: 부모 zip은 즉시 반영하고, 방 리셋은 부모가 조용할 때까지 미룬다.
      adoptParentPartAndMaybeReset(rid, newHash, norm)
    }
    return c.json({ ok: true, newHash, hasPendingPartChange: !!rooms.get(rid)?.pendingPartReset })
    })
  } catch (error) {
    return errJson(c, error, 500)
  }
})

app.post('/embed/lock', async (c) => {
  try {
    const q = EmbedLockSchema.parse(await c.req.json())
    const abs = await resolveWorkspaceFile(q.path).catch(() => null)
    if (!abs) return c.json({ error: 'Host file not found', code: 'no_host' }, 404)
    const norm = normalizeEmbedPart(q.part)
    // 잠그는 파트가 실제로 있어야 한다 (경로 조작·오타 방지).
    const hostBytes = new Uint8Array(await getRawFileContent(q.path).catch(() => new Uint8Array()))
    if (hostBytes.length > 0) {
      let found = false
      try {
        const parts = await listEmbedParts(zipLoadJSZip, hostBytes)
        found = parts.some((p) => p.part === norm)
      } catch {
        found = false
      }
      if (!found) return c.json({ error: 'No such embedded part', code: 'bad_part' }, 404)
    }
    const r = acquireEmbedLock(abs, norm, q.name ?? 'user', q.token, q.lockId ? { lockId: q.lockId } : undefined)
    if (!r.ok) return c.json({ error: 'Attachment is being edited', code: 'locked', holderName: r.holderName, expiresAt: r.expiresAt }, 409)
    return c.json({ ok: true, lockId: r.lockId, expiresAt: r.expiresAt, renewed: r.renewed })
  } catch (error) {
    return errJson(c, error, 500)
  }
})

app.delete('/embed/lock', async (c) => {
  try {
    const q = EmbedUnlockSchema.parse(await c.req.json())
    const abs = await resolveWorkspaceFile(q.path).catch(() => null)
    if (!abs) return c.json({ error: 'Host file not found', code: 'no_host' }, 404)
    const norm = normalizeEmbedPart(q.part)
    const r = releaseEmbedLock(abs, norm, q.lockId, q.token)
    if (!r.ok) {
      if (r.code === 'no_lock') return c.json({ error: 'No such lock', code: 'no_lock' }, 404)
      return c.json({ error: 'Not the lock holder', code: 'not_holder' }, 403)
    }
    return c.json({ ok: true })
  } catch (error) {
    return errJson(c, error, 500)
  }
})

/** suggest-name용 db 핸들 (없으면 메모리 폴백). */
let collabDb: Database | null = null

export function createCollabRoutes(database?: Database | null): Hono {
  if (database) collabDb = database
  return app
}

/**
 * y-websocket 호환 릴레이 (Phase 0).
 * upgrade 라우팅이 루트 앱을 타야 해서 여기서 직접 등록한다.
 * serverUrl 뒤에 roomId를 붙이면 되므로 클라이언트는
 * `ws(s)://<origin>/api/collab` 을 넘기면 된다.
 * injectWebSocket(server)는 index.ts의 startServer에서 호출한다.
 */
export function registerCollabSockets(rootApp: Hono): { injectWebSocket: (server: unknown) => void } {
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: rootApp as never })
  rootApp.get('/api/collab/:room', upgradeWebSocket((c) => {
    const roomId = c.req.param('room') ?? ''
    return {
      onOpen(_evt, ws) {
        if (!isValidRoomId(roomId) || !rooms.has(roomId)) {
          try {
            ;(ws as unknown as { close: (code?: number, reason?: string) => void }).close(1008, 'No such room')
          } catch { /* 무시 */ }
          return
        }
        addConn(roomId, ws)
      },
      onMessage(evt, ws) {
        const data = toBytes((evt as { data?: unknown })?.data)
        if (!data || !rooms.has(roomId)) return
        wsMessage(roomId, ws, data)
      },
      onClose(evt, ws) {
        if (rooms.has(roomId)) {
          // U-parent: clean close(1000)면 편집 탭이 정상 종료된 것이다.
          // "떨어진 편집 탭" 기록을 지워 PUT이 진행되게 한다 (1006·무프레임은 남긴다).
          try {
            const code = (evt as unknown as { code?: unknown })?.code
            if (code === 1000 || code === 1001) clearEditorDropOnCleanClose(roomId)
          } catch {
            /* 무시 */
          }
          removeConn(roomId, ws)
        }
      },
      onError(err) {
        logger.warn('Collab socket error:', err)
      },
    }
  }))
  return { injectWebSocket: injectWebSocket as (server: unknown) => void }
}

export { MAX_SAVE_BYTES }
