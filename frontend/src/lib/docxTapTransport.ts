/**
 * C6: DOCX lib 세션용 tap transport.
 *
 * xlsx의 createObjectTapTransport와 같은 구조다. lib이 소유한 WS에
 * 서버 메시지를 가로채서 앱 핸들러로 돌리고, 나머지는 그대로 넘긴다.
 * - 103 flush 요청 → officeSaveRequest 즉시 저장 → officeSaveDone 를 104 {ok,requestId} ack.
 * - 100/101 리셋은 lib이 모르므로 tap이 소비한다.
 */
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { createWebSocketTransport, roomUrl, transportProvider } from 'ooxml-core/collab'
import type { Transport, TransportHandlers } from 'ooxml-core/collab'

/** U-parent: 부모 flush 요청 (서버→owner) + 확인 (클라→서버). xlsx와 같은 값. */
export const DOCX_MSG_FLUSH_REQUEST = 103
export const DOCX_MSG_FLUSHED = 104
/** 서버 room meta(type 100): lib은 모르므로 tap이 소비하고 앱이 처리한다. */
export const DOCX_MSG_META = 100
/** 서버 방 리셋 통지(type 101): lib은 모르므로 tap이 소비하고 앱이 처리한다. */
export const DOCX_MSG_ROOM_RESET = 101
/** C6N: 미뤄진 파트 변경 알림 (서버→방 전원). lib는 type 100을 모르므로 별도 타입. */
export const DOCX_MSG_PART_PENDING = 105
/** C7: 백그라운드 삽입 알림 (서버→방 전원). 리로드 없이 오버레이에 칩을 얹는다. */
export const DOCX_MSG_PART_EMBEDDED = 106

/** C7: 백그라운드 삽입 알림 페이로드 (106 embed-added). */
export interface DocxEmbedAddedMsg {
  roomId: string
  part: string
  name: string
  kind: 'pptx' | 'xlsx' | 'docx'
  pos: {
    slide?: number
    x?: number
    y?: number
    sheet?: number
    col?: number
    row?: number
    block?: number
    /** C7: docx 문단 텍스트 앞부분 (칩 위치 찾기용 힌트). */
    text?: string
  }
  newHash: string
}

export interface DocxTapCallbacks {
  onMeta?: (roomId: string) => void
  onReset?: (reason: string) => void
  onConnect?: () => void
  /** C6N: 미뤄진 파트 변경 알림 (배너 표시용). */
  onPartPending?: (hasPending: boolean) => void
  /** C7: 백그라운드 삽입 알림 (칩 표시용). */
  onEmbedAdded?: (msg: DocxEmbedAddedMsg) => void
}

function readPayload(data: Uint8Array): { requestId?: unknown; roomId?: unknown; reason?: unknown } | null {
  try {
    const dd = decoding.createDecoder(data.subarray(1))
    const body = JSON.parse(new TextDecoder().decode(decoding.readVarUint8Array(dd))) as {
      requestId?: unknown
      roomId?: unknown
      reason?: unknown
    }
    return body
  } catch {
    return null
  }
}

/** U-parent: flush 요청 뒤 officeSaveDone 대기 (connect 단위로 1개). */
export function createDocxTapTransport(url: string, cb: DocxTapCallbacks = {}): Transport {
  const inner = createWebSocketTransport({ url })
  let handlers: TransportHandlers | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let flushHandler: ((e: Event) => void) | null = null
  let flushRequestId: string | null = null
  const armFlushAck = (requestId: string | null): void => {
    if (flushHandler) {
      try {
        window.removeEventListener('officeSaveDone', flushHandler)
      } catch {
        /* 무시 */
      }
      flushHandler = null
    }
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    const done = (e: Event): void => {
      if (flushHandler !== done) return
      const d = (e as CustomEvent<{ ok?: boolean; flushRequestId?: unknown }>).detail
      // B1: 이 요청의 응답이 아니면 무시한다 (앞선 저장의 완료).
      if (flushRequestId !== null && d?.flushRequestId !== flushRequestId) return
      const rid = flushRequestId
      flushHandler = null
      flushRequestId = null
      window.removeEventListener('officeSaveDone', done)
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      const ok = d?.ok === true
      try {
        const enc = encoding.createEncoder()
        encoding.writeVarUint(enc, DOCX_MSG_FLUSHED)
        encoding.writeVarUint8Array(enc, new TextEncoder().encode(JSON.stringify(rid ? { ok, requestId: rid } : { ok })))
        inner.send(encoding.toUint8Array(enc))
      } catch {
        // 무시 (서버 타임아웃이 처리한다)
      }
    }
    flushRequestId = requestId
    flushHandler = done
    window.addEventListener('officeSaveDone', done)
    // 서버 예산(8초)보다 길게 잡는다. 늦은 ack는 서버가 무시한다.
    flushTimer = setTimeout(() => {
      window.removeEventListener('officeSaveDone', done)
      if (flushHandler === done) flushHandler = null
      flushRequestId = null
      flushTimer = null
    }, 10000)
  }
  return {
    connect(h) {
      handlers = {
        ...h,
        message: (data: Uint8Array) => {
          const hNow = handlers
          if (!hNow) return
          try {
            if (data.length > 0 && data[0] === DOCX_MSG_FLUSH_REQUEST) {
              // U-parent: 서버가 부모 flush를 요청했다. 편집을 유지한 채 즉시 저장한다.
              // B1: 응답 짝짓기용 id를 함께 받는다 (없으면 구서버).
              const body = readPayload(data)
              const requestId = typeof body?.requestId === 'string' ? body.requestId : null
              // B2: 즉시-ok는 dispatchEvent 안에서 동기로 터질 수 있다 — 리스너를 먼저 등록한다.
              armFlushAck(requestId)
              try {
                window.dispatchEvent(
                  new CustomEvent('officeSaveRequest', {
                    detail: { keepEditing: true, flushRequestId: requestId ?? undefined },
                  }),
                )
              } catch {
                // 무시 (서버 타임아웃이 처리한다)
              }
              return
            }
            if (data.length > 0 && data[0] === DOCX_MSG_META) {
              try {
                const body = readPayload(data)
                if (typeof body?.roomId === 'string') cb.onMeta?.(body.roomId)
              } catch {
                /* 무시 */
              }
              return
            }
            if (data.length > 0 && data[0] === DOCX_MSG_PART_PENDING) {
              try {
                const body = readPayload(data) as { hasPendingPartChange?: unknown } | null
                if (typeof body?.hasPendingPartChange === 'boolean') {
                  cb.onPartPending?.(body.hasPendingPartChange === true)
                }
              } catch {
                /* 무시 */
              }
              return
            }
            if (data.length > 0 && data[0] === DOCX_MSG_PART_EMBEDDED) {
              try {
                const body = readPayload(data) as DocxEmbedAddedMsg | null
                if (body && typeof body.part === 'string' && typeof body.newHash === 'string') {
                  cb.onEmbedAdded?.(body)
                }
              } catch {
                /* 무시 */
              }
              return
            }
            if (data.length > 0 && data[0] === DOCX_MSG_ROOM_RESET) {
              try {
                const body = readPayload(data)
                cb.onReset?.(typeof body?.reason === 'string' ? body.reason : 'reset')
              } catch {
                cb.onReset?.('reset')
              }
              return
            }
          } catch {
            // 파싱 실패는 lib로 넘겨 lib 판정에 맡긴다.
          }
          h.message(data)
        },
        close: (reason?: string) => {
          // handlers를 유지한다: inner 전송이 스스로 재연결해도(lib이 transport.disconnect를
          // 호출하지 않은 경우) 이후 메시지가 계속 lib에 전달되어야 한다. lib 핸들러는
          // destroyed 상태를 스스로 확인하므로 명시적 종료 뒤 오배송 걱정은 없다.
          // (명시적 disconnect()에서는 아래에서 handlers를 비운다.)
          h.close(reason)
        },
        // (재)연결 때마다 놓친 브로드캐스트를 GET으로 따라잡는다.
        open: () => {
          try {
            h.open()
          } finally {
            try {
              cb.onConnect?.()
            } catch {
              /* 무시 */
            }
          }
        },
      }
      inner.connect(handlers)
    },
    send: (data) => inner.send(data),
    disconnect: () => {
      handlers = null
      if (flushHandler) {
        try {
          window.removeEventListener('officeSaveDone', flushHandler)
        } catch {
          /* 무시 */
        }
        flushHandler = null
      }
      flushRequestId = null
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      inner.disconnect()
    },
  }
}

/** docx lib 세션에 넣는 provider 팩토리. transportProvider와 같은 시그니처다. */
export function createDocxTapProvider(serverUrl: string, roomId: string, cb?: DocxTapCallbacks) {
  return transportProvider({
    transport: createDocxTapTransport(roomUrl(serverUrl, roomId), cb ?? {}),
  })
}
