/**
 * C4: 시트 개체(이미지·도형·차트·EMB) 클라이언트 측.
 *
 * - 키 발급·순서 대조·락·이동·삭제는 서버가 한다 (`api/collab.ts` collabObjectsApi).
 * - 이 파일은 순수 판정 + WS 탭 수신 + session.applyExternal 적용만 둔다.
 *   lib 패치는 없다: transportProvider에 감시용 transport를 끼워 넣는다.
 *   lib는 모르는 메시지 타입(102)을 무시하므로, 탭이 가로채지 않으면
 *   lib 쪽 핸들러까지 도달하지 않는다.
 */
import * as decoding from 'lib0/decoding'
import { createWebSocketTransport, roomUrl, transportProvider } from 'ooxml-core/collab'
import type { Transport, TransportHandlers } from 'ooxml-core/collab'

/** C4: 서버 개체 브로드캐스트 WS 메시지 타입 (99 keepalive·100 meta·101 reset 다음). */
export const MSG_ROOM_OBJECTS = 102

export interface ObjectAnchor {
  from?: { row?: number; col?: number; rowOffset?: number; colOffset?: number }
  to?: { row?: number; col?: number; rowOffset?: number; colOffset?: number }
  [k: string]: unknown
}

export interface ObjectSnapshot {
  key: string
  sheet: number
  kind: string
  anchor: ObjectAnchor | null
  deleted: boolean
  version: number
  lock: { clientId: number; lockId: string; expiresAt: number } | null
}

export interface ObjectsStateMsg {
  version: number
  order: Record<string, string[]> | null
  objects: ObjectSnapshot[]
}

/** 서버에 보내는 시트별 개체 목록 항목. */
export interface RegisterItem {
  sheet: number
  kind: string
}

export interface DrawingLike {
  kind?: unknown
  description?: unknown
  anchor?: unknown
  sourceXml?: unknown
}

/** drawings 모델 한 항목이 서버에 보고하는 kind. */
export function describeDrawingKind(d: DrawingLike | null | undefined): string {
  if (!d || typeof d.kind !== 'string') return 'unknown'
  if (d.kind === 'unsupported') return `unsupported:${typeof d.description === 'string' && d.description ? d.description : 'object'}`
  return d.kind
}

/** snapshot 비교용 anchor 정규화. */
export function anchorKey(a: unknown): string {
  return JSON.stringify(a ?? null)
}

/**
 * 서버 순서를 로컬 drawings에 붙인다. 시트+종류별 개수로 대조하고,
 * 종류 안에서는 서버 순서를 따른다. 어긋나면 null (fail-closed).
 */
export function assignObjectKeys(
  order: Record<string, string[]>,
  byKey: ReadonlyMap<string, { sheet: number; kind: string; deleted: boolean }>,
  local: ReadonlyArray<{ sheet: number; kind: string }>,
): Map<number, string> | null {
  const live: Array<{ sheet: string; kind: string; key: string }> = []
  for (const sk of Object.keys(order)) {
    for (const k of order[sk] ?? []) {
      const e = byKey.get(k)
      if (!e || e.deleted) continue
      live.push({ sheet: sk, kind: e.kind, key: k })
    }
  }
  const locals = local.map((it, i) => ({ ...it, i }))
  const leftovers = [...locals]
  const assignment = new Map<number, string>()
  for (const s of live) {
    const at = leftovers.findIndex((l) => String(l.sheet) === s.sheet && l.kind === s.kind)
    if (at < 0) return null
    assignment.set(leftovers[at].i, s.key)
    leftovers.splice(at, 1)
  }
  if (leftovers.length > 0) return null
  return assignment
}

/** 로컬 변경분을 찾는다. seen을 주면 찾은 키를 기록하고 삭제 판정은 호출자가 한다. */
export function diffObjects(
  drawings: ReadonlyArray<DrawingLike | null | undefined>,
  lastSent: ReadonlyMap<string, { anchor: string; deleted: boolean }>,
  keyOf: (index: number) => string | null,
  seen?: Set<string>,
): Array<{ key: string; type: 'move' | 'delete'; anchor?: unknown }> {
  const out: Array<{ key: string; type: 'move' | 'delete'; anchor?: unknown }> = []
  const found = seen ?? new Set<string>()
  for (let i = 0; i < drawings.length; i++) {
    const key = keyOf(i)
    if (!key) continue
    found.add(key)
    const prev = lastSent.get(key)
    const anchor = anchorKey(drawings[i]?.anchor)
    if (!prev || prev.deleted || prev.anchor !== anchor) out.push({ key, type: 'move', anchor: drawings[i]?.anchor })
  }
  if (seen) return out
  for (const [key, prev] of lastSent) {
    if (!prev.deleted && !found.has(key)) out.push({ key, type: 'delete' })
  }
  return out
}

/**
 * 서버 WS 메시지를 가로채는 transport. type 102(개체)는 onObjects로 보내고
 * lib에는 전달하지 않는다. 나머지는 그대로 넘긴다.
 * onConnect는 (재)연결 때마다 불린다 — 그 사이 놓친 브로드캐스트를
 * GET으로 따라잡기 위한 동기화 지점이다 (Yjs sync-step1과 같은 역할).
 */
export function createObjectTapTransport(
  url: string,
  onObjects: (msg: ObjectsStateMsg) => void,
  onConnect?: () => void,
): Transport {
  const inner = createWebSocketTransport({ url })
  let handlers: TransportHandlers | null = null
  return {
    connect(h) {
      handlers = {
        ...h,
        message: (data: Uint8Array) => {
          const hNow = handlers
          if (!hNow) return
          try {
            if (data.length > 0 && data[0] === MSG_ROOM_OBJECTS) {
              const d = decoding.createDecoder(data.subarray(1))
              const raw = decoding.readVarUint8Array(d)
              onObjects(JSON.parse(new TextDecoder().decode(raw)) as ObjectsStateMsg)
              return
            }
          } catch {
            // 파싱 실패는 lib로 넘겨 lib 판정에 맡긴다.
          }
          h.message(data)
        },
        close: (reason?: string) => {
          handlers = null
          h.close(reason)
        },
        // (재)연결 때마다 놓친 브로드캐스트를 GET으로 따라잡는다.
        open: () => {
          try {
            h.open()
          } finally {
            try {
              onConnect?.()
            } catch {
              /* 무시 */
            }
          }
        },
      }
      inner.connect(handlers)
    },
    send: (data: Uint8Array) => inner.send(data),
    disconnect: () => {
      handlers = null
      inner.disconnect()
    },
  }
}

/** XlsxCollaborationOptions.provider 에 넣는 팩토리. transportProvider와 같은 시그니처다. */
export function createObjectTapProvider(
  serverUrl: string,
  roomId: string,
  onObjects: (msg: ObjectsStateMsg) => void,
  onConnect?: () => void,
) {
  return transportProvider({
    transport: createObjectTapTransport(roomUrl(serverUrl, roomId), onObjects, onConnect),
  })
}
