import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

export type YCollabStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface YCollabUser {
  name: string
  color: string
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return null
}

/**
 * 백엔드 릴레이(/api/collab/:room, y-websocket 호환)에 붙는 외부 세션.
 * Y.Doc·awareness를 호스트가 소유하고, viewer에는 빌려준다
 * (externalSession — viewer는 detach만 하고 destroy하지 않는다).
 */
export class YCollabSession {
  readonly doc = new Y.Doc()
  readonly awareness = new awarenessProtocol.Awareness(this.doc)
  status: YCollabStatus = 'connecting'
  synced = false

  private ws: WebSocket | null = null
  private listeners = new Set<() => void>()
  private disposed = false

  constructor(
    readonly url: string,
    private user: YCollabUser,
  ) {
    this.awareness.setLocalState({ userName: user.name, userColor: user.color })
  }

  get clientId(): number {
    return this.doc.clientID
  }

  connect(): void {
    if (this.ws || this.disposed) return
    const ws = new WebSocket(this.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    this.doc.on('update', this.onDocUpdate)
    this.awareness.on('update', this.onAwarenessUpdate)

    ws.onopen = () => {
      // 서버가 syncStep1을 먼저 보낸다. awareness 초기 상태는 여기서
      // 발행해야 서버가 clientID를 owner 집합에 넣는다 (생성자 시점은
      // 리스너가 없어 유실된다).
      const e = encoding.createEncoder()
      encoding.writeVarUint(e, 1)
      encoding.writeVarUint8Array(
        e,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]),
      )
      this.send(encoding.toUint8Array(e))
    }
    ws.onmessage = (evt) => {
      const data = toBytes((evt as MessageEvent).data)
      if (!data) return
      const d = decoding.createDecoder(data)
      const type = decoding.readVarUint(d)
      if (type === 0) {
        const e = encoding.createEncoder()
        encoding.writeVarUint(e, 0)
        syncProtocol.readSyncMessage(d, e, this.doc, null)
        if (encoding.length(e) > 1) this.send(encoding.toUint8Array(e))
        if (!this.synced) {
          this.synced = true
          this.setStatus('connected')
        }
      } else if (type === 1) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(d), null)
      }
    }
    ws.onclose = () => {
      this.ws = null
      if (!this.disposed) this.setStatus('disconnected')
    }
    ws.onerror = () => {
      if (!this.disposed && this.status === 'connecting') this.setStatus('error')
    }
  }

  private onDocUpdate = (update: Uint8Array): void => {
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, 0)
    syncProtocol.writeUpdate(e, update)
    this.send(encoding.toUint8Array(e))
  }

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
  ): void => {
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, 1)
    encoding.writeVarUint8Array(
      e,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]),
    )
    this.send(encoding.toUint8Array(e))
  }

  private send(data: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(data)
      } catch {
        // 다음 기회에 재전송된다 (Yjs는 상태를 다시 요청한다)
      }
    }
  }

  private setStatus(s: YCollabStatus): void {
    if (this.status === s) return
    this.status = s
    this.listeners.forEach((l) => {
      try {
        l()
      } catch {
        // 무시
      }
    })
  }

  getSnapshot(): { status: YCollabStatus; synced: boolean } {
    return { status: this.status, synced: this.synced }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setUser(user: YCollabUser): void {
    this.user = user
    this.awareness.setLocalState({ userName: user.name, userColor: user.color })
  }

  /** viewer에 빌려줄 externalSession 객체. */
  toExternal(): {
    doc: Y.Doc
    awareness: awarenessProtocol.Awareness
    getSnapshot: () => { status: YCollabStatus; synced: boolean }
    subscribe: (listener: () => void) => () => void
  } {
    return {
      doc: this.doc,
      awareness: this.awareness,
      getSnapshot: () => this.getSnapshot(),
      subscribe: (l: () => void) => this.subscribe(l),
    }
  }

  destroy(): void {
    this.disposed = true
    try {
      this.doc.off('update', this.onDocUpdate)
    } catch {
      // 무시
    }
    try {
      this.awareness.off('update', this.onAwarenessUpdate)
    } catch {
      // 무시
    }
    try {
      this.ws?.close()
    } catch {
      // 무시
    }
    this.ws = null
    try {
      this.doc.destroy()
    } catch {
      // 무시
    }
    this.listeners.clear()
  }
}

const PALETTE = ['#e11d48', '#2563eb', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#65a30d']

export function colorForName(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]!
}
