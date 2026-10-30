import { Hono } from 'hono'
import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { createNodeWebSocket } from '@hono/node-ws'
import { issueCollabName } from '../db/collab-name-queries'
import {
  acquireObjectLock,
  addConn,
  applySave,
  checkSave,
  createSession,
  deleteObject,
  getRoomObjects,
  isValidRoomId,
  listRooms,
  lockInfo,
  moveObject,
  registerRoomObjects,
  releaseObjectLock,
  removeConn,
  rooms,
  wsMessage,
  MAX_SAVE_BYTES,
} from '../services/collab-rooms'
import { logger } from '../utils/logger'

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
    })
    if ('conflict' in applied) {
      // X1b: conflict_room = 다른 참가자가 먼저 저장(재직렬화 후 1회 재시도 가능).
      //          conflict_external = 외부 변경(재시도 금지, 배너·다운로드로 알린다).
      const code = applied.code ?? 'conflict'
      return c.json(
        {
          error:
            code === 'conflict_room'
              ? 'Another participant saved first (re-serialize and retry)'
              : code === 'conflict_external'
                ? 'File changed outside this session (no auto-merge)'
                : 'File changed on disk since last save (no auto-merge)',
          code,
          currentHash: applied.currentHash,
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
    return c.json({ saved: true, newHash: applied.newHash })
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
      onClose(_evt, ws) {
        if (rooms.has(roomId)) removeConn(roomId, ws)
      },
      onError(err) {
        logger.warn('Collab socket error:', err)
      },
    }
  }))
  return { injectWebSocket: injectWebSocket as (server: unknown) => void }
}

export { MAX_SAVE_BYTES }
