import { Hono } from 'hono'
import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { createNodeWebSocket } from '@hono/node-ws'
import { issueCollabName } from '../db/collab-name-queries'
import {
  addConn,
  applySave,
  checkSave,
  createSession,
  isValidRoomId,
  listRooms,
  lockInfo,
  removeConn,
  rooms,
  wsMessage,
  resetRoomFromDisk,
  MAX_SAVE_BYTES,
} from '../services/collab-rooms'
import { logger } from '../utils/logger'

const SessionSchema = z.object({
  path: z.string().min(1),
  resumeEpoch: z.string().min(1).optional(),
  knownHash: z.string().min(1).optional(),
  clientId: z.number().int().optional(),
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
    const contentType = c.req.header('content-type') ?? ''
    const forceImageLoss = c.req.header('x-collab-allow-image-loss') ?? ''
    if (contentType.includes('application/octet-stream')) {
      // M1: 바이너리 저장 (base64 없이 body 그대로). 메타는 헤더로.
      roomId = c.req.header('x-collab-room') ?? ''
      clientId = Number(c.req.header('x-collab-client'))
      if (!roomId || !Number.isInteger(clientId)) {
        return c.json({ error: 'Missing room/client headers' }, 400)
      }
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
    }
    const check = checkSave(roomId, clientId, bytes.length)
    if (!check.ok) return c.json({ error: check.error, code: check.code }, check.status || 409)
    const applied = await applySave(roomId, bytes, { allowImageLoss: forceImageLoss === '1' })
    if ('conflict' in applied) {
      return c.json(
        {
          error: 'File changed on disk since last save (no auto-merge)',
          code: 'conflict',
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

/** 4-2: 오염된 room을 디스크 원본 기준으로 재설정 (owner 전용). */
app.post('/reset-room', async (c) => {
  try {
    const body = ResetRoomSchema.parse(await c.req.json())
    const result = await resetRoomFromDisk(body.roomId, body.clientId)
    return c.json(result)
  } catch (error) {
    return errJson(c, error, 500)
  }
})

app.get('/rooms', async (c) => {
  return c.json({ rooms: listRooms() })
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
